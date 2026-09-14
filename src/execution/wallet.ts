import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { config } from '../config.ts';

/** Parses WALLET_PRIVATE_KEY into a signing Keypair. Rejects an empty
 * value, invalid base58, and a decodable string of the wrong length (e.g.
 * a public address pasted in by mistake, which is 32 bytes, not 64) with a
 * clear message rather than a stack trace about undefined. */
export const loadWallet = (rawKey: string = config.walletPrivateKey): Keypair => {
  const trimmed = rawKey.trim();
  if (!trimmed) {
    throw new Error(
      'WALLET_PRIVATE_KEY is empty. Set it in .env to the base58-encoded 64-byte secret ' +
        'key a wallet exports, not a seed phrase, a public address, or a JSON array.',
    );
  }
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(trimmed);
  } catch (err) {
    throw new Error(`WALLET_PRIVATE_KEY is not valid base58: ${String(err)}`);
  }
  if (decoded.length !== 64) {
    throw new Error(
      `WALLET_PRIVATE_KEY decodes to ${decoded.length} bytes, expected 64 — ` +
        'this looks like the wrong kind of value (a public address decodes to 32 bytes).',
    );
  }
  return Keypair.fromSecretKey(decoded);
};

export const connectRpc = (): Connection => new Connection(config.rpcUrl, 'confirmed');

export interface WalletBalances {
  solLamports: bigint;
  solUsd: number;
}

export const fetchBalances = async (
  connection: Connection,
  wallet: Keypair,
  solPriceUsd: number,
): Promise<WalletBalances> => {
  const solLamports = BigInt(await connection.getBalance(wallet.publicKey));
  const solUsd = (Number(solLamports) / 1e9) * solPriceUsd;
  return { solLamports, solUsd };
};

export const fetchTokenBalanceRaw = async (
  connection: Connection,
  wallet: Keypair,
  mint: string,
): Promise<bigint> => {
  const accounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(mint) });
  let total = 0n;
  for (const { account } of accounts.value) {
    total += BigInt(account.data.parsed.info.tokenAmount.amount);
  }
  return total;
};
