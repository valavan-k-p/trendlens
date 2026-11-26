/**
 * Installs the bundled TrendLensFeed EA into each detected MT4 data folder's
 * MQL4\Experts directory. Copies only TrendLensFeed.mq4/.ex4; never touches other files.
 */
import { app } from 'electron';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const FILES = ['TrendLensFeed.ex4', 'TrendLensFeed.mq4'];

/** Folder holding the bundled EA: resources\mt4 when packaged, ./resources/mt4 in development. */
export function bundledFeedDir(): string {
  const packaged = join(process.resourcesPath ?? '', 'mt4');
  if (app.isPackaged && existsSync(packaged)) return packaged;
  return join(app.getAppPath(), 'resources', 'mt4');
}

export interface InstallResult {
  dataDir: string;
  experts: string;
  ok: boolean;
  error?: string;
}

export function installFeed(dataDirs: string[]): InstallResult[] {
  const src = bundledFeedDir();
  return dataDirs.map((dataDir) => {
    const experts = join(dataDir, 'MQL4', 'Experts');
    try {
      if (!existsSync(join(dataDir, 'MQL4'))) throw new Error('This folder has no MQL4 directory (not an MT4 data folder).');
      mkdirSync(experts, { recursive: true });
      for (const f of FILES) copyFileSync(join(src, f), join(experts, f));
      return { dataDir, experts, ok: true };
    } catch (e) {
      return { dataDir, experts, ok: false, error: (e as Error).message };
    }
  });
}

/** True when this MT4 data folder already has TrendLensFeed installed. */
export function isFeedInstalled(dataDir: string): boolean {
  return existsSync(join(dataDir, 'MQL4', 'Experts', 'TrendLensFeed.ex4'));
}
