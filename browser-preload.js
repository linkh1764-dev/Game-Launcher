const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('browserApi', {
  getState: () => ipcRenderer.invoke('browser:getState'),
  getTheme: () => ipcRenderer.invoke('theme:get'),
  onTheme: (cb) => ipcRenderer.on('theme:changed', (_e, theme) => cb(theme)),
  navigate: (text) => ipcRenderer.send('browser:navigate', text),
  back: () => ipcRenderer.send('browser:back'),
  forward: () => ipcRenderer.send('browser:forward'),
  reload: () => ipcRenderer.send('browser:reload'),
  home: () => ipcRenderer.send('browser:home'),
  close: () => ipcRenderer.send('browser:close'),
  onState: (cb) => ipcRenderer.on('browser:state', (_e, state) => cb(state))
});