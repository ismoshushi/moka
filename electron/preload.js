const { contextBridge, ipcRenderer } = require('electron')

/** 只把需要的几个能力暴露给界面，界面拿不到 node 权限（安全边界）。 */
contextBridge.exposeInMainWorld('moka', {
  getState: () => ipcRenderer.invoke('state:get'),
  saveLlm: (llm) => ipcRenderer.invoke('state:saveLlm', llm),
  savePhone: (phone) => ipcRenderer.invoke('state:savePhone', phone),
  clearHistory: () => ipcRenderer.invoke('state:clearHistory'),

  testLlm: (cfg) => ipcRenderer.invoke('chat:test', cfg),
  run: (payload) => ipcRenderer.invoke('agent:run', payload),
  ensureSession: (id, title) => ipcRenderer.invoke('session:ensure', { id, title }),
  cancel: () => ipcRenderer.invoke('agent:cancel'),
  pause: () => ipcRenderer.invoke('agent:pause'),
  resume: () => ipcRenderer.invoke('agent:resume'),
  supplement: (text) => ipcRenderer.invoke('agent:supplement', text),
  onLog: (fn) => {
    const h = (_e, line) => fn(line)
    ipcRenderer.on('agent:log', h)
    return () => ipcRenderer.removeListener('agent:log', h)
  },
  onDone: (fn) => {
    const h = () => fn()
    ipcRenderer.on('agent:done', h)
    return () => ipcRenderer.removeListener('agent:done', h)
  },

  connectPhone: (cfg) => ipcRenderer.invoke('phone:connect', cfg),
  renamePhone: (serial, name) => ipcRenderer.invoke('phone:rename', { serial, name }),
  setPhoneDeviceName: (serial, name) => ipcRenderer.invoke('phone:setDeviceName', { serial, name }),
  phoneFrame: () => ipcRenderer.invoke('phone:frame'),
  phoneDevices: () => ipcRenderer.invoke('phone:devices'),

  openSite: (url) => ipcRenderer.invoke('web:open', url),
  siteShot: (targetId) => ipcRenderer.invoke('web:shot', targetId),

  openStateDir: () => ipcRenderer.invoke('app:openStateDir'),
})
