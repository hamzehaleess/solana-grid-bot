/**
 * Grid-trading bot for a single Solana token, run against real Jupiter
 * prices. Paper mode (the default) never touches a wallet — every simulated
 * fill is priced from a real quote, same posture as the original scalper's
 * `npm run paper`. Live mode (`GRID_LIVE=true`, a flag deliberately separate
 * from any other project's `LIVE`) places real resting orders via Jupiter's
 * Trigger API — funds move into a Jupiter-managed vault the moment an order
 * is placed, not only once it fills.
 *
 * Reconstructed after the original project directory was accidentally
 * deleted on 2026-09-15. This file specifically was never fully read during
 * that session (only grepped for a handful of lines), so treat it as a
 * faithful reimplementation to the same spec, not a byte-exact recovery —
 * unlike engine.ts, liveBroker.ts, broker.ts and jupiterTrigger.ts, which
 * were read in full and restored verbatim (liveBroker.ts also carries two
 * real fixes found the day before deletion: an explicit slippageBps on
 * every placed order, and an orderStatus=open filter on checkFill's history
 * lookup — see those files' own comments).
 */
import { createInterface } from 'node:readline/promises';
import {
  config, SOL_MINT, GRID_LIVE_MAX_BUDGET_USD, GRID_LIVE_MAX_RESTING_ORDERS, GRID_LIVE_MAX_DRAWDOWN_USD,
} from '../config.ts';
import { GridEngine, type GridEngineConfig } from '../grid/engine.ts';
import { GridJournal } from '../journal/gridJournal.ts';
import { validateLevelSize } from '../grid/math.ts';
import { JupiterClient } from '../feeds/jupiter.ts';
import { JupiterTriggerClient } from '../feeds/jupiterTrigger.ts';
import { loadWallet } from '../execution/wallet.ts';
import { PaperGridBroker } from '../grid/paperSim.ts';
import { LiveGridBroker } from '../grid/liveBroker.ts';
import type { GridBroker } from '../grid/broker.ts';
import { log } from '../util/log.ts';
import { sleep } from '../util/ratelimit.ts';

const fail = (message: string): never => {
  console.error(`\n${message}\n`);
  process.exit(1);
};

