import { randomUUID } from 'node:crypto';
import type { GridBroker, FillCheckResult, PlaceOrderParams } from './broker.ts';
import type { GridOrder } from './types.ts';
import { JupiterClient } from '../feeds/jupiter.ts';
import { toRaw } from '../execution/costModel.ts';
import { config, USDC_MINT, USDC_DECIMALS } from '../config.ts';

/**
 * Simulates grid order fills without ever touching a wallet: a buy or sell
 * "crosses" once the current price passes its trigger level, and — once
 * crossed — is priced from a real, live Jupiter quote rather than the
 * nominal level price, so simulated P&L reflects real spread and price
 * impact, not just the round-number target.
 *
 * Slippage tolerance passed to the pricing quote itself — this does not
 * model real on-chain slippage risk (there's no transaction to fail here,
 * unlike the live broker), it only keeps the simulated quote consistent
 * with what a live order would actually request.
 */
export class PaperGridBroker implements GridBroker {
  readonly #jup: JupiterClient;

  constructor(jup: JupiterClient) {
    this.#jup = jup;
  }

  async place(params: PlaceOrderParams): Promise<GridOrder> {
    return {
      id: randomUUID(),
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
    };
  }

  async cancel(order: GridOrder): Promise<void> {
    void order; // nothing real to cancel in paper mode
  }

  async checkFill(order: GridOrder, decimals: number, currentPriceUsd: number): Promise<FillCheckResult> {
    const crossed = order.side === 'buy' ? currentPriceUsd <= order.priceUsd : currentPriceUsd >= order.priceUsd;
    if (!crossed) return { filled: false };

    if (order.side === 'buy') {
      const amountRaw = toRaw(order.sizeUsd, USDC_DECIMALS);
      const quote = await this.#jup.quote(USDC_MINT, order.mint, amountRaw, config.gridSlippageBps);
      const tokensUi = Number(quote.outAmount) / 10 ** decimals;
      if (tokensUi <= 0) return { filled: false };
      return { filled: true, fillPriceUsd: order.sizeUsd / tokensUi, tokensRaw: BigInt(quote.outAmount) };
    }

    if (order.sizeTokensRaw === undefined || order.sizeTokensRaw <= 0n) return { filled: false };
    const quote = await this.#jup.quote(order.mint, USDC_MINT, order.sizeTokensRaw, config.gridSlippageBps);
    const usdcOut = Number(quote.outAmount) / 10 ** USDC_DECIMALS;
    const tokensUi = Number(order.sizeTokensRaw) / 10 ** decimals;
    if (tokensUi <= 0) return { filled: false };
    return { filled: true, fillPriceUsd: usdcOut / tokensUi, tokensRaw: order.sizeTokensRaw };
  }
}
