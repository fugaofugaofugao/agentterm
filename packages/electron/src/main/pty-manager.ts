import * as pty from "node-pty"
import { IPty } from "node-pty"
import * as fs from "fs"
import * as path from "path"
import { getTmuxEnv, getTmuxPath as resolveTmuxPath, resetSessionFresh, scrollSessionPane, exitSessionCopyMode, sessionExists, createSession, clearSessionHistory, getSessionScrollState, configureAgentTermSession } from "@agentterm/shared"

const sessions = new Map<string, IPty>()
const sessionSizes = new Map<string, { cols: number; rows: number }>()
const suppressExit = new Set<string>()
const recentInputs = new Map<string, { data: string; at: number }>()
const freshSessions = new Set<string>()
const tmuxPath = resolveTmuxPath()

function getWindowsShell(): { file: string; args: string[] } {
  const systemRoot = process.env.SystemRoot || "C:\\Windows"
  const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  return { file: process.env.AGENTTERM_WINDOWS_SHELL || powershell, args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass"] }
}

function getDefaultCwd(): string {
  return process.env.USERPROFILE || process.env.HOME || process.cwd()
}

function logPtyError(message: string): void {
  if (process.platform !== "win32") return
  try {
    const base = process.env.APPDATA || path.join(getDefaultCwd(), "AppData", "Roaming")
    const dir = path.join(base, "agentterm", "logs")
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, "main.log"), `[${new Date().toISOString()}] ${message}\n`, "utf-8")
  } catch {}
}

export type OutputCallback = (session: string, data: string) => void
export type ExitCallback = (session: string) => void
export type ScrollStateCallback = (session: string, state: any) => void

let onOutput: OutputCallback = () => {}
let onExit: ExitCallback = () => {}
let onScrollState: ScrollStateCallback = () => {}
const outputListeners = new Set<OutputCallback>()
const exitListeners = new Set<ExitCallback>()

function emitOutput(session: string, data: string): void {
  onOutput(session, data)
  for (const cb of outputListeners) cb(session, data)
}

function emitExit(session: string): void {
  onExit(session)
  for (const cb of exitListeners) cb(session)
}

export function setOutputCallback(cb: OutputCallback): void { onOutput = cb }
export function setExitCallback(cb: ExitCallback): void { onExit = cb }
export function setScrollStateCallback(cb: ScrollStateCallback): void { onScrollState = cb }
export function addOutputListener(cb: OutputCallback): () => void { outputListeners.add(cb); return () => outputListeners.delete(cb) }
export function addExitListener(cb: ExitCallback): () => void { exitListeners.add(cb); return () => exitListeners.delete(cb) }
export function getTmuxPath(): string { return tmuxPath }

function shouldDropDuplicateInput(sessionName: string, data: string): boolean { return false
}

export function attachSession(sessionName: string, cols = 80, rows = 24): void {
  sessionSizes.set(sessionName, { cols, rows })
  if (sessions.has(sessionName)) return

  try {
    if (!sessionExists(sessionName)) {
      createSession(sessionName, undefined, cols, rows)
      freshSessions.add(sessionName)
    }
    if (process.platform !== "win32") configureAgentTermSession(sessionName)
    const command = process.platform === "win32"
      ? getWindowsShell()
      : { file: tmuxPath, args: ["new-session", "-A", "-s", sessionName] }
    const term = pty.spawn(command.file, command.args, {
      name: "xterm-256color",
      cols, rows,
      cwd: getDefaultCwd(),
      env: getTmuxEnv({ TERM: "xterm-256color" }),
    })

    sessions.set(sessionName, term)
    onScrollState(sessionName, getSessionScrollState(sessionName))
    if (freshSessions.has(sessionName)) {
      setTimeout(() => {
        if (sessions.get(sessionName) === term) {
          clearSessionHistory(sessionName)
          onScrollState(sessionName, getSessionScrollState(sessionName))
        }
        freshSessions.delete(sessionName)
      }, 200)
    }
    term.onData((data: string) => { if (sessions.get(sessionName) === term) emitOutput(sessionName, data) })
    term.onExit(({ exitCode, signal }) => {
      console.log(`pty exit: session=${sessionName} code=${exitCode} signal=${signal} tmux=${tmuxPath}`)
      if (sessions.get(sessionName) !== term && !suppressExit.has(sessionName)) return
      if (sessions.get(sessionName) === term) sessions.delete(sessionName)
      if (suppressExit.delete(sessionName)) return
      onOutput(sessionName, `\r\n\x1b[33mSession ended (exit ${exitCode}, signal ${signal || "none"}).\x1b[0m\r\n`)
      onExit(sessionName)
    })
    console.log(`pty spawned: session=${sessionName} pid=${term.pid} tmux=${tmuxPath}`)
    logPtyError(`spawned session=${sessionName} pid=${term.pid}`)
  } catch (err: any) {
    console.error(`pty spawn failed: session=${sessionName} tmux=${tmuxPath}`, err)
    logPtyError(`spawn failed session=${sessionName}: ${err?.stack || err?.message || err}`)
    throw new Error(`${err?.message || err} (tmux: ${tmuxPath})`)
  }
}
export function detachSession(sessionName: string): void {
  const term = sessions.get(sessionName)
  if (term) { term.kill(); sessions.delete(sessionName) }
}

export function writeToPty(sessionName: string, data: string): void {
  if (shouldDropDuplicateInput(sessionName, data)) return
  if (process.platform !== "win32" && sessions.has(sessionName)) exitSessionCopyMode(sessionName)
  sessions.get(sessionName)?.write(data)
  onScrollState(sessionName, getSessionScrollState(sessionName))
}

export function resizePty(sessionName: string, cols: number, rows: number): void {
  sessionSizes.set(sessionName, { cols, rows })
  sessions.get(sessionName)?.resize(cols, rows)
}

export function scrollPty(sessionName: string, lines: number): void {
  if (sessions.has(sessionName)) {
    scrollSessionPane(sessionName, lines)
    onScrollState(sessionName, getSessionScrollState(sessionName))
  }
}

export function resetSession(sessionName: string): void {
  const size = sessionSizes.get(sessionName)
  emitOutput(sessionName, "[3J[2J[H")
  detachSession(sessionName)
  resetSessionFresh(sessionName, undefined, size?.cols, size?.rows)
  freshSessions.add(sessionName)
  if (process.platform === "win32") attachSession(sessionName, size?.cols, size?.rows)
}

export function detachAll(): void {
  for (const [, term] of sessions) term.kill()
  sessions.clear()
}

export function isAttached(sessionName: string): boolean {
  return sessions.has(sessionName)
}
