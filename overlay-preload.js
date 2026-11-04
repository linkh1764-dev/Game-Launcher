const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayApi', {
  getState: () => ipcRenderer.invoke('overlay:getState'),
  getTheme: () => ipcRenderer.invoke('theme:get'),
  onTheme: (cb) => ipcRenderer.on('theme:changed', (_e, theme) => cb(theme)),
  openBrowser: () => ipcRenderer.send('browser:open'),
  saveNotes: (id, text) => ipcRenderer.invoke('notes:save', { id, text }),
  onState: (cb) => ipcRenderer.on('overlay:state', (_e, state) => cb(state))
});