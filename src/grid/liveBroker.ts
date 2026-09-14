import { VersionedTransaction, type Keypair } from '@solana/web3.js';
import { config, USDC_MINT, USDC_DECIMALS } from '../config.ts';
import { toRaw } from '../execution/costModel.ts';
import type { GridBroker, FillCheckResult, PlaceOrderParams } from './broker.ts';
import type { GridOrder } from './types.ts';
import { JupiterTriggerClient } from '../feeds/jupiterTrigger.ts';
import { log } from '../util/log.ts';

const ORDER_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — grid orders can rest a long time

/**
 * Places real resting orders via Jupiter's Trigger API.
 *
 * Materially different trust model from the scalper's `LiveExecutor`:
 * funds sit in a Jupiter-managed vault while an order is open, not in the
 * wallet's own ATA — every `place()` call deposits real funds into that
 * vault. There is no dry-run inside this class; the only safety gate is
 * upstream, in `cli/grid.ts`'s typed confirmation, before this broker is
 * ever constructed.
 */
export class LiveGridBroker implements GridBroker {
  readonly #trigger: JupiterTriggerClient;
  readonly #wallet: Keypair;

  constructor(trigger: JupiterTriggerClient, wallet: Keypair) {
    this.#trigger = trigger;
    this.#wallet = wallet;
  }

