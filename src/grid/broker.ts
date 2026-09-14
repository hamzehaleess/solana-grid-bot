import type { GridOrder, GridOrderSide } from './types.ts';

export interface PlaceOrderParams {
  mint: string;
  symbol: string;
  decimals: number;
  side: GridOrderSide;
  priceUsd: number;
  sizeUsd: number;
  levelIndex: number;
  /** Set when placing a sell meant to close a specific filled buy. */
  linkedOrderId?: string;
  /**
   * The actual token amount to sell, raw units — required for a live sell:
   * placing a real order means depositing real tokens now, not `sizeUsd`
   * worth at some future price. Paper mode doesn't strictly need this at
   * placement time (it reprices everything from a quote at fill time), but
   * takes it too, so both brokers see the same params for the same call.
   */
  sizeTokensRaw?: bigint;
}

export interface FillCheckResult {
  filled: boolean;
  fillPriceUsd?: number;
  /** Tokens received (buy) or tokens sold (sell), raw units. */
  tokensRaw?: bigint;
  feesUsd?: number;
  signature?: string;
}

/**
 * A grid order's lifecycle (place -> rest, possibly for hours or days ->
 * fill or cancel) doesn't fit the scalper's `Executor` interface (one
 * quote, fill-or-reject, same tick) — this is a deliberately different
 * shape, not a variant of it. `PaperGridBroker` and `LiveGridBroker` both
 * implement this; `GridEngine` depends only on this interface, the same
 * way `Book` depends only on `Executor`.
 */
export interface GridBroker {
  place(params: PlaceOrderParams): Promise<GridOrder>;
  /** Must never assume a thrown/ambiguous error means the order is gone —
   * same philosophy as `LiveExecutor.sell`'s error handling. */
  cancel(order: GridOrder): Promise<void>;
  checkFill(
    order: GridOrder,
    decimals: number,
    currentPriceUsd: number,
    solPriceUsd: number,
  ): Promise<FillCheckResult>;
}
