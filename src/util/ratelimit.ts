export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Token-bucket rate limiter. Tokens accrue continuously at `ratePerSec`,
 * capped at `burst` (the most that can build up while idle, so coming back
 * from a quiet period allows a short burst rather than unbounded catch-up).
 */
export class RateLimiter {
  #tokens: number;
  readonly #ratePerSec: number;
  readonly #burst: number;
  #lastRefill: number;
  #penaltyUntil = 0;

  constructor(ratePerSec: number, burst: number) {
    this.#ratePerSec = ratePerSec;
    this.#burst = burst;
    this.#tokens = burst;
    this.#lastRefill = Date.now();
  }

  #refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this.#lastRefill) / 1000;
    this.#tokens = Math.min(this.#burst, this.#tokens + elapsedSec * this.#ratePerSec);
    this.#lastRefill = now;
  }

  async acquire(): Promise<void> {
    if (Date.now() < this.#penaltyUntil) {
      await sleep(this.#penaltyUntil - Date.now());
    }
    for (;;) {
      this.#refill();
      if (this.#tokens >= 1) {
        this.#tokens -= 1;
        return;
      }
      const deficitSec = (1 - this.#tokens) / this.#ratePerSec;
      await sleep(Math.max(10, deficitSec * 1000));
    }
  }

  /** Forces the next `acquire()` to wait at least `seconds`, on top of
   * normal token-bucket pacing — used after a 429 response. */
  penalise(seconds: number): void {
    this.#penaltyUntil = Math.max(this.#penaltyUntil, Date.now() + seconds * 1000);
  }
}
