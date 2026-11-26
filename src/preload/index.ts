import { contextBridge, ipcRenderer } from 'electron';
import type { TrendLensApi } from '../shared/api';

const api: TrendLensApi = {
  getSeries: (req) => ipcRenderer.invoke('data:series', req),
  search: (q) => ipcRenderer.invoke('data:search', q),
  getQuotes: (items) => ipcRenderer.invoke('data:quotes', items),
  importCsv: () => ipcRenderer.invoke('data:importCsv'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  setApiKey: (key) => ipcRenderer.invoke('settings:apiKey', key),
  listHistory: () => ipcRenderer.invoke('history:list'),
  saveHistory: (entry) => ipcRenderer.invoke('history:save', entry),
  deleteHistory: (id) => ipcRenderer.invoke('history:delete', id),
  reviewChart: (req) => ipcRenderer.invoke('ai:review', req),
  saveText: (name, content) => ipcRenderer.invoke('file:saveText', name, content),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  onMenu: (handler) => {
    const fn = (_e: unknown, action: string) => handler(action);
    ipcRenderer.on('menu', fn);
    return () => ipcRenderer.removeListener('menu', fn);
  },
};

contextBridge.exposeInMainWorld('trendlens', api);
