import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseCsv } from '@core/data/csv';
import * as market from './market';
import * as store from './store';
import { reviewChart } from './ai';
import * as mt4 from './mt4';
import { installFeed } from './mt4install';
import type { Settings, WatchItem } from '../shared/api';

let win: BrowserWindow | null = null;

const FALLBACK_DEFAULT: Settings['defaultSymbol'] = { symbol: '^NSEI', name: 'NIFTY 50', exchange: 'NSE', assetClass: 'index', provider: 'yahoo' };

/**
 * Makes MT4 the primary source when its history exists: MT4 watch items that the
 * terminal does not carry are dropped, and without MT4 the defaults fall back to
 * online data so the app still opens on a working chart.
 */
function resolveSettings(s: Settings): Settings {
  const hasMt4 = s.dataSource === 'mt4' && mt4.status().available;
  const keep = (items: WatchItem[]) => items.filter((w) => w.provider !== 'mt4' || (hasMt4 && mt4.hasSymbol(w.symbol)));
  let defaultSymbol = s.defaultSymbol;
  if (defaultSymbol.provider === 'mt4' && !(hasMt4 && mt4.hasSymbol(defaultSymbol.symbol))) defaultSymbol = FALLBACK_DEFAULT;
  return { ...s, defaultSymbol, tickerTape: keep(s.tickerTape), usWatchlist: keep(s.usWatchlist), indiaWatchlist: keep(s.indiaWatchlist) };
}

function createWindow(): void {
  const settings = store.getSettings();
  nativeTheme.themeSource = settings.theme;
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    title: 'TrendLens',
    backgroundColor: settings.theme === 'dark' ? '#0b1118' : '#f5f7fa',
    show: false,
    autoHideMenuBar: false,
    icon: join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win?.show());
  // Open external links in the user's browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(process.env.ELECTRON_RENDERER_URL ?? 'file://')) e.preventDefault();
  });

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
}

function send(action: string) {
  win?.webContents.send('menu', action);
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '&File',
      submenu: [
        { label: 'Import CSV…', accelerator: 'CmdOrCtrl+O', click: () => send('import-csv') },
        { label: 'Export Report…', accelerator: 'CmdOrCtrl+E', click: () => send('export-report') },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => send('settings') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: '&View',
      submenu: [
        { label: 'Analyzer', accelerator: 'CmdOrCtrl+1', click: () => send('view:analyzer') },
        { label: 'Markets', accelerator: 'CmdOrCtrl+2', click: () => send('view:markets') },
        { label: 'AI Chart Review', accelerator: 'CmdOrCtrl+3', click: () => send('view:upload') },
        { label: 'History', accelerator: 'CmdOrCtrl+4', click: () => send('view:history') },
        { type: 'separator' },
        { label: 'Search Symbol', accelerator: 'CmdOrCtrl+K', click: () => send('search') },
        { label: 'Analyse', accelerator: 'F5', click: () => send('analyse') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
    {
      label: '&Help',
      submenu: [
        { label: 'How Analysis Works', click: () => send('help') },
        {
          label: 'About TrendLens',
          click: () =>
            void dialog.showMessageBox(win!, {
              type: 'info',
              title: 'About TrendLens',
              message: `TrendLens ${app.getVersion()}`,
              detail:
                'Personal market-structure analysis workstation.\n\nData: Yahoo Finance public endpoints and Binance public market data. Charts: TradingView Lightweight Charts (Apache-2.0).\n\nOutputs are educational and informational only — not investment advice.',
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpc(): void {
  ipcMain.handle('data:series', (_e, req) => market.getSeries(req));
  // MT4 symbols are listed first; online symbols follow for instruments MT4 does not carry.
  ipcMain.handle('data:search', (_e, q: string) => market.search(q));
  ipcMain.handle('data:quotes', (_e, items) => market.getQuotes(items));
  ipcMain.handle('data:importCsv', async () => {
    const r = await dialog.showOpenDialog(win!, { title: 'Import OHLCV CSV', filters: [{ name: 'CSV', extensions: ['csv', 'txt'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const p = r.filePaths[0];
    return parseCsv(await readFile(p, 'utf8'), basename(p).replace(/\.(csv|txt)$/i, ''));
  });
  ipcMain.handle('settings:get', () => resolveSettings(store.getSettings()));
  ipcMain.handle('settings:save', (_e, patch) => {
    const s = store.saveSettings(patch);
    nativeTheme.themeSource = s.theme;
    mt4.setMt4Folder(s.mt4Folder);
    return resolveSettings(s);
  });
  ipcMain.handle('settings:apiKey', (_e, key: string | null) => resolveSettings(store.setApiKey(key)));
  ipcMain.handle('mt4:status', () => mt4.status());
  ipcMain.handle('mt4:installFeed', () => installFeed(mt4.feedTargets()));
  ipcMain.handle('mt4:openExperts', (_e, dataDir: string) => {
    // Only open folders TrendLens itself detected as MT4 data folders.
    if (mt4.feedTargets().includes(dataDir)) return shell.openPath(join(dataDir, 'MQL4', 'Experts'));
  });
  ipcMain.handle('mt4:instruments', () => mt4.instruments());
  ipcMain.handle('mt4:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Choose the MetaTrader 4 data folder (the one that contains "history")',
      properties: ['openDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return resolveSettings(store.getSettings());
    const s = store.saveSettings({ mt4Folder: r.filePaths[0] });
    mt4.setMt4Folder(s.mt4Folder);
    return resolveSettings(s);
  });
  ipcMain.handle('history:list', () => store.listHistory());
  ipcMain.handle('history:save', (_e, entry) => store.saveHistory(entry));
  ipcMain.handle('history:delete', (_e, id: string) => store.deleteHistory(id));
  ipcMain.handle('ai:review', (_e, req) => reviewChart(req));
  ipcMain.handle('file:saveText', async (_e, name: string, content: string) => {
    const r = await dialog.showSaveDialog(win!, { defaultPath: name, filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'Text', extensions: ['txt'] }] });
    if (r.canceled || !r.filePath) return null;
    await writeFile(r.filePath, content, 'utf8');
    return r.filePath;
  });
  ipcMain.handle('shell:open', (_e, url: string) => {
    if (/^https:\/\//.test(url)) return shell.openExternal(url);
  });
}

app.whenReady().then(() => {
  app.setAppUserModelId('local.trendlens.app');
  mt4.setMt4Folder(store.getSettings().mt4Folder);
  registerIpc();
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
