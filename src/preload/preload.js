'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/**
 * レンダラーへ公開する API。Node.js の機能は直接渡さず、IPC 経由の操作だけを公開する。
 */

function subscribe(channel) {
  return (callback) => {
    const listener = (_e, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('hayamimi', {
  appInfo: () => ipcRenderer.invoke('app:info'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),

  setupStatus: () => ipcRenderer.invoke('setup:status'),
  install: (opts) => ipcRenderer.invoke('setup:install', opts),
  cancelInstall: () => ipcRenderer.invoke('setup:cancel'),
  setupSizes: () => ipcRenderer.invoke('setup:sizes'),
  undoStep: (stepId) => ipcRenderer.invoke('setup:undo', stepId),
  chooseRuntimeRoot: () => ipcRenderer.invoke('setup:chooseRoot'),
  resetRuntimeRoot: () => ipcRenderer.invoke('setup:resetRoot'),
  onSetupProgress: subscribe('setup:progress'),
  onSetupLog: subscribe('setup:log'),

  listDevices: () => ipcRenderer.invoke('engine:devices'),
  loadLive: (runOptions) => ipcRenderer.invoke('engine:loadLive', runOptions),
  setCapture: (runOptionsOrFalse) => ipcRenderer.invoke('engine:capture', runOptionsOrFalse),
  engineState: () => ipcRenderer.invoke('engine:state'),
  resetSpeakers: () => ipcRenderer.invoke('engine:resetSpeakers'),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  confirm: (message, detail, ok) => ipcRenderer.invoke('dialog:confirm', { message, detail, ok }),
  startFile: (filePath, runOptions) => ipcRenderer.invoke('engine:startFile', { filePath, runOptions }),
  stop: () => ipcRenderer.invoke('engine:stop'),
  testProxy: () => ipcRenderer.invoke('proxy:test'),
  onEvent: subscribe('engine:event'),
  onLog: subscribe('engine:log'),
  onExit: subscribe('engine:exit'),
  onFileProgress: subscribe('file:progress'),
  onReloadState: subscribe('engine:reload-state'),

  chooseFile: () => ipcRenderer.invoke('file:choose'),
  // ドラッグ＆ドロップされた File からローカルパスを取得する
  pathForFile: (file) => webUtils.getPathForFile(file),
  chooseDir: (title) => ipcRenderer.invoke('dialog:chooseDir', title),
  saveTranscript: (entries, format, meta) => ipcRenderer.invoke('transcript:save', { entries, format, meta }),
  openFolder: (target) => ipcRenderer.invoke('shell:open', target),
});
