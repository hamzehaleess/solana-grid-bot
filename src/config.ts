const num = (k: string, d: number): number => {
  const raw = process.env[k];
  if (raw === undefined || raw === '') return d;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${k} must be a number, got "${raw}"`);
  return n;
};

const str = (k: string, d: string): string => process.env[k] ?? d;

const bool = (k: string, d: boolean): boolean => {
  const raw = process.env[k];
  if (raw === undefined || raw === '') return d;
  return raw.toLowerCase() === 'true' || raw === '1';
};

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const SOL_DECIMALS = 9;
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDC_DECIMALS = 6;

export const config = {
  jupApiKey: str('JUP_API_KEY', ''),
  rpcUrl: str('RPC_URL', 'https://api.mainnet-beta.solana.com'),
  /** Read directly from process.env, never via str(), so an accidental
   * config dump/log of this object can never include it. */
  walletPrivateKey: process.env['WALLET_PRIVATE_KEY'] ?? '',

  gridAssetMint: str('GRID_ASSET_MINT', SOL_MINT),
  gridAssetSymbol: str('GRID_ASSET_SYMBOL', 'SOL'),
  gridAssetDecimals: num('GRID_ASSET_DECIMALS', SOL_DECIMALS),
  /** No safe default for either — they depend on a view of the asset's
   * near-term range that only the operator can supply. */
  gridLowPriceUsd: num('GRID_LOW_PRICE_USD', 0),
  gridHighPriceUsd: num('GRID_HIGH_PRICE_USD', 0),
  gridLevels: num('GRID_LEVELS', 8), // total buy+sell rungs
  /** Must clear Jupiter's real $10/order minimum — enforced in src/grid/math.ts. */
  gridLevelSizeUsd: num('GRID_LEVEL_SIZE_USD', 15),
  gridBudgetUsd: num('GRID_BUDGET_USD', 150),
  /** 'pause' (log and hold, no auto-widening) is the only policy v1 implements. */
  gridOutOfRangePolicy: str('GRID_OUT_OF_RANGE_POLICY', 'pause'),
  gridPricePollSec: num('GRID_PRICE_POLL_SEC', 15),
  gridFillFile: str('GRID_FILL_FILE', 'grid_fills.jsonl'),
  gridEventFile: str('GRID_EVENT_FILE', 'grid_events.jsonl'),
  /**
   * Deliberately a flag of its own — a `.env` typo shouldn't be able to
   * arm live trading as a side effect of some other feature.
   */
  gridLive: bool('GRID_LIVE', false),
  /**
   * Passed explicitly to every Trigger order placement. Real incident that
   * made this necessary: a correctly-triggered $99 SOL buy failed 10
   * consecutive fill attempts in a row and was left stuck open at 0%
   * filled (2026-09-14, solana-scalpe-bot-alpha), most plausibly because no
   * slippageBps was ever sent and Jupiter's own default was too tight for
   * a few seconds of normal price drift during execution. 100 bps is
   * deliberately generous for a $10-15 order on a liquid pair — the goal
   * is reliable fills, not tight execution quality.
   */
  gridSlippageBps: num('GRID_SLIPPAGE_BPS', 100),
  dataDir: str('DATA_DIR', 'data'),
} as const;

export type Config = typeof config;

/**
 * Live-trading safety ceilings. Deliberately NOT read from env — .env is
 * exactly where a fat-fingered value is most likely (a stray zero, a
 * copy-pasted example), and this is the backstop meant to survive that.
 * Raising these requires editing this file and rerunning.
 */
export const GRID_LIVE_MAX_BUDGET_USD = 150;
export const GRID_LIVE_MAX_RESTING_ORDERS = 10;
/**
 * Hard halt on unrealized mark-to-market loss across open inventory — 30%
 * of GRID_LIVE_MAX_BUDGET_USD. This is the grid-specific failure mode that
 * most needs a hard stop: price trends straight through the whole range
 * and the bot ends up fully long, underwater, with no signal-based halt
 * (unlike the scalper) to catch it, since a grid has no losing trade to
 * count — only unrealized drawdown on what it's holding.
 */
export const GRID_LIVE_MAX_DRAWDOWN_USD = 45;
