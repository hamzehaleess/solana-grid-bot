import type { GridLevel, GridOrder } from './types.ts';

/** Jupiter Trigger API's minimum per order. Hardcoded, not env-driven —
 * a GRID_LEVEL_SIZE_USD below this should fail loudly at startup, not
 * produce a confusing rejection from Jupiter later. */
export const MIN_ORDER_USD = 10;

export const levelStep = (lowPriceUsd: number, highPriceUsd: number, levels: number): number => {
  if (levels < 2) throw new Error(`GRID_LEVELS must be at least 2, got ${levels}`);
  if (highPriceUsd <= lowPriceUsd) {
    throw new Error(`GRID_HIGH_PRICE_USD (${highPriceUsd}) must be above GRID_LOW_PRICE_USD (${lowPriceUsd})`);
  }
  return (highPriceUsd - lowPriceUsd) / (levels - 1);
};

export const generateLevels = (lowPriceUsd: number, highPriceUsd: number, levels: number): GridLevel[] => {
  const step = levelStep(lowPriceUsd, highPriceUsd, levels);
  return Array.from({ length: levels }, (_, i) => ({ index: i, priceUsd: lowPriceUsd + i * step }));
};

export const isOutOfRange = (currentPriceUsd: number, lowPriceUsd: number, highPriceUsd: number): boolean =>
  currentPriceUsd < lowPriceUsd || currentPriceUsd > highPriceUsd;

/** Where to rest the paired sell for a buy that just filled: one grid step
 * above the actual fill price, not the level's nominal price — profit is
 * measured off what was really paid, not the target. */
export const nextRebalanceLevel = (fillPriceUsd: number, step: number): number => fillPriceUsd + step;

export const validateLevelSize = (levelSizeUsd: number, minOrderUsd: number = MIN_ORDER_USD): void => {
  if (levelSizeUsd < minOrderUsd) {
    throw new Error(
      `GRID_LEVEL_SIZE_USD=$${levelSizeUsd} is below Jupiter's $${minOrderUsd} minimum order size`,
    );
  }
};

export interface OpenInventory {
  costBasisUsd: number;
  markValueUsd: number;
}

/** Unrealized mark-to-market across every filled buy that hasn't had its
 * paired sell fill yet — i.e. real inventory the ladder is still holding. */
export const computeOpenInventory = (
  orders: GridOrder[],
  decimals: number,
  currentPriceUsd: number,
): OpenInventory => {
  const closedBuyIds = new Set(
    orders.filter((o) => o.side === 'sell' && o.status === 'filled' && o.linkedOrderId).map((o) => o.linkedOrderId),
  );
  let costBasisUsd = 0;
  let markValueUsd = 0;
  for (const order of orders) {
    if (order.side !== 'buy' || order.status !== 'filled') continue;
    if (closedBuyIds.has(order.id)) continue;
    if (order.sizeTokensRaw === undefined) continue;
    const tokensUi = Number(order.sizeTokensRaw) / 10 ** decimals;
    costBasisUsd += order.sizeUsd;
    markValueUsd += tokensUi * currentPriceUsd;
  }
  return { costBasisUsd, markValueUsd };
};
