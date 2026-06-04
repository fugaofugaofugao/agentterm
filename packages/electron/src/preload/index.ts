import { contextBridge, ipcRenderer } from "electron"

contextBridge.exposeInMainWorld("agentTerm", {
  configStatus: () => ipcRenderer.invoke("config:status"),
  configGetMode: () => ipcRenderer.invoke("config:getMode"),
  configSetupHost: (username: string, password: string, port?: number) =>
    ipcRenderer.invoke("config:setupHost", username, password, port),
  configSetupClient: (url: string, serverKey: string, username: string, password: string) =>
    ipcRenderer.invoke("config:setupClient", url, serverKey, username, password),
  configGet: () => ipcRenderer.invoke("config:get"),
  configSave: (updates: any) => ipcRenderer.invoke("config:save", updates),
  configReset: () => ipcRenderer.invoke("config:reset"),
  runtimeGetSettings: () => ipcRenderer.invoke("runtime:getSettings"),
  runtimeSaveSettings: (runtime: any) => ipcRenderer.invoke("runtime:saveSettings", runtime),

  remoteLogin: (url: string, username: string, password: string) =>
    ipcRenderer.invoke("remote:login", url, username, password),
  remoteTestConnection: (url: string) =>
    ipcRenderer.invoke("remote:testConnection", url),

  login: (username: string, password: string) =>
    ipcRenderer.invoke("auth:login", username, password),
  checkAuth: () => ipcRenderer.invoke("auth:check"),
  logout: () => ipcRenderer.invoke("auth:logout"),

  listSessions: () => ipcRenderer.invoke("sessions:list"),
  createSession: (name: string) => ipcRenderer.invoke("sessions:create", name),
  killSession: (name: string, deviceId?: string | null) => ipcRenderer.invoke("sessions:kill", name, deviceId),
  resetSession: (name: string, deviceId?: string | null) => ipcRenderer.invoke("sessions:reset", name, deviceId),

  attachSession: (name: string, cols?: number, rows?: number, deviceId?: string | null) =>
    ipcRenderer.invoke("terminal:attach", name, cols, rows, deviceId),
  detachSession: (name: string, deviceId?: string | null) => ipcRenderer.invoke("terminal:detach", name, deviceId),
  sendInput: (session: string, data: string, deviceId?: string | null) =>
    ipcRenderer.send("terminal:input", session, data, deviceId),
  resize: (session: string, cols: number, rows: number, deviceId?: string | null, clientId?: string) =>
    ipcRenderer.send("terminal:resize", session, cols, rows, deviceId, clientId),
  resizeIntent: (session: string, cols: number, rows: number, deviceId?: string | null, clientId?: string) =>
    ipcRenderer.send("terminal:resize-intent", session, cols, rows, deviceId, clientId),
  scroll: (session: string, lines: number, deviceId?: string | null) =>
    ipcRenderer.send("terminal:scroll", session, lines, deviceId),

  onOutput: (callback: (session: string, data: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { session: string; data: string; deviceId?: string | null }) => {
      callback(payload.session, payload.data, payload.deviceId || null)
    }
    ipcRenderer.on("terminal:output", handler)
    return () => ipcRenderer.removeListener("terminal:output", handler)
  },

  onScrollState: (callback: (session: string, state: any, deviceId?: string | null) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: any) => {
      callback(payload.session, payload, payload.deviceId || null)
    }
    ipcRenderer.on("terminal:scroll-state", handler)
    return () => ipcRenderer.removeListener("terminal:scroll-state", handler)
  },

  onSessionExit: (callback: (session: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { session: string; deviceId?: string | null }) => {
      callback(payload.session, payload.deviceId || null)
    }
    ipcRenderer.on("terminal:exit", handler)
    return () => ipcRenderer.removeListener("terminal:exit", handler)
  },

  onClear: (callback: (session: string, deviceId?: string | null) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { session: string; deviceId?: string | null }) => {
      callback(payload.session, payload.deviceId || null)
    }
    ipcRenderer.on("terminal:clear", handler)
    return () => ipcRenderer.removeListener("terminal:clear", handler)
  },

  onSize: (callback: (session: string, size: any, deviceId?: string | null) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: any) => {
      callback(payload.session, payload, payload.deviceId || null)
    }
    ipcRenderer.on("terminal:size", handler)
    return () => ipcRenderer.removeListener("terminal:size", handler)
  },
})
