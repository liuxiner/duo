const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('maoDesktop', {
  getInfo: () => ipcRenderer.invoke('desktop:get-info'),
  checkUpdate: () => ipcRenderer.invoke('runtime:check'),
  downloadUpdate: () => ipcRenderer.invoke('runtime:download'),
  applyUpdate: () => ipcRenderer.invoke('runtime:apply'),
  openWorkspace: () => ipcRenderer.invoke('desktop:open-workspace'),
  launchChromeService: (service) => ipcRenderer.invoke('desktop:launch-chrome-service', service),
  onUpdateStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('runtime:status', listener);
    return () => ipcRenderer.removeListener('runtime:status', listener);
  },
});
