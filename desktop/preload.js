'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('discotavoDesktop', {
  onToggleMute(callback) {
    ipcRenderer.on('toggle-mute', () => callback());
  },
});
