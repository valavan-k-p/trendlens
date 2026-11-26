/**
 * Local option-chain snapshot storage: one JSON-lines file per exchange/underlying/expiry under
 * <base>/snapshots/. Plain Node fs (no Electron) so it can be unit-tested with a temp folder.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { snapshotKey, type OptionSnapshot, type SnapshotSummary } from '@core/options/option-snapshots';
import type { OptionExchange } from '@core/options/types';

export interface SnapshotMeta {
  t: number;
  expiry: string;
  provider: OptionSnapshot['provider'];
  summary: SnapshotSummary;
}

/** Maximum snapshots kept per file; the oldest are dropped when exceeded. */
export const MAX_PER_FILE = 3000;

export class SnapshotStore {
  constructor(private readonly base: string) {}

  private dir(): string {
    const d = join(this.base, 'snapshots');
    mkdirSync(d, { recursive: true });
    return d;
  }

  private file(exchange: OptionExchange, symbol: string, expiry: string): string {
    return join(this.dir(), `${snapshotKey(exchange, symbol, expiry)}.jsonl`);
  }

  private read(path: string): OptionSnapshot[] {
    if (!existsSync(path)) return [];
    const out: OptionSnapshot[] = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const s = JSON.parse(line) as OptionSnapshot;
        if (s && s.v === 1 && typeof s.t === 'number') out.push(s);
      } catch {
        // A torn last line (crash mid-write) is skipped, the rest stays readable.
      }
    }
    return out;
  }

  save(s: OptionSnapshot): void {
    const path = this.file(s.exchange, s.symbol, s.expiry);
    appendFileSync(path, `${JSON.stringify(s)}\n`, 'utf8');
    const all = this.read(path);
    if (all.length > MAX_PER_FILE) {
      const keep = all.slice(-MAX_PER_FILE);
      writeFileSync(`${path}.tmp`, keep.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
      renameSync(`${path}.tmp`, path);
    }
  }

  /** Snapshot summaries for an underlying (all expiries, or one), oldest first. */
  list(exchange: OptionExchange, symbol: string, expiry?: string): SnapshotMeta[] {
    const prefix = snapshotKey(exchange, symbol, '');
    const files = readdirSync(this.dir()).filter(
      (f) => f.startsWith(prefix) && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f.slice(prefix.length)) && (!expiry || f === `${snapshotKey(exchange, symbol, expiry)}.jsonl`),
    );
    const out: SnapshotMeta[] = [];
    for (const f of files) for (const s of this.read(join(this.dir(), f))) out.push({ t: s.t, expiry: s.expiry, provider: s.provider, summary: s.summary });
    return out.sort((a, b) => a.t - b.t);
  }

  load(exchange: OptionExchange, symbol: string, expiry: string, t: number): OptionSnapshot | undefined {
    return this.read(this.file(exchange, symbol, expiry)).find((s) => s.t === t);
  }

  latestBefore(exchange: OptionExchange, symbol: string, expiry: string, t: number): OptionSnapshot | undefined {
    const list = this.read(this.file(exchange, symbol, expiry)).filter((s) => s.t < t);
    return list[list.length - 1];
  }
}
