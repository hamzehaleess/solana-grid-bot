export const round = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

/** Converts a UI amount (dollars, or whole tokens) to the integer raw units
 * a mint's decimals imply — e.g. toRaw(10, 6) === 10_000_000n for USDC. */
export const toRaw = (amount: number, decimals: number): bigint => BigInt(Math.round(amount * 10 ** decimals));
