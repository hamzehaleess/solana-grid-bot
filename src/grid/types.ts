export type GridOrderSide = 'buy' | 'sell';
export type GridOrderStatus = 'resting' | 'filled' | 'cancelled';

export interface GridOrder {
  id: string;
  levelIndex: number;
  side: GridOrderSide;
  mint: string;
  symbol: string;
  priceUsd: number;
  sizeUsd: number;
  status: GridOrderStatus;
  placedAt: number;
  filledAt?: number;
  fillPriceUsd?: number;
  /** Set when this is a sell meant to close a specific filled buy. */
  linkedOrderId?: string;
  /** Tokens actually held (buy) or being sold (sell), raw units. */
  sizeTokensRaw?: bigint;
  /** Set once placed live — Jupiter's own order id, used to look the order
   * back up in getOrderHistory(). */
  jupiterOrderId?: string;
  /** The deposit/craft requestId used to fund this order's vault deposit. */
  depositRequestId?: string;
}

export interface GridLevel {
  index: number;
  priceUsd: number;
}

export type GridLadderStatus = 'active' | 'paused_out_of_range';

export interface GridLadder {
  gridId: string;
  mint: string;
  symbol: string;
  decimals: number;
  lowPriceUsd: number;
  highPriceUsd: number;
  levels: GridLevel[];
  orders: GridOrder[];
  createdAt: number;
  status: GridLadderStatus;
  budgetUsd: number;
}
