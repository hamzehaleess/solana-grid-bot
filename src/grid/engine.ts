import { randomUUID } from 'node:crypto';
import { generateLevels, levelStep, isOutOfRange, nextRebalanceLevel, computeOpenInventory } from './math.ts';
import { saveLadder, loadLadder } from '../journal/gridStore.ts';
import type { GridJournal } from '../journal/gridJournal.ts';
import type { GridBroker } from './broker.ts';
import type { GridLadder } from './types.ts';
import { round } from '../execution/costModel.ts';
import { log } from '../util/log.ts';

/**
 * After this many consecutive order-placement failures, the ladder halts
 * permanently rather than retrying forever. Exists specifically because of
 * the 2026-09-01/02 incident: a placement bug caused the live process to
 * retry a failing order every poll interval, unattended, all night (1200+
 * attempts) with nothing ever escalating or stopping it. 3 is deliberately
 * low — a real, persistent problem (insufficient funds, a broken order
 * param, an expired auth token) does not need more than a couple of tries
 * to prove itself, and the cost of halting too eagerly (a human has to
 * restart) is far cheaper than the cost of not halting at all.
 */
const MAX_CONSECUTIVE_PLACE_FAILURES = 3;

export interface GridEngineConfig {
  mint: string;
  symbol: string;
  decimals: number;
  lowPriceUsd: number;
  highPriceUsd: number;
  levels: number;
  levelSizeUsd: number;
  budgetUsd: number;
  dataDir: string;
  mode: 'paper' | 'live';
  /**
   * Hard stop on unrealized mark-to-market loss across open inventory —
   * mandatory and unconditional for live mode (like the scalper's
   * risk-halt enforcement), unset for paper (no real risk to cap). Once
   * tripped, stays tripped: existing resting sells are left in place so
   * held inventory can still close out, but no new buy exposure is added
   * until a human restarts — same "the most severe halt does not
   * auto-clear" rule as RiskController's total_drawdown halt.
   */
  liveMaxDrawdownUsd?: number;
}

/**
 * Owns one `GridLadder` — the state machine deciding which levels should
 * have resting orders right now, applying the out-of-range pause policy,
 * and persisting after every mutation, the same call-on-every-change
 * pattern `Book#persist()` uses. Depends only on `GridBroker`, so it works
 * unchanged against either `PaperGridBroker` or `LiveGridBroker` — the
 * same separation `Harness` keeps from `Executor`.
 */
export class GridEngine {
  readonly #broker: GridBroker;
  readonly #journal: GridJournal;
  readonly #cfg: GridEngineConfig;
  readonly #step: number;
  #ladder: GridLadder;
  #haltedForDrawdown = false;
  #haltedForError = false;
  #consecutivePlaceFailures = 0;

