import { ipcMain, BrowserWindow, app, powerSaveBlocker } from "electron"
import * as os from "os"
import * as ptyManager from "./pty-manager"
import * as remote from "./remote-transport"
import { startEmbeddedServer, stopEmbeddedServer } from "./server-manager"
import { startHostConnection, stopHostConnection, triggerSessionSync } from "./host-connection"

const shared = require("@agentterm/shared")

let authenticatedUser: string | null = null
let currentMode: "host" | "client" = "host"
let ipcPowerBlockerId: number | null = null

function applyRuntimeSettings(runtime: any): void {
  app.setLoginItemSettings({ openAtLogin: !!runtime.launch_at_login })
  if (runtime.keep_awake) {
    if (ipcPowerBlockerId === null) ipcPowerBlockerId = powerSaveBlocker.start("prevent-app-suspension")
  } else if (ipcPowerBlockerId !== null) {
    powerSaveBlocker.stop(ipcPowerBlockerId)
    ipcPowerBlockerId = null
  }
}
try {
  if (shared.isConfigured()) {
    const initConfig = shared.loadConfig()
    if (initConfig.mode) currentMode = initConfig.mode
  }
} catch {}

export function registerIpcHandlers(getWindow: () => BrowserWindow | null): void {
  const sendToRenderer = (channel: string, payload: any) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }

  ptyManager.setOutputCallback((session, data) => {
    let deviceId: string | null = null
    try { deviceId = shared.loadConfig().device_id || null } catch {}
    sendToRenderer("terminal:output", { session, data, deviceId })
  })

  ptyManager.setExitCallback((session) => {
    let deviceId: string | null = null
    try { deviceId = shared.loadConfig().device_id || null } catch {}
    sendToRenderer("terminal:exit", { session, deviceId })
  })

  remote.setOutputCallback((session, data, deviceId) => {
    sendToRenderer("terminal:output", { session, data, deviceId })
  })

  remote.setExitCallback((session, deviceId) => {
    sendToRenderer("terminal:exit", { session, deviceId })
  })

  // --- Config ---

  ipcMain.handle("config:status", async () => {
    return { configured: shared.isConfigured() }
  })


  ipcMain.handle("runtime:getSettings", async () => {
    const login = app.getLoginItemSettings()
    try {
      const config = shared.loadConfig()
      return {
        launch_at_login: login.openAtLogin || !!config.runtime?.launch_at_login,
        persistent_mode: !!config.runtime?.persistent_mode,
        keep_awake: !!config.runtime?.keep_awake,
      }
    } catch {
      return { launch_at_login: login.openAtLogin, persistent_mode: false, keep_awake: false }
    }
  })

  ipcMain.handle("runtime:saveSettings", async (_event: Electron.IpcMainInvokeEvent, runtime: any) => {
    try {
      const config = shared.loadConfig()
      config.runtime = { ...(config.runtime || {}), ...runtime }
      shared.saveConfig(config)
      applyRuntimeSettings(config.runtime || {})
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err?.message || "Failed to save runtime settings" }
    }
  })

  ipcMain.handle("config:getMode", async () => {
    if (!shared.isConfigured()) return { mode: null }
    const config = shared.loadConfig()
    return { mode: config.mode || "host" }
  })

  ipcMain.handle("config:setupHost", async (_event: Electron.IpcMainInvokeEvent, username: string, password: string, port?: number) => {
    try {
      if (shared.isConfigured()) return { success: false, error: "Already configured" }
      const newConfig = shared.createDefaultConfig(username, password, port)
      shared.saveConfig(newConfig)
      currentMode = "host"
      authenticatedUser = username
      startEmbeddedServer(newConfig)
      remote.configure("http://127.0.0.1:" + (newConfig.server?.port || 39488), shared.signToken(newConfig.auth.jwt_secret, username))
      return { success: true, username, server_key: newConfig.auth.server_key }
    } catch (err: any) {
      return { success: false, error: err.message || "Setup failed" }
    }
  })

  ipcMain.handle("config:setupClient", async (_event: Electron.IpcMainInvokeEvent, url: string, serverKey: string, username: string, password: string) => {
    try {
      const connectResult = await remote.clientConnect(url, serverKey, username, password)
      if (!connectResult.success) return { success: false, error: connectResult.error }

      const config = shared.createClientConfig(url, serverKey, username)
      shared.saveConfig(config)
      currentMode = "client"
      authenticatedUser = username

      const savedConfig = shared.loadConfig()
      startHostConnection(
        url,
        connectResult.token!,
        savedConfig.device_id,
        username,
        () => shared.listSessions()
      )

      return { success: true, username }
    } catch (err: any) {
      return { success: false, error: err.message || "Setup failed" }
    }
  })

  ipcMain.handle("config:get", async () => {
    if (!authenticatedUser) return null
    try {
      const config = shared.loadConfig()
      return {
        mode: config.mode,
        server: config.server,
        auth: {
          server_key: config.auth.server_key || "",
          users: config.auth.users.map((u: any) => ({ username: u.username, password: "••••••" })),
        },
        tmux: config.tmux,
        remote: config.remote,
        device_id: config.device_id,
      }
    } catch { return null }
  })

  ipcMain.handle("config:save", async (_event: Electron.IpcMainInvokeEvent, updates: any) => {
    if (!authenticatedUser) return { success: false, error: "Not authenticated" }
    try {
      const config = shared.loadConfig()
      if (updates.server) {
        if (updates.server.port) config.server.port = Number(updates.server.port)
        if (updates.server.host) config.server.host = updates.server.host
      }
      if (updates.auth?.password) {
        const u = config.auth.users.find((u: any) => u.username === authenticatedUser)
        if (u) u.password = shared.hashPassword(updates.auth.password)
      }
      if (updates.tmux) {
        if (updates.tmux.default_shell) config.tmux.default_shell = updates.tmux.default_shell
        if (updates.tmux.session_prefix !== undefined) config.tmux.session_prefix = updates.tmux.session_prefix
      }
      if (updates.remote) {
        config.remote = { ...config.remote, ...updates.remote }
      }
      shared.saveConfig(config)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle("config:reset", async () => {
    try {
      authenticatedUser = null
      ptyManager.detachAll()
      remote.detachAll()
      stopHostConnection()
      stopEmbeddedServer()
      shared.resetConfig()
      app.relaunch()
      app.exit(0)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // --- Auth ---

  ipcMain.handle("auth:login", async (_event: Electron.IpcMainInvokeEvent, username: string, password: string) => {
    if (currentMode === "client") {
      const config = shared.loadConfig()
      if (!config.remote?.url || !config.remote?.server_key) return { success: false, error: "No remote configured" }
      const result = await remote.clientConnect(config.remote.url, config.remote.server_key, username, password)
      if (result.success) {
        authenticatedUser = username
        startHostConnection(
          config.remote.url,
          result.token!,
          config.device_id,
          username,
          () => shared.listSessions()
        )
        return { success: true, username }
      }
      return { success: false, error: result.error }
    }
    const config = shared.loadConfig()
    if (!shared.verifyUser(config.auth, username, password)) {
      return { success: false, error: "Invalid credentials" }
    }
    authenticatedUser = username
    currentMode = config.mode || "host"
    if (currentMode === "host") {
      const token = shared.signToken(config.auth.jwt_secret, username)
      remote.configure("http://127.0.0.1:" + (config.server?.port || 39488), token)
    }
    return { success: true, username }
  })

  ipcMain.handle("auth:check", async () => {
    return { authenticated: authenticatedUser !== null, username: authenticatedUser }
  })

  ipcMain.handle("auth:logout", async () => {
    authenticatedUser = null
    ptyManager.detachAll()
    remote.detachAll()
    stopHostConnection()
  })

  // --- Sessions ---

  ipcMain.handle("sessions:list", async () => {
    if (!authenticatedUser) return []

    if (currentMode === "host") {
      const config = shared.loadConfig()
      const hostDevice = { id: config.device_id, name: os.hostname(), type: "host" }
      const hostSessions = shared.listSessions().map((s: any) => ({
        ...s,
        owner: authenticatedUser,
        device: hostDevice,
      }))
      // Also fetch client sessions from embedded server
      try {
        const http = require("http")
        const port = config.server?.port || 39488
        const token = shared.signToken(config.auth.jwt_secret, authenticatedUser)
        const clientSessions: any[] = await new Promise((resolve) => {
          const req = http.get("http://127.0.0.1:" + port + "/api/sessions", {
            headers: { Authorization: "Bearer " + token }
          }, (res: any) => {
            let data = ""
            res.on("data", (chunk: string) => { data += chunk })
            res.on("end", () => {
              try {
                const parsed = JSON.parse(data)
                const sessions = parsed.sessions || []
                resolve(sessions.filter((s: any) => s.device?.type === "client"))
              } catch { resolve([]) }
            })
          })
          req.on("error", () => resolve([]))
          req.setTimeout(2000, () => { req.destroy(); resolve([]) })
        })
        return [...hostSessions, ...clientSessions]
      } catch {
        return hostSessions
      }
    }

    // Client mode
    try {
      const remoteSessions = await remote.listSessions()
      if (remoteSessions.length > 0) {
        // Merge local sessions not yet synced
        const localSessions = shared.listSessions()
        const config = shared.loadConfig()
        const deviceInfo = { id: config.device_id, name: os.hostname(), type: "client" }
        const remoteNames = new Set(remoteSessions.filter((s: any) => s.device?.id === config.device_id).map((s: any) => s.name))
        const unsyncedLocal = localSessions
          .filter((s: any) => !remoteNames.has(s.name))
          .map((s: any) => ({ ...s, owner: authenticatedUser, device: deviceInfo }))
        return [...remoteSessions, ...unsyncedLocal]
      }
    } catch {}
    const localSessions = shared.listSessions()
    const config = shared.loadConfig()
    const deviceInfo = { id: config.device_id, name: os.hostname(), type: "client" }
    return localSessions.map((s: any) => ({
      ...s,
      owner: authenticatedUser,
      device: deviceInfo,
    }))
  })

  ipcMain.handle("sessions:create", async (_event: Electron.IpcMainInvokeEvent, name: string) => {
    if (!authenticatedUser) return
    shared.createSession(name)
    if (currentMode === "client") triggerSessionSync()
  })

  ipcMain.handle("sessions:kill", async (_event: Electron.IpcMainInvokeEvent, name: string, deviceId?: string | null) => {
    if (!authenticatedUser) return { success: false, error: "Not authenticated" }
    const config = shared.loadConfig()
    const localDeviceId = config.device_id || null
    if (deviceId && deviceId !== localDeviceId) {
      const result = await remote.killSession(name, deviceId)
      remote.detachSession(name, deviceId)
      return result?.error ? { success: false, error: result.error } : { success: true }
    }
    ptyManager.detachSession(name)
    shared.killSession(name)
    if (currentMode === "client") triggerSessionSync()
    return { success: true }
  })

  ipcMain.handle("sessions:reset", async (_event: Electron.IpcMainInvokeEvent, name: string, deviceId?: string | null) => {
    if (!authenticatedUser) return { success: false, error: "Not authenticated" }
    const config = shared.loadConfig()
    const localDeviceId = config.device_id || null
    if (deviceId && deviceId !== localDeviceId) {
      const result = await remote.resetSession(name, deviceId)
      if (!result?.error) remote.detachSession(name, deviceId)
      return result?.error ? { success: false, error: result.error } : { success: true }
    }
    ptyManager.resetSession(name)
    if (currentMode === "client") triggerSessionSync()
    return { success: true }
  })

  // --- Terminal ---

  ipcMain.handle("terminal:attach", async (_event: Electron.IpcMainInvokeEvent, name: string, cols?: number, rows?: number, deviceId?: string | null) => {
    if (!authenticatedUser) return
    try {
      const config = shared.loadConfig()
      const localDeviceId = config.device_id || null
      if (deviceId && deviceId !== localDeviceId) {
        if (currentMode === "host" && !remote.isConnected()) {
          remote.configure("http://127.0.0.1:" + (config.server?.port || 39488), shared.signToken(config.auth.jwt_secret, authenticatedUser))
        }
        return remote.attachSession(name, cols, rows, deviceId)
      }
      ptyManager.attachSession(name, cols, rows)
    } catch (err: any) {
      console.error("terminal:attach error:", err)
      throw new Error(err?.message || "Failed to attach terminal")
    }
  })

  ipcMain.handle("terminal:detach", async (_event: Electron.IpcMainInvokeEvent, name: string, deviceId?: string | null) => {
    const localDeviceId = (() => { try { return shared.loadConfig().device_id || null } catch { return null } })()
    if (deviceId && deviceId !== localDeviceId) remote.detachSession(name, deviceId)
    else ptyManager.detachSession(name)
  })

  ipcMain.on("terminal:input", (_event: Electron.IpcMainEvent, session: string, data: string, deviceId?: string | null) => {
    if (!authenticatedUser) return
    const localDeviceId = (() => { try { return shared.loadConfig().device_id || null } catch { return null } })()
    if (deviceId && deviceId !== localDeviceId) { remote.writeToPty(session, data, deviceId); return }
    ptyManager.writeToPty(session, data)
  })

  ipcMain.on("terminal:resize", (_event: Electron.IpcMainEvent, session: string, cols: number, rows: number, deviceId?: string | null) => {
    const localDeviceId = (() => { try { return shared.loadConfig().device_id || null } catch { return null } })()
    if (deviceId && deviceId !== localDeviceId) { remote.resizePty(session, cols, rows, deviceId); return }
    ptyManager.resizePty(session, cols, rows)
  })

  ipcMain.on("terminal:scroll", (_event: Electron.IpcMainEvent, session: string, lines: number, deviceId?: string | null) => {
    if (!authenticatedUser) return
    const localDeviceId = (() => { try { return shared.loadConfig().device_id || null } catch { return null } })()
    if (deviceId && deviceId !== localDeviceId) { remote.scrollPty(session, lines, deviceId); return }
    ptyManager.scrollPty(session, lines)
  })
}