const confirmLiveTrading = async (): Promise<void> => {
  if (!process.stdin.isTTY) {
    fail('GRID_LIVE=true requires an interactive terminal to confirm. Refusing to run unattended.');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('\n  Type exactly "I ACCEPT REAL FUND RISK" to continue: ');
  rl.close();
  if (answer.trim() !== 'I ACCEPT REAL FUND RISK') {
    fail('Confirmation phrase did not match. Refusing to start live grid trading.');
  }
  console.log('  Confirmed. Starting live grid trading.\n');
};

const main = async (): Promise<void> => {
  const symbol = config.gridAssetSymbol;
  const mint = config.gridAssetMint;
  const decimals = config.gridAssetDecimals;

  validateLevelSize(config.gridLevelSizeUsd);

  if (config.gridLive) {
    if (config.gridBudgetUsd > GRID_LIVE_MAX_BUDGET_USD) {
      fail(
        `GRID_BUDGET_USD=${config.gridBudgetUsd} exceeds the hard live ceiling of ` +
          `$${GRID_LIVE_MAX_BUDGET_USD} set in src/config.ts. That ceiling is not read ` +
          'from .env on purpose — raise it there directly if this is deliberate.',
      );
    }
    if (config.gridLevels > GRID_LIVE_MAX_RESTING_ORDERS) {
      fail(
        `GRID_LEVELS=${config.gridLevels} exceeds the hard live ceiling of ` +
          `${GRID_LIVE_MAX_RESTING_ORDERS} resting orders set in src/config.ts.`,
      );
    }
  }

  console.log(`\n  Grid: ${symbol}  range $${config.gridLowPriceUsd}-$${config.gridHighPriceUsd}  ` +
    `${config.gridLevels} levels  $${config.gridLevelSizeUsd}/level  $${config.gridBudgetUsd} budget`);

  const jup = new JupiterClient();
  let broker: GridBroker;

  if (config.gridLive) {
    console.log('  LIVE GRID TRADING — REAL ORDERS, REAL FUNDS, MAINNET');
    console.log(`  budget      $${config.gridBudgetUsd} (ceiling $${GRID_LIVE_MAX_BUDGET_USD})`);
    console.log(`  resting     ${config.gridLevels} orders (ceiling ${GRID_LIVE_MAX_RESTING_ORDERS})`);
    console.log(`  drawdown    $${GRID_LIVE_MAX_DRAWDOWN_USD} halt (permanent)`);
    await confirmLiveTrading();

    const wallet = loadWallet();
    const trigger = new JupiterTriggerClient();
    await trigger.authenticate(wallet);
    await trigger.getOrRegisterVault(wallet.publicKey.toBase58());
    broker = new LiveGridBroker(trigger, wallet);
  } else {
    console.log('\n  Grid trading — PAPER mode (no funds at risk)\n');
    broker = new PaperGridBroker(jup);
  }

  const journal = new GridJournal(config.dataDir, config.gridEventFile, config.gridFillFile);
  journal.event('grid_start', {
    mode: config.gridLive ? 'live' : 'paper',
    asset: symbol, low: config.gridLowPriceUsd, high: config.gridHighPriceUsd,
    levels: config.gridLevels, levelSizeUsd: config.gridLevelSizeUsd, budgetUsd: config.gridBudgetUsd,
  });

  const engineCfg: GridEngineConfig = {
    mint, symbol, decimals,
    lowPriceUsd: config.gridLowPriceUsd, highPriceUsd: config.gridHighPriceUsd,
    levels: config.gridLevels, levelSizeUsd: config.gridLevelSizeUsd, budgetUsd: config.gridBudgetUsd,
    dataDir: config.dataDir,
    mode: config.gridLive ? 'live' : 'paper',
  };
  // Mandatory and unconditional for live — does not depend on any .env
  // toggle, same as the scalper's live risk-halt enforcement.
  if (config.gridLive) engineCfg.liveMaxDrawdownUsd = GRID_LIVE_MAX_DRAWDOWN_USD;

  const engine = new GridEngine(broker, journal, engineCfg);

  let running = true;
  let alertedDrawdown = false;
  let alertedError = false;
  const shutdown = (signal: string): void => {
    log.info(`${signal} received, finishing current tick then stopping`, { symbol });
    running = false;
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  while (running) {
    try {
      const prices = await jup.prices(mint === SOL_MINT ? [mint] : [mint, SOL_MINT]);
      const currentPriceUsd = prices[mint]?.usdPrice;
      const solPriceUsd = mint === SOL_MINT ? currentPriceUsd : prices[SOL_MINT]?.usdPrice;
      if (currentPriceUsd === undefined || solPriceUsd === undefined) {
        log.warn('no price returned this tick, skipping', { symbol });
      } else {
        await engine.tick(currentPriceUsd, solPriceUsd);

        if (engine.haltedForDrawdown && engineCfg.mode === 'live' && !alertedDrawdown) {
          alertedDrawdown = true;
          log.error('grid remains halted for drawdown — existing resting sells still close out, no new buys', { symbol });
        }
        if (engine.haltedForError && engineCfg.mode === 'live' && !alertedError) {
          alertedError = true;
          log.error('grid remains halted for repeated order-placement errors — a human must investigate', { symbol });
        }
      }
    } catch (err) {
      log.error('grid tick failed, will retry next poll', { symbol, err: String(err) });
    }
    await sleep(config.gridPricePollSec * 1000);
  }

  log.info('grid stopped gracefully', { symbol });
};

void main().catch((err) => {
  log.error('fatal', { err: String(err) });
  process.exit(1);
});
