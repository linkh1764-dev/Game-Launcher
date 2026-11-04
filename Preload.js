const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  platform: process.platform,
  getLibrary: () => ipcRenderer.invoke('library:get'),
  addGame: (name, exePath) => ipcRenderer.invoke('library:add', { name, exePath }),
  removeGame: (id) => ipcRenderer.invoke('library:remove', id),
  pickExecutable: () => ipcRenderer.invoke('dialog:pickExecutable'),
  launchGame: (id) => ipcRenderer.invoke('game:launch', id),
  setCover: (id) => ipcRenderer.invoke('cover:set', id),
  saveNotes: (id, text) => ipcRenderer.invoke('notes:save', { id, text }),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  scanGames: (sources, folders) => ipcRenderer.invoke('detect:scan', { sources, folders }),
  addDetected: (keys) => ipcRenderer.invoke('detect:add', keys),
  pickFolder: () => ipcRenderer.invoke('detect:pickFolder'),
  getScanFolders: () => ipcRenderer.invoke('detect:getFolders'),
  setScanFolders: (folders) => ipcRenderer.invoke('detect:setFolders', folders),
  getTheme: () => ipcRenderer.invoke('theme:get'),
  setTheme: (theme) => ipcRenderer.invoke('theme:set', theme),
  setHotkey: (accelerator) => ipcRenderer.invoke('settings:setHotkey', accelerator),
  onGameStarted: (cb) => ipcRenderer.on('game:started', (_e, data) => cb(data)),
  onGameStopped: (cb) => ipcRenderer.on('game:stopped', (_e, data) => cb(data)),
  onToast: (cb) => ipcRenderer.on('toast', (_e, message) => cb(message))
});