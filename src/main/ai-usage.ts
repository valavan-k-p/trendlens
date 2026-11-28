/** Local log of AI calls (tokens, searches) for the usage and cost display. */
import { app } from 'electron';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { summarizeUsage, type UsageRecord, type UsageSummary } from '@core/ai/usage';

const MAX = 5000;
const file = () => join(app.getPath('userData'), 'ai-usage.json');

function read(): UsageRecord[] {
  try {
    return existsSync(file()) ? (JSON.parse(readFileSync(file(), 'utf8')) as UsageRecord[]) : [];
  } catch {
    return [];
  }
}

export function recordUsage(r: UsageRecord): void {
  try {
    const list = [...read(), r].slice(-MAX);
    writeFileSync(`${file()}.tmp`, JSON.stringify(list), 'utf8');
    renameSync(`${file()}.tmp`, file());
  } catch {
    // Usage logging must never break an AI answer.
  }
}

export function usageSummary(): UsageSummary {
  return summarizeUsage(read());
}
