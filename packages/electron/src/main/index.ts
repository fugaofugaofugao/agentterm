import { app, BrowserWindow, shell, powerSaveBlocker } from "electron"
import { join } from "path"
import { registerIpcHandlers } from "./ipc"
import { detachAll } from "./pty-manager"
import { startEmbeddedServer, stopEmbeddedServer } from "./server-manager"
import { stopHostConnection } from "./host-connection"

const shared = require("@agentterm/shared")

let mainWindow: BrowserWindow | null = null
let powerBlockerId: number | null = null

function applyRuntimeSettings(): void {
  try {
    if (!shared.isConfigured()) return
    const config = shared.loadConfig()
    const runtime = config.runtime || {}
    app.setLoginItemSettings({ openAtLogin: !!runtime.launch_at_login })
    if (runtime.keep_awake) {
      if (powerBlockerId === null) powerBlockerId = powerSaveBlocker.start("prevent-app-suspension")
    } else if (powerBlockerId !== null) {
      powerSaveBlocker.stop(powerBlockerId)
      powerBlockerId = null
    }
  } catch {}
}

export function refreshRuntimeSettings(): void { applyRuntimeSettings() }

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#1a1a2e",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: "deny" }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"))
  }

  mainWindow.on("close", (event) => {
    try {
      const runtime = shared.isConfigured() ? (shared.loadConfig().runtime || {}) : {}
      if (runtime.persistent_mode && !app.isQuitting) {
        event.preventDefault()
        mainWindow?.hide()
      }
    } catch {}
  })

  mainWindow.on("closed", () => {
    mainWindow = null
  })
}

registerIpcHandlers(() => mainWindow)

app.whenReady().then(() => {
  applyRuntimeSettings()
  if (shared.isConfigured()) {
    const config = shared.loadConfig()
    if (config.mode === "host") {
      startEmbeddedServer(config)
    }
  }

  createWindow()

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit()
  }
})

app.on("before-quit", () => {
  ;(app as any).isQuitting = true
  detachAll()
  stopEmbeddedServer()
  stopHostConnection()
})
