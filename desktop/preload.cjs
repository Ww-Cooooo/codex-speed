'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tps', Object.freeze({
  getSnapshot: () => ipcRenderer.invoke('tps:get-snapshot'),
  onSnapshot: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    const handler = (_event, snapshot) => listener(snapshot);
    ipcRenderer.on('tps:snapshot', handler);
    return () => ipcRenderer.removeListener('tps:snapshot', handler);
  },
  getState: () => ipcRenderer.invoke('tps:get-state'),
  onState: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('tps:state', handler);
    return () => ipcRenderer.removeListener('tps:state', handler);
  },
  setPinned: (pinned) => ipcRenderer.invoke('tps:set-pinned', pinned),
  setExpanded: (expanded) => ipcRenderer.invoke('tps:set-expanded', expanded),
  setMaximized: (maximized) => ipcRenderer.invoke('tps:set-maximized', maximized),
  setConversationOrder: (ids) => ipcRenderer.invoke('tps:set-conversation-order', ids),
  resizeHeight: (height, finished = false) => ipcRenderer.send('tps:resize-height', height, finished),
  hide: () => ipcRenderer.send('tps:hide'),
  quit: () => ipcRenderer.send('tps:quit'),
}));
