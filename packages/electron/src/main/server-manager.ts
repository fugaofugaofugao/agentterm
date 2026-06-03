import http from "http"
import { getBundledTerminfoPath, getTmuxPath } from "@termsync/shared"

let serverHandle: { server: http.Server; close: () => void } | null = null

export function startEmbeddedServer(config: any): void {
  if (serverHandle) return
  process.env.TMUX_PATH = process.env.TMUX_PATH || getTmuxPath()
  const bundledTerminfo = getBundledTerminfoPath()
  if (bundledTerminfo) {
    process.env.TERMINFO = bundledTerminfo
    process.env.TERMINFO_DIRS = bundledTerminfo
  }
  const { startServer } = require("@termsync/server")
  serverHandle = startServer(config)
  console.log("Embedded server started")
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
