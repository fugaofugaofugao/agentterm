import WebSocket from "ws"
import * as pty from "node-pty"
import { IPty } from "node-pty"
import * as os from "os"
import { createSession, getTmuxEnv, getTmuxPath, killSession, resetSessionFresh, scrollSessionPane, exitSessionCopyMode } from "@agentterm/shared"
import { resetSession as resetLocalPtySession } from "./pty-manager"

const tmuxPath = getTmuxPath()

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
const relaySizes = new Map<string, { cols: number; rows: number }>()
const suppressRelayExit = new Set<string>()
const recentRelayInputs = new Map<string, { data: string; at: number }>()

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
  if (relayPtys.has(sessionName)) return

  let term: IPty
  try {
    term = pty.spawn(tmuxPath, ["new-session", "-A", "-s", sessionName], {
    name: "xterm-256color",
    cols: cols || 80,
    rows: rows || 24,
    cwd: process.env.HOME || "/",
    env: getTmuxEnv({ TERM: "xterm-256color" }),
    })
  } catch (err: any) {
    send({ type: "relay-output", sessionName, data: `\r\n\x1b[31mFailed to attach relay tmux session: ${err?.message || err} (tmux: ${tmuxPath})\x1b[0m\r\n` })
    send({ type: "relay-exit", sessionName })
    return
  }

  relayPtys.set(sessionName, term)


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
  const term = relayPtys.get(sessionName)
  if (term) {
    term.kill()
    relayPtys.delete(sessionName)
  }
}

function shouldDropDuplicateInput(map: Map<string, { data: string; at: number }>, sessionName: string, data: string): boolean { return false }

function handleRelayInput(sessionName: string, data: string): void {
  if (relayPtys.has(sessionName)) exitSessionCopyMode(sessionName)
  relayPtys.get(sessionName)?.write(data)
}

function handleRelayResize(sessionName: string, cols: number, rows: number): void {
  relayPtys.get(sessionName)?.resize(cols, rows)
}

function handleRelayScroll(sessionName: string, lines: number): void {
  if (relayPtys.has(sessionName)) scrollSessionPane(sessionName, lines)
}

function handleRelayCreate(sessionName: string): void {
  createSession(sessionName)
  syncSessions()
}

function handleRelayKill(sessionName: string): void {
  handleRelayDetach(sessionName)
  killSession(sessionName)
  syncSessions()
}

function handleRelayReset(sessionName: string): void {
  handleRelayDetach(sessionName)
  send({ type: "relay-clear", sessionName })
  resetSessionFresh(sessionName)
  syncSessions()
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