  constructor(broker: GridBroker, journal: GridJournal, cfg: GridEngineConfig) {
    this.#broker = broker;
    this.#journal = journal;
    this.#cfg = cfg;
    this.#step = levelStep(cfg.lowPriceUsd, cfg.highPriceUsd, cfg.levels);

    const resumed = loadLadder(cfg.dataDir);
    if (resumed && resumed.mint === cfg.mint) {
      this.#ladder = resumed;
      log.warn('resumed grid ladder from a previous run', {
        symbol: cfg.symbol, orders: resumed.orders.length, status: resumed.status,
      });
    } else {
      if (resumed) {
        log.warn('a saved ladder exists for a different asset, starting fresh', {
          savedMint: resumed.mint, configuredMint: cfg.mint,
        });
      }
      this.#ladder = {
        gridId: randomUUID(),
        mint: cfg.mint,
        symbol: cfg.symbol,
        decimals: cfg.decimals,
        lowPriceUsd: cfg.lowPriceUsd,
        highPriceUsd: cfg.highPriceUsd,
        levels: generateLevels(cfg.lowPriceUsd, cfg.highPriceUsd, cfg.levels),
        orders: [],
        createdAt: Date.now(),
        status: 'active',
        budgetUsd: cfg.budgetUsd,
      };
    }
  }

  get ladder(): GridLadder {
    return this.#ladder;
  }

  get haltedForDrawdown(): boolean {
    return this.#haltedForDrawdown;
  }

  get haltedForError(): boolean {
    return this.#haltedForError;
  }

  /** Records a placement failure and halts the ladder once it's happened
   * too many times in a row. Called from both #ensureInitialOrders (a
   * failed buy) and #checkFills (a failed paired sell) — the latter is if
   * anything more urgent, since it leaves real filled inventory with no
   * protective sell resting. */
  #recordPlaceFailure(context: string, err: unknown): void {
    this.#consecutivePlaceFailures++;
    log.error('grid order placement failed', {
      symbol: this.#ladder.symbol, context, err: String(err),
      consecutiveFailures: this.#consecutivePlaceFailures,
    });
    this.#journal.event('order_place_failed', {
      context, err: String(err), consecutiveFailures: this.#consecutivePlaceFailures,
    });
    if (this.#consecutivePlaceFailures >= MAX_CONSECUTIVE_PLACE_FAILURES) {
      this.#haltedForError = true;
      log.error('grid halted: too many consecutive order placement failures — a human must investigate before restarting', {
        symbol: this.#ladder.symbol, consecutiveFailures: this.#consecutivePlaceFailures,
      });
      this.#journal.event('halted_error', { consecutiveFailures: this.#consecutivePlaceFailures });
    }
    this.#persist();
  }

  #persist(): void {
    saveLadder(this.#ladder, this.#cfg.dataDir);
  }

  /** A level is occupied while it has a resting order (a pending buy, or a
   * sell resting because inventory is held). Free once a full buy->sell
   * round trip completes — nothing at that level stays `resting`. */
  #occupiedLevels(): Set<number> {
    return new Set(this.#ladder.orders.filter((o) => o.status === 'resting').map((o) => o.levelIndex));
  }

  /**
   * Checks unrealized mark-to-market loss on open inventory against
   * `liveMaxDrawdownUsd`, if configured. Trips once, stays tripped — no
   * new buy exposure after this, but existing resting sells are left
   * alone so held inventory can still close out normally.
   */
  #checkDrawdownHalt(currentPriceUsd: number): void {
    if (this.#haltedForDrawdown || this.#cfg.liveMaxDrawdownUsd === undefined) return;
    const { costBasisUsd, markValueUsd } = computeOpenInventory(this.#ladder.orders, this.#cfg.decimals, currentPriceUsd);
    const unrealizedPnlUsd = markValueUsd - costBasisUsd;
    if (unrealizedPnlUsd <= -this.#cfg.liveMaxDrawdownUsd) {
      this.#haltedForDrawdown = true;
      this.#journal.event('halted_drawdown', {
        unrealizedPnlUsd: round(unrealizedPnlUsd, 4), limitUsd: this.#cfg.liveMaxDrawdownUsd,
        costBasisUsd: round(costBasisUsd, 4), markValueUsd: round(markValueUsd, 4),
      });
      log.error('grid halted: unrealized drawdown on open inventory exceeded the live limit', {
        symbol: this.#ladder.symbol, unrealizedPnlUsd: round(unrealizedPnlUsd, 2),
        limitUsd: this.#cfg.liveMaxDrawdownUsd,
      });
    }
  }

  /** Places a buy at every configured level currently below price that has
   * no live order — idempotent, safe to call every tick. Self-funding:
   * sell-side levels never get seeded speculatively, only once a paired
   * buy has actually filled (see #handleFill). Does nothing once halted
   * for drawdown — existing resting sells still close out normally, this
   * just stops adding new buy exposure. */
  async #ensureInitialOrders(currentPriceUsd: number): Promise<void> {
    if (this.#haltedForDrawdown || this.#haltedForError) return;
    const occupied = this.#occupiedLevels();
    for (const level of this.#ladder.levels) {
      if (level.priceUsd >= currentPriceUsd) continue;
      if (occupied.has(level.index)) continue;
      let order;
      try {
        order = await this.#broker.place({
          mint: this.#ladder.mint, symbol: this.#ladder.symbol, decimals: this.#cfg.decimals,
          side: 'buy', priceUsd: level.priceUsd, sizeUsd: this.#cfg.levelSizeUsd, levelIndex: level.index,
        });
      } catch (err) {
        this.#recordPlaceFailure(`buy at level ${level.index}`, err);
        return; // stop this tick's placements; a human-visible halt matters more than trying the next level
      }
      this.#consecutivePlaceFailures = 0;
      this.#ladder.orders.push(order);
      this.#journal.event('order_placed', {
        side: 'buy', levelIndex: level.index, priceUsd: round(level.priceUsd, 6), sizeUsd: this.#cfg.levelSizeUsd,
      });
      log.info('grid buy placed', { symbol: this.#ladder.symbol, level: level.index, priceUsd: round(level.priceUsd, 6) });
      this.#persist();
    }
  }

  #updateRangeStatus(currentPriceUsd: number): boolean {
    const outOfRange = isOutOfRange(currentPriceUsd, this.#ladder.lowPriceUsd, this.#ladder.highPriceUsd);
    if (outOfRange && this.#ladder.status === 'active') {
      this.#ladder.status = 'paused_out_of_range';
      this.#journal.event('paused_out_of_range', {
        priceUsd: round(currentPriceUsd, 6), low: this.#ladder.lowPriceUsd, high: this.#ladder.highPriceUsd,
      });
      log.warn('price left the configured range — pausing new orders, not chasing it', {
        symbol: this.#ladder.symbol, priceUsd: round(currentPriceUsd, 6),
      });
      this.#persist();
    } else if (!outOfRange && this.#ladder.status === 'paused_out_of_range') {
      this.#ladder.status = 'active';
      this.#journal.event('resumed_in_range', { priceUsd: round(currentPriceUsd, 6) });
      log.info('price back in range, resuming', { symbol: this.#ladder.symbol });
      this.#persist();
    }
    return outOfRange;
  }

  async #checkFills(currentPriceUsd: number, solPriceUsd: number): Promise<void> {
    for (const order of this.#ladder.orders) {
      if (order.status !== 'resting') continue;
      const result = await this.#broker.checkFill(order, this.#cfg.decimals, currentPriceUsd, solPriceUsd);
      if (!result.filled) continue;

      order.status = 'filled';
      order.filledAt = Date.now();
      order.fillPriceUsd = result.fillPriceUsd;
      if (result.tokensRaw !== undefined) order.sizeTokensRaw = result.tokensRaw;

      let realizedPnlUsd: number | undefined;
      if (order.side === 'sell' && order.linkedOrderId) {
        const buy = this.#ladder.orders.find((o) => o.id === order.linkedOrderId);
        if (buy?.fillPriceUsd !== undefined) {
          const soldUsd = order.fillPriceUsd! * (Number(order.sizeTokensRaw ?? 0n) / 10 ** this.#cfg.decimals);
          realizedPnlUsd = round(soldUsd - buy.sizeUsd - (result.feesUsd ?? 0), 4);
        }
      }

      this.#journal.fill({
        ts: new Date().toISOString(), gridId: this.#ladder.gridId, orderId: order.id,
        levelIndex: order.levelIndex, side: order.side, mint: order.mint, symbol: order.symbol,
        fillPriceUsd: round(order.fillPriceUsd!, 8), sizeUsd: order.sizeUsd, feesUsd: round(result.feesUsd ?? 0, 4),
        ...(realizedPnlUsd !== undefined ? { realizedPnlUsd } : {}),
        mode: this.#cfg.mode,
      });
      log.info('grid order filled', {
        symbol: this.#ladder.symbol, side: order.side, level: order.levelIndex,
        fillPriceUsd: round(order.fillPriceUsd!, 6), realizedPnlUsd,
      });

      if (order.side === 'buy' && order.sizeTokensRaw !== undefined) {
        const sellPriceUsd = nextRebalanceLevel(order.fillPriceUsd!, this.#step);
        try {
          const sellOrder = await this.#broker.place({
            mint: this.#ladder.mint, symbol: this.#ladder.symbol, decimals: this.#cfg.decimals,
            side: 'sell', priceUsd: sellPriceUsd, sizeUsd: order.sizeUsd, levelIndex: order.levelIndex,
            linkedOrderId: order.id, sizeTokensRaw: order.sizeTokensRaw,
          });
          this.#consecutivePlaceFailures = 0;
          this.#ladder.orders.push(sellOrder);
          this.#journal.event('order_placed', {
            side: 'sell', levelIndex: order.levelIndex, priceUsd: round(sellPriceUsd, 6), linkedOrderId: order.id,
          });
          log.info('grid sell placed', {
            symbol: this.#ladder.symbol, level: order.levelIndex, priceUsd: round(sellPriceUsd, 6),
          });
        } catch (err) {
          // Leaves this fill's inventory with no resting sell — worse than
          // a failed buy, since real tokens are now unprotected. Halts
          // fast on this path specifically (see MAX_CONSECUTIVE_PLACE_FAILURES).
          this.#recordPlaceFailure(`paired sell for filled buy at level ${order.levelIndex}`, err);
        }
      }
      this.#persist();
    }
  }

  /** Advance the grid by one tick: update range status, check every
   * resting order for a fill, then top up any freed buy levels. Never
   * runs concurrently with itself — same discipline as `Book#tick`. */
  #busy = false;
  async tick(currentPriceUsd: number, solPriceUsd: number): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      const outOfRange = this.#updateRangeStatus(currentPriceUsd);
      await this.#checkFills(currentPriceUsd, solPriceUsd);
      this.#checkDrawdownHalt(currentPriceUsd);
      if (!outOfRange) await this.#ensureInitialOrders(currentPriceUsd);
    } finally {
      this.#busy = false;
    }
  }
}
