import WebSocket from "ws"
import * as pty from "node-pty"
import { IPty } from "node-pty"
import * as os from "os"
import * as path from "path"
import { createSession, getTmuxEnv, getTmuxPath, killSession, resetSessionFresh, scrollSessionPane, exitSessionCopyMode, sessionExists, clearSessionHistory, getSessionScrollState, configureAgentTermSession } from "@agentterm/shared"
import { resetSession as resetLocalPtySession, attachSession as attachLocalPtySession, writeToPty as writeToLocalPty, resizePty as resizeLocalPty, scrollPty as scrollLocalPty, addOutputListener as addLocalOutputListener, addExitListener as addLocalExitListener } from "./pty-manager"

const tmuxPath = getTmuxPath()

function getWindowsShell(): { file: string; args: string[] } {
  const systemRoot = process.env.SystemRoot || "C:\\Windows"
  const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  return { file: process.env.AGENTTERM_WINDOWS_SHELL || powershell, args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass"] }
}

function getDefaultCwd(): string {
  return process.env.USERPROFILE || process.env.HOME || process.cwd()
}

interface HostConnectionConfig {
  url: string
  token: string
  deviceId: string
  deviceName: string
  username: string
}

type SessionListProvider = () => any[]

let ws: WebSocket | null = null
let config: HostConnectionConfig | null = null
let sessionListProvider: SessionListProvider = () => []
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let syncTimer: ReturnType<typeof setInterval> | null = null
const relayPtys = new Map<string, IPty>()
const relayLocalPtys = new Set<string>()
const relayLocalCleanups = new Map<string, Array<() => void>>()
const relaySizes = new Map<string, { cols: number; rows: number }>()
const suppressRelayExit = new Set<string>()
const recentRelayInputs = new Map<string, { data: string; at: number }>()
const freshRelaySessions = new Set<string>()

function send(msg: any): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

function syncSessions(): void {
  const sessions = sessionListProvider()
  const deviceInfo = config ? { id: config.deviceId, name: config.deviceName, type: "client" as const } : undefined
  const enriched = sessions.map((s: any) => ({
    ...s,
    attached: true,
    owner: config?.username || "",
    device: deviceInfo,
  }))
  send({ type: "session-sync", sessions: enriched })
}

function handleRelayAttach(sessionName: string, cols: number, rows: number): void {
  relaySizes.set(sessionName, { cols: cols || 80, rows: rows || 24 })
  if (relayPtys.has(sessionName) || relayLocalPtys.has(sessionName)) return

  if (process.platform === "win32") {
    try {
      if (!sessionExists(sessionName)) {
        createSession(sessionName, undefined, cols || 80, rows || 24)
        freshRelaySessions.add(sessionName)
      }
      relayLocalPtys.add(sessionName)
      attachLocalPtySession(sessionName, cols || 80, rows || 24)
      const removeOutput = addLocalOutputListener((session, data) => {
        if (session === sessionName && relayLocalPtys.has(sessionName)) send({ type: "relay-output", sessionName, data })
      })
      const removeExit = addLocalExitListener((session) => {
        if (session !== sessionName || !relayLocalPtys.has(sessionName)) return
        relayLocalPtys.delete(sessionName)
        relayLocalCleanups.get(sessionName)?.forEach((cleanup) => cleanup())
        relayLocalCleanups.delete(sessionName)
        send({ type: "relay-exit", sessionName })
      })
      relayLocalCleanups.set(sessionName, [removeOutput, removeExit])
      sendRelayScrollState(sessionName)
    } catch (err: any) {
      send({ type: "relay-output", sessionName, data: `
[31mFailed to attach relay PowerShell session: ${err?.message || err}[0m
` })
      send({ type: "relay-exit", sessionName })
    }
    return
  }

  let term: IPty
  try {
    if (!sessionExists(sessionName)) {
      createSession(sessionName, undefined, cols || 80, rows || 24)
      freshRelaySessions.add(sessionName)
    }
    if (process.platform !== "win32") configureAgentTermSession(sessionName)
    const command = process.platform === "win32"
      ? getWindowsShell()
      : { file: tmuxPath, args: ["new-session", "-A", "-s", sessionName] }
    term = pty.spawn(command.file, command.args, {
    name: "xterm-256color",
    cols: cols || 80,
    rows: rows || 24,
    cwd: getDefaultCwd(),
    env: getTmuxEnv({ TERM: "xterm-256color" }),
    })
  } catch (err: any) {
    send({ type: "relay-output", sessionName, data: `\r\n\x1b[31mFailed to attach relay tmux session: ${err?.message || err} (tmux: ${tmuxPath})\x1b[0m\r\n` })
    send({ type: "relay-exit", sessionName })
    return
  }

  relayPtys.set(sessionName, term)


  sendRelayScrollState(sessionName)

  term.onData((data: string) => {
    if (relayPtys.get(sessionName) === term) send({ type: "relay-output", sessionName, data })
  })

  term.onExit(() => {
    if (relayPtys.get(sessionName) !== term && !suppressRelayExit.has(sessionName)) return
    if (relayPtys.get(sessionName) === term) relayPtys.delete(sessionName)
    if (suppressRelayExit.delete(sessionName)) return
    send({ type: "relay-exit", sessionName })
  })
}

function handleRelayDetach(sessionName: string): void {
  if (relayLocalPtys.delete(sessionName)) {
    relayLocalCleanups.get(sessionName)?.forEach((cleanup) => cleanup())
    relayLocalCleanups.delete(sessionName)
    return
  }
  const term = relayPtys.get(sessionName)
  if (term) {
    term.kill()
    relayPtys.delete(sessionName)
  }
}

function shouldDropDuplicateInput(map: Map<string, { data: string; at: number }>, sessionName: string, data: string): boolean { return false }

function sendRelayScrollState(sessionName: string): void {
  send({ type: "relay-scroll-state", sessionName, ...getSessionScrollState(sessionName) })
}

function handleRelayInput(sessionName: string, data: string): void {
  if (relayLocalPtys.has(sessionName)) { writeToLocalPty(sessionName, data); return }
  if (process.platform !== "win32" && relayPtys.has(sessionName)) exitSessionCopyMode(sessionName)
  relayPtys.get(sessionName)?.write(data)
  sendRelayScrollState(sessionName)
}

function handleRelayResize(sessionName: string, cols: number, rows: number): void {
  if (relayLocalPtys.has(sessionName)) { resizeLocalPty(sessionName, cols, rows); return }
  relayPtys.get(sessionName)?.resize(cols, rows)
}

function handleRelayScroll(sessionName: string, lines: number): void {
  if (relayLocalPtys.has(sessionName)) { scrollLocalPty(sessionName, lines); return }
  if (relayPtys.has(sessionName)) {
    scrollSessionPane(sessionName, lines)
    sendRelayScrollState(sessionName)
  }
}

function handleRelayCreate(sessionName: string): void {
  createSession(sessionName)
  syncSessions()
  sendRelayScrollState(sessionName)
}

function handleRelayKill(sessionName: string): void {
  handleRelayDetach(sessionName)
  killSession(sessionName)
  syncSessions()
}

function handleRelayReset(sessionName: string): void {
  const size = relaySizes.get(sessionName)
  handleRelayDetach(sessionName)
  send({ type: "relay-clear", sessionName })
  if (process.platform === "win32") {
    resetLocalPtySession(sessionName)
    createSession(sessionName)
  } else {
    resetSessionFresh(sessionName, undefined, size?.cols, size?.rows)
    freshRelaySessions.add(sessionName)
  }
  syncSessions()
  sendRelayScrollState(sessionName)
}

function connect(): void {
  if (!config) return

  const wsUrl = config.url.replace(/^http/, "ws") + `/ws?token=${config.token}&role=client-relay`
  ws = new WebSocket(wsUrl)

  ws.on("open", () => {
    console.log("Host connection established")
    send({
      type: "client-hello",
      deviceId: config!.deviceId,
      deviceName: config!.deviceName,
      username: config!.username,
    })
    syncSessions()
    if (syncTimer) clearInterval(syncTimer)
    syncTimer = setInterval(syncSessions, 10000)
  })

  ws.on("message", (raw: Buffer | string) => {
    try {
      const msg = JSON.parse(raw.toString())
      switch (msg.type) {
        case "relay-attach":
          handleRelayAttach(msg.sessionName, msg.cols, msg.rows)
          break
        case "relay-detach":
          handleRelayDetach(msg.sessionName)
          break
        case "relay-input":
          handleRelayInput(msg.sessionName, msg.data)
          break
        case "relay-resize":
          handleRelayResize(msg.sessionName, msg.cols, msg.rows)
          break
        case "relay-scroll":
          handleRelayScroll(msg.sessionName, msg.lines)
          break
        case "relay-create":
          handleRelayCreate(msg.sessionName)
          break
        case "relay-kill":
          handleRelayKill(msg.sessionName)
          break
        case "relay-reset":
          handleRelayReset(msg.sessionName)
          break
        case "session-sync-request":
          syncSessions()
          break
        case "pong":
          break
      }
    } catch {}
  })

  ws.on("close", () => {
    console.log("Host connection closed, reconnecting in 5s...")
    cleanup(false)
    reconnectTimer = setTimeout(connect, 5000)
  })

  ws.on("error", (err) => {
    console.error("Host connection error:", err.message)
  })
}

function cleanup(full: boolean): void {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null }
  for (const cleanups of relayLocalCleanups.values()) cleanups.forEach((cleanup) => cleanup())
  relayLocalCleanups.clear()
  relayLocalPtys.clear()
  for (const [, term] of relayPtys) term.kill()
  relayPtys.clear()
  if (full) {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
    if (ws) { ws.close(); ws = null }
    config = null
  }
}

export function startHostConnection(
  url: string,
  token: string,
  deviceId: string,
  username: string,
  getLocalSessions: SessionListProvider
): void {
  cleanup(true)
  config = {
    url: url.replace(/\/$/, ""),
    token,
    deviceId,
    deviceName: os.hostname(),
    username,
  }
  sessionListProvider = getLocalSessions
  connect()
}

export function stopHostConnection(): void {
  cleanup(true)
}

export function isHostConnected(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN
}

export function triggerSessionSync(): void {
  syncSessions()
}