  async place(params: PlaceOrderParams): Promise<GridOrder> {
    const isBuy = params.side === 'buy';
    const inputMint = isBuy ? USDC_MINT : params.mint;
    const outputMint = isBuy ? params.mint : USDC_MINT;
    const amountRaw = isBuy ? toRaw(params.sizeUsd, USDC_DECIMALS) : params.sizeTokensRaw;
    if (amountRaw === undefined) {
      throw new Error(`live sell order at level ${params.levelIndex} has no sizeTokensRaw to deposit`);
    }

    const userAddress = this.#wallet.publicKey.toBase58();
    const craft = await this.#trigger.craftDeposit({
      inputMint, outputMint, userAddress, amount: amountRaw.toString(),
    });
    // deposit/craft returns an error body (e.g. "No vault registered for
    // this user") rather than throwing on failure — same non-throwing
    // POST-error contract as the rest of this client. Check explicitly
    // rather than let a missing `transaction` surface as an opaque
    // Buffer.from(undefined) crash, which is what happened before this
    // check existed.
    if (!craft.transaction) {
      throw new Error(`deposit/craft did not return a transaction to sign: ${JSON.stringify(craft)}`);
    }

    const tx = VersionedTransaction.deserialize(Buffer.from(craft.transaction, 'base64'));
    tx.sign([this.#wallet]);
    const depositSignedTx = Buffer.from(tx.serialize()).toString('base64');

    const created = await this.#trigger.createOrder({
      orderType: 'single',
      depositRequestId: craft.requestId,
      depositSignedTx,
      userPubkey: userAddress,
      inputMint,
      inputAmount: amountRaw.toString(),
      outputMint,
      triggerMint: params.mint,
      expiresAt: Date.now() + ORDER_LIFETIME_MS,
      triggerCondition: isBuy ? 'below' : 'above',
      triggerPriceUsd: params.priceUsd,
      // Previously omitted, leaving Jupiter's own default in effect — see
      // config.ts's gridSlippageBps doc comment for the real incident this
      // caused (a correctly-triggered order failing 10 straight fill
      // attempts and getting stuck open at 0% filled).
      slippageBps: config.gridSlippageBps,
    });

    if (!created.id) {
      throw new Error(`live grid order placement did not return an id: ${JSON.stringify(created)}`);
    }

    log.info('live grid order placed', {
      side: params.side, symbol: params.symbol, level: params.levelIndex,
      priceUsd: params.priceUsd, orderId: created.id,
    });

    return {
      id: created.id,
      levelIndex: params.levelIndex,
      side: params.side,
      mint: params.mint,
      symbol: params.symbol,
      priceUsd: params.priceUsd,
      sizeUsd: params.sizeUsd,
      status: 'resting',
      placedAt: Date.now(),
      ...(params.linkedOrderId ? { linkedOrderId: params.linkedOrderId } : {}),
      ...(params.sizeTokensRaw !== undefined ? { sizeTokensRaw: params.sizeTokensRaw } : {}),
      jupiterOrderId: created.id,
      depositRequestId: craft.requestId,
    };
  }

  async cancel(order: GridOrder): Promise<void> {
    if (!order.jupiterOrderId) {
      log.warn('cancel called on a grid order with no jupiterOrderId, nothing to do', { orderId: order.id });
      return;
    }
    try {
      await this.#trigger.cancelOrder(order.jupiterOrderId);
    } catch (err) {
      // Never assume the order is actually gone from an ambiguous error —
      // same rule as LiveExecutor.sell.
      log.error('live grid cancel failed — order may still be resting, not assuming it is gone', {
        orderId: order.id, err: String(err),
      });
      throw err;
    }
  }

  /**
   * Reads real order state from Jupiter rather than re-deriving a fill
   * from a quote (paper mode's approach) — a live order either has filled
   * on-chain or it hasn't, so there is real ground truth to read.
   *
   * `orderState: 'filled'` is confirmed against real docs (the earlier
   * `'status'` field name was wrong — see jupiterTrigger.ts). What's still
   * NOT verified against a real filled order (only an 'open' one has been
   * observed so far, plus many 'failed'/deposit_failed ones from the live
   * incident on 2026-09-01/02 — see git history): the exact field carrying
   * realized fill price/fees/output-amount. This reads conservatively and
   * falls back to the nominal trigger price rather than guessing a field
   * name that turns out to be wrong.
   *
   * For a BUY, `tokensRaw` is deliberately NOT read off the match object —
   * `order.sizeTokensRaw` is never set on a buy before it fills (only sells
   * carry it, from placement), and returning it here unconditionally
   * always produced `undefined`. That was the actual root cause of the
   * 2026-09-01/02 incident: with `tokensRaw` always undefined, the engine
   * never placed the paired sell for a filled live buy, so the level
   * looked free again next tick and got re-bought — three real buys at the
   * same level before the budget ran out, then ~1200+ silent retries
   * overnight (see the placement-failure halt in engine.ts, which exists
   * specifically so that can't happen unnoticed again). Instead, tokensRaw
   * is derived from what we actually know for certain: the USD size
   * committed and the realized fill price. This is an estimate (real
   * fees/slippage can shave a few basis points off actual tokens received)
   * but it is a real number instead of a silent undefined, and it's what
   * sizes the paired sell that actually protects the position.
   */
  async checkFill(order: GridOrder, decimals: number): Promise<FillCheckResult> {
    if (!order.jupiterOrderId) return { filled: false };
    // `orderStatus: 'open'` is real, confirmed against a live response
    // (`orderState: "open"`) — not guessed. Without it this called plain
    // page-1 history, which only ever returns the most recent ~20 records;
    // real incident found live on 2026-09-14: with this account's order
    // history swollen by the 2026-09-01/02 retry storm, an order placed
    // on 2026-09-01 had already fallen off page 1 by 2026-09-14 and could
    // never be confirmed filled by this code again, live or not. Filtering
    // to only-open server-side keeps the working set to whatever's actually
    // still resting (bounded by GRID_LIVE_MAX_RESTING_ORDERS), not the
    // account's entire lifetime order count.
    const history = await this.#trigger.getOrderHistory(this.#wallet.publicKey.toBase58(), 1, 'open');
    const match = history.orders.find((o) => o.id === order.jupiterOrderId);
    if (!match || match.orderState !== 'filled') return { filled: false };

    const fillPriceUsd = typeof match['fillPriceUsd'] === 'number' ? match['fillPriceUsd'] : order.priceUsd;
    const feesUsd = typeof match['feesUsd'] === 'number' ? match['feesUsd'] : 0;
    const tokensRaw = order.side === 'buy'
      ? toRaw(order.sizeUsd / fillPriceUsd, decimals)
      : order.sizeTokensRaw;
    return { filled: true, fillPriceUsd, tokensRaw, feesUsd };
  }
}
