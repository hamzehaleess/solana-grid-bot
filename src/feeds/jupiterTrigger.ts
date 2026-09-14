import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import type { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { config } from '../config.ts';
import { RateLimiter, sleep } from '../util/ratelimit.ts';
import { log } from '../util/log.ts';

const MAX_RETRIES = 4;
const TRIGGER_HOST = 'https://api.jup.ag/trigger/v2';

export interface VaultInfo {
  userPubkey: string;
  vaultPubkey: string;
  privyVaultId: string;
}

export interface CraftDepositResult {
  transaction: string;
  requestId: string;
  receiverAddress: string;
  mint: string;
  amount: string;
  tokenDecimals: number;
  inputTokenAccount: string;
  outputTokenAccount?: string;
}

export interface CreateOrderParams {
  orderType: 'single';
  depositRequestId: string;
  depositSignedTx: string;
  userPubkey: string;
  inputMint: string;
  inputAmount: string;
  outputMint: string;
  triggerMint: string;
  expiresAt: number;
  triggerCondition: 'above' | 'below';
  triggerPriceUsd: number;
  slippageBps?: number;
}

export interface CreateOrderResult {
  /** Confirmed against a real successful response: the field is `id`, not
   * `orderId` — an earlier version of this client got that wrong and it
   * caused a real order to look like a failure. */
  id?: string;
  txSignature?: string;
  depositConfirmed?: boolean;
  [key: string]: unknown;
}

/** Confirmed possible orderState values: 'open' (active, monitoring),
 * 'filled' (fully filled, output withdrawn), 'cancelled', 'expired'. */
export interface TriggerOrder {
  id: string;
  orderState?: string;
  [key: string]: unknown;
}

/**
 * Signs an arbitrary message with a Solana Ed25519 keypair using only
 * what's already in this project's dependency tree — no new package. A
 * Solana secret key is `seed(32) || publicKey(32)`, which is exactly the
 * raw material Node's crypto module needs to construct an Ed25519 JWK key
 * and sign with it directly.
 */
const signMessage = (wallet: Keypair, message: string): string => {
  const seed = Buffer.from(wallet.secretKey.slice(0, 32));
  const pub = Buffer.from(wallet.secretKey.slice(32, 64));
  const b64url = (b: Buffer): string => b.toString('base64url');
  const privateKey = createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', d: b64url(seed), x: b64url(pub) },
    format: 'jwk',
  });
  const sig = cryptoSign(null, Buffer.from(message, 'utf8'), privateKey);
  return bs58.encode(sig);
};

/**
 * Client for Jupiter's Trigger (real resting limit order) API — separate
 * from JupiterClient, which only knows the keyless Ultra swap/price/tokens
 * surface. Trigger needs a registered account (JUP_API_KEY — the same key
 * this project already uses for the swap API also authenticates here,
 * confirmed directly against the live API) plus a JWT obtained by signing
 * a challenge message, and has its own rate ceiling (1 RPS on the free
 * tier, vs. the ~0.45 RPS this project uses for the keyless swap
 * endpoints) — so this owns its own RateLimiter rather than sharing
 * JupiterClient's.
 *
 * Every endpoint shape here (auth challenge/verify, vault get/register,
 * deposit/craft, orders/price) was confirmed against the real API during
 * development by eliciting its validation errors — not guessed from docs
 * alone. The one exception is `cancelOrder` and reading a real fill back
 * out of `getOrderHistory`: those have not been exercised against a real
 * order, since doing so safely would require an order that's actually
 * live. Treat both as best-effort until proven otherwise.
 */
export class JupiterTriggerClient {
  #limiter = new RateLimiter(0.9, 2); // stay under the documented 1 RPS free-tier ceiling
  readonly #host: string;
  readonly #apiKey: string;
  #token: string | null = null;
  #wallet: Keypair | null = null;

  constructor(host: string = TRIGGER_HOST, apiKey: string = config.jupApiKey) {
    this.#host = host;
    this.#apiKey = apiKey;
    if (!this.#apiKey) {
      throw new Error('JUP_API_KEY is required for the Trigger API — the keyless swap tier does not cover it.');
    }
  }

