import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Append-only JSONL journal — one file for lifecycle events (order placed,
 * halted, paused/resumed, ...), one for realized fills. Matches the format
 * already on disk from the live grid runs this rebuild is based on:
 * `{"ts":...,"kind":"order_placed",...}` for events, and a fill record
 * written as-is for fills.
 */
export class GridJournal {
  readonly #eventPath: string;
  readonly #fillPath: string;

  constructor(dataDir: string, eventFile: string, fillFile: string) {
    mkdirSync(dataDir, { recursive: true });
    this.#eventPath = join(dataDir, eventFile);
    this.#fillPath = join(dataDir, fillFile);
  }

  event(kind: string, data: Record<string, unknown> = {}): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), kind, ...data });
    appendFileSync(this.#eventPath, line + '\n');
  }

  fill(record: Record<string, unknown>): void {
    appendFileSync(this.#fillPath, JSON.stringify(record) + '\n');
  }
}
