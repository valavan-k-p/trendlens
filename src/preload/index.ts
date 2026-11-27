import { contextBridge, ipcRenderer } from 'electron';
import type { TrendLensApi } from '../shared/api';

const api: TrendLensApi = {
  getSeries: (req) => ipcRenderer.invoke('data:series', req),
  search: (q) => ipcRenderer.invoke('data:search', q),
  getQuotes: (items) => ipcRenderer.invoke('data:quotes', items),
  mt4Status: () => ipcRenderer.invoke('mt4:status'),
  mt4Instruments: () => ipcRenderer.invoke('mt4:instruments'),
  pickMt4Folder: () => ipcRenderer.invoke('mt4:pickFolder'),
  installMt4Feed: () => ipcRenderer.invoke('mt4:installFeed'),
  openMt4Experts: (dataDir) => ipcRenderer.invoke('mt4:openExperts', dataDir),
  importCsv: () => ipcRenderer.invoke('data:importCsv'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  setApiKey: (provider, key) => ipcRenderer.invoke('settings:apiKey', provider, key),
  testAi: (req) => ipcRenderer.invoke('ai:test', req),
  listHistory: () => ipcRenderer.invoke('history:list'),
  saveHistory: (entry) => ipcRenderer.invoke('history:save', entry),
  deleteHistory: (id) => ipcRenderer.invoke('history:delete', id),
  reviewChart: (req) => ipcRenderer.invoke('ai:review', req),
  optionCatalog: (exchange, refresh) => ipcRenderer.invoke('options:catalog', exchange, refresh),
  optionChain: (req) => ipcRenderer.invoke('options:chain', req),
  mt4OptionCatalog: () => ipcRenderer.invoke('options:mt4Catalog'),
  mt4OptionChain: (req) => ipcRenderer.invoke('options:mt4Chain', req),
  setOptionCredentials: (c) => ipcRenderer.invoke('options:credentials', c),
  testOptionProvider: (provider) => ipcRenderer.invoke('options:test', provider),
  importOptionCsv: () => ipcRenderer.invoke('options:importCsv'),
  optionSnapshots: (exchange, symbol, expiry) => ipcRenderer.invoke('options:snapshots', exchange, symbol, expiry),
  loadOptionSnapshot: (exchange, symbol, expiry, t) => ipcRenderer.invoke('options:loadSnapshot', exchange, symbol, expiry, t),
  saveOptionSnapshot: (s) => ipcRenderer.invoke('options:saveSnapshot', s),
  saveText: (name, content) => ipcRenderer.invoke('file:saveText', name, content),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  onMenu: (handler) => {
    const fn = (_e: unknown, action: string) => handler(action);
    ipcRenderer.on('menu', fn);
    return () => ipcRenderer.removeListener('menu', fn);
  },
};

contextBridge.exposeInMainWorld('trendlens', api);
