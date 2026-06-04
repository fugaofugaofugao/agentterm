import http from "http"
import { getBundledTerminfoPath, getTmuxPath } from "@agentterm/shared"
import * as ptyManager from "./pty-manager"

let serverHandle: { server: http.Server; close: () => void } | null = null

export function startEmbeddedServer(config: any): void {
  if (serverHandle) return
  try {
    process.env.TMUX_PATH = process.env.TMUX_PATH || getTmuxPath()
    const bundledTerminfo = getBundledTerminfoPath()
    if (bundledTerminfo) {
      process.env.TERMINFO = bundledTerminfo
      process.env.TERMINFO_DIRS = bundledTerminfo
    }
    const { startServer } = require("@agentterm/server")
    serverHandle = startServer(config, process.platform === "win32" ? { localTerminalAdapter: ptyManager } : {})
    console.log("Embedded server started")
  } catch (err) {
    console.error("Embedded server failed to start", err)
  }
}

export function stopEmbeddedServer(): void {
  if (serverHandle) {
    serverHandle.close()
    serverHandle = null
    console.log("Embedded server stopped")
  }
}

export function isServerRunning(): boolean {
  return serverHandle !== null
}
