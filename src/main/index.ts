import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseCsv } from '@core/data/csv';
import * as market from './market';
import * as store from './store';
import { reviewChart } from './ai';

let win: BrowserWindow | null = null;

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
  ipcMain.handle('data:search', (_e, q: string) => market.search(q));
  ipcMain.handle('data:quotes', (_e, items) => market.getQuotes(items));
  ipcMain.handle('data:importCsv', async () => {
    const r = await dialog.showOpenDialog(win!, { title: 'Import OHLCV CSV', filters: [{ name: 'CSV', extensions: ['csv', 'txt'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const p = r.filePaths[0];
    return parseCsv(await readFile(p, 'utf8'), basename(p).replace(/\.(csv|txt)$/i, ''));
  });
  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:save', (_e, patch) => {
    const s = store.saveSettings(patch);
    nativeTheme.themeSource = s.theme;
    return s;
  });
  ipcMain.handle('settings:apiKey', (_e, key: string | null) => store.setApiKey(key));
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
