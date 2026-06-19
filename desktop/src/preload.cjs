const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('maoDesktop', {
  getInfo: () => ipcRenderer.invoke('desktop:get-info'),
  checkUpdate: () => ipcRenderer.invoke('runtime:check'),
  downloadUpdate: () => ipcRenderer.invoke('runtime:download'),
  applyUpdate: () => ipcRenderer.invoke('runtime:apply'),
  openWorkspace: () => ipcRenderer.invoke('desktop:open-workspace'),
  openLogs: () => ipcRenderer.invoke('desktop:open-logs'),
  launchChromeService: (service) => ipcRenderer.invoke('desktop:launch-chrome-service', service),
  getWechatAutomationStatus: () => ipcRenderer.invoke('desktop:wechat-automation-status'),
  requestWechatAutomationPermissions: () => ipcRenderer.invoke('desktop:request-wechat-automation-permissions'),
  createWechatDraft: (options) => ipcRenderer.invoke('desktop:create-wechat-draft', options),
  testWechatKeyboard: (options) => ipcRenderer.invoke('desktop:test-wechat-keyboard', options),
  onUpdateStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('runtime:status', listener);
    return () => ipcRenderer.removeListener('runtime:status', listener);
  },
});
