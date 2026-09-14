import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { GridLadder } from '../grid/types.ts';

const LADDER_FILE = 'open_grid.json';

/** `sizeTokensRaw` is a bigint, which JSON.stringify can't handle natively
 * — round-tripped through a tagged object so a reload gets a real bigint
 * back, not a number that silently loses precision at large raw-unit
 * values. */
const replacer = (_key: string, value: unknown): unknown =>
  typeof value === 'bigint' ? { __bigint__: value.toString() } : value;

const reviver = (_key: string, value: unknown): unknown => {
  if (value && typeof value === 'object' && '__bigint__' in (value as Record<string, unknown>)) {
    return BigInt((value as { __bigint__: string }).__bigint__);
  }
  return value;
};

export const saveLadder = (ladder: GridLadder, dataDir: string): void => {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, LADDER_FILE);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(ladder, replacer, 2));
  renameSync(tmp, path); // atomic on the same filesystem — no half-written ladder on a crash mid-save
};

export const loadLadder = (dataDir: string): GridLadder | undefined => {
  const path = join(dataDir, LADDER_FILE);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8'), reviver) as GridLadder;
};
