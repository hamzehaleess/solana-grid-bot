import { RateLimiter, sleep } from '../util/ratelimit.ts';
import { log } from '../util/log.ts';

const HOST = 'https://api.jup.ag';
const MAX_RETRIES = 4;

export interface PriceInfo {
  usdPrice: number;
  liquidity?: number;
  priceChange24h?: number;
}

export interface QuoteResult {
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  [key: string]: unknown;
}

/**
 * Minimal client for Jupiter's keyless price and quote (Ultra `order`,
 * no `taker`) endpoints — everything the grid bot's paper broker and price
 * poller need. Distinct from JupiterTriggerClient, which needs an
 * authenticated account and owns its own, tighter rate limit.
 */
export class JupiterClient {
  #limiter = new RateLimiter(0.45, 2); // stay comfortably under the ~0.5 RPS keyless ceiling

  async #get<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = new URL(HOST + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      await this.#limiter.acquire();
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        if (res.status === 429) {
          const retryAfter = Number(res.headers.get('retry-after') ?? 0);
          const backoff = retryAfter > 0 ? retryAfter : Math.min(30, 2 ** attempt);
          this.#limiter.penalise(backoff);
          log.warn('jupiter 429, backing off', { path, backoff });
          continue;
        }
        const text = await res.text().catch(() => '');
        return JSON.parse(text || '{}') as T;
      } catch (err) {
        lastErr = err;
        if (attempt === MAX_RETRIES) break;
        await sleep(Math.min(10_000, 500 * 2 ** attempt));
      }
    }
    throw new Error(`jupiter request failed after retries: ${path}: ${String(lastErr)}`);
  }

  /** Batched price lookup for one or more mints in a single call. */
  async prices(mints: string[]): Promise<Record<string, PriceInfo>> {
    return this.#get<Record<string, PriceInfo>>('/price/v3', { ids: mints.join(',') });
  }

  async price(mint: string): Promise<number> {
    const result = await this.prices([mint]);
    const info = result[mint];
    if (!info) throw new Error(`no price returned for mint ${mint}`);
    return info.usdPrice;
  }

  /** Pricing-only quote (no `taker`) — returns a real, executable route
   * without building a transaction. Used by the paper broker to simulate a
   * fill at a real, current price rather than a naive mid-price. */
  async quote(inputMint: string, outputMint: string, amountRaw: bigint, slippageBps: number): Promise<QuoteResult> {
    return this.#get<QuoteResult>('/ultra/v1/order', {
      inputMint,
      outputMint,
      amount: amountRaw.toString(),
      slippageBps: String(slippageBps),
    });
  }
}