  async authenticate(wallet: Keypair): Promise<void> {
    this.#wallet = wallet;
    const challenge = await this.#request<{ type: string; challenge: string }>(
      'POST', '/auth/challenge', { walletPubkey: wallet.publicKey.toBase58(), type: 'message' }, false,
    );
    const nonceMatch = challenge.challenge.match(/nonce of ([\w-]+)/);
    if (!nonceMatch) throw new Error('could not parse nonce from Jupiter auth challenge');
    const signature = signMessage(wallet, challenge.challenge);
    const verified = await this.#request<{ token?: string }>('POST', '/auth/verify', {
      walletPubkey: wallet.publicKey.toBase58(), signature, nonce: nonceMatch[1], type: 'message',
    }, false);
    if (!verified.token) throw new Error(`Jupiter auth/verify returned no token: ${JSON.stringify(verified)}`);
    this.#token = verified.token;
    log.info('jupiter trigger: authenticated');
  }

  #headers(auth: boolean): Record<string, string> {
    const h: Record<string, string> = { accept: 'application/json' };
    if (this.#apiKey) h['x-api-key'] = this.#apiKey;
    if (auth) {
      if (!this.#token) throw new Error('not authenticated — call authenticate() first');
      h['authorization'] = `Bearer ${this.#token}`;
    }
    return h;
  }

  async #request<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    auth: boolean,
    query: Record<string, string> = {},
  ): Promise<T> {
    const url = new URL(this.#host + path);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

    let lastErr: unknown;
    let reauthed = false;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      await this.#limiter.acquire();
      try {
        const res = await fetch(url, {
          method,
          headers: body !== undefined
            ? { ...this.#headers(auth), 'content-type': 'application/json' }
            : this.#headers(auth),
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(30_000),
        });

        if (res.status === 429) {
          const retryAfter = Number(res.headers.get('retry-after') ?? 0);
          const backoff = retryAfter > 0 ? retryAfter : Math.min(30, 2 ** attempt);
          this.#limiter.penalise(backoff);
          log.warn('jupiter trigger 429, backing off', { path, backoff });
          continue;
        }
        if (res.status === 401 && auth && this.#wallet && !reauthed) {
          log.warn('jupiter trigger 401, re-authenticating once');
          reauthed = true;
          await this.authenticate(this.#wallet);
          continue;
        }
        // Same rule as JupiterClient#postJson: a non-429 error response is
        // parsed and returned, never assumed to mean "it didn't happen" —
        // this matters even more here, since these calls can move real money.
        const text = await res.text().catch(() => '');
        return JSON.parse(text || '{}') as T;
      } catch (err) {
        lastErr = err;
        if (attempt === MAX_RETRIES) break;
        await sleep(Math.min(10_000, 500 * 2 ** attempt));
      }
    }
    throw new Error(`jupiter trigger request failed after retries: ${path}: ${String(lastErr)}`);
  }

  /** Both /vault and /vault/register are GET, per Jupiter's docs — resolves
   * the wallet's vault, registering it on first use (a 409 there means
   * another call already registered it; re-fetching resolves the race). */
  async getOrRegisterVault(walletPubkey: string): Promise<VaultInfo> {
    const existing = await this.#request<VaultInfo | { error: string }>(
      'GET', '/vault', undefined, true, { walletPubkey },
    );
    if ('vaultPubkey' in existing) return existing;

    const registered = await this.#request<VaultInfo | { error: string }>(
      'GET', '/vault/register', undefined, true, { walletPubkey },
    );
    if ('vaultPubkey' in registered) return registered;

    const retry = await this.#request<VaultInfo | { error: string }>(
      'GET', '/vault', undefined, true, { walletPubkey },
    );
    if ('vaultPubkey' in retry) return retry;
    throw new Error(`could not resolve or register a Jupiter vault: ${JSON.stringify(retry)}`);
  }

  async craftDeposit(params: {
    inputMint: string; outputMint: string; userAddress: string; amount: string;
  }): Promise<CraftDepositResult> {
    return this.#request<CraftDepositResult>('POST', '/deposit/craft', {
      ...params, orderType: 'price', orderSubType: 'single',
    }, true);
  }

  async createOrder(params: CreateOrderParams): Promise<CreateOrderResult> {
    return this.#request<CreateOrderResult>('POST', '/orders/price', params, true);
  }

  /**
   * Best-effort — see class docstring: the cancel request/response shape
   * has not been exercised against a real order. A caller must never
   * assume a thrown error here means the order is gone.
   */
  async cancelOrder(orderId: string): Promise<unknown> {
    return this.#request('POST', `/orders/price/cancel/${orderId}`, {}, true);
  }

  async getOrderHistory(walletPubkey: string, page = 1, orderStatus?: string): Promise<{ orders: TriggerOrder[] }> {
    const query: Record<string, string> = { walletPubkey, page: String(page) };
    if (orderStatus) query.orderStatus = orderStatus;
    const result = await this.#request<{ orders?: TriggerOrder[] }>(
      'GET', '/orders/history', undefined, true, query,
    );
    return { orders: result.orders ?? [] };
  }
}
