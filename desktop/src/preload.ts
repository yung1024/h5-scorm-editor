import { contextBridge } from 'electron';

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld('h5Desktop', Object.freeze({
    desktop: true,
    platform: process.platform,
  }));
}
