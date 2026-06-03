import * as pty from "node-pty"
import { IPty } from "node-pty"
import { getTmuxEnv, getTmuxPath as resolveTmuxPath, resetSessionFresh, scrollSessionPane, exitSessionCopyMode, sessionExists, createSession, clearSessionHistory } from "@agentterm/shared"

const sessions = new Map<string, IPty>()
const sessionSizes = new Map<string, { cols: number; rows: number }>()
const suppressExit = new Set<string>()
const recentInputs = new Map<string, { data: string; at: number }>()
const freshSessions = new Set<string>()
const tmuxPath = resolveTmuxPath()

export type OutputCallback = (session: string, data: string) => void
export type ExitCallback = (session: string) => void

let onOutput: OutputCallback = () => {}
let onExit: ExitCallback = () => {}

export function setOutputCallback(cb: OutputCallback): void { onOutput = cb }
export function setExitCallback(cb: ExitCallback): void { onExit = cb }
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
    const term = pty.spawn(tmuxPath, ["new-session", "-A", "-s", sessionName], {
      name: "xterm-256color",
      cols, rows,
      cwd: process.env.HOME || "/",
      env: getTmuxEnv({ TERM: "xterm-256color" }),
    })

    sessions.set(sessionName, term)
    if (freshSessions.has(sessionName)) {
      setTimeout(() => {
        if (sessions.get(sessionName) === term) clearSessionHistory(sessionName)
        freshSessions.delete(sessionName)
      }, 200)
    }
    term.onData((data: string) => { if (sessions.get(sessionName) === term) onOutput(sessionName, data) })
    term.onExit(({ exitCode, signal }) => {
      console.log(`pty exit: session=${sessionName} code=${exitCode} signal=${signal} tmux=${tmuxPath}`)
      if (sessions.get(sessionName) !== term && !suppressExit.has(sessionName)) return
      if (sessions.get(sessionName) === term) sessions.delete(sessionName)
      if (suppressExit.delete(sessionName)) return
      onOutput(sessionName, `\r\n\x1b[33mSession ended (exit ${exitCode}, signal ${signal || "none"}).\x1b[0m\r\n`)
      onExit(sessionName)
    })
    console.log(`pty spawned: session=${sessionName} pid=${term.pid} tmux=${tmuxPath}`)
  } catch (err: any) {
    console.error(`pty spawn failed: session=${sessionName} tmux=${tmuxPath}`, err)
    throw new Error(`${err?.message || err} (tmux: ${tmuxPath})`)
  }
}
export function detachSession(sessionName: string): void {
  const term = sessions.get(sessionName)
  if (term) { term.kill(); sessions.delete(sessionName) }
}

export function writeToPty(sessionName: string, data: string): void {
  if (shouldDropDuplicateInput(sessionName, data)) return
  if (sessions.has(sessionName)) exitSessionCopyMode(sessionName)
  sessions.get(sessionName)?.write(data)
}

export function resizePty(sessionName: string, cols: number, rows: number): void {
  sessionSizes.set(sessionName, { cols, rows })
  sessions.get(sessionName)?.resize(cols, rows)
}

export function scrollPty(sessionName: string, lines: number): void {
  if (sessions.has(sessionName)) scrollSessionPane(sessionName, lines)
}

export function resetSession(sessionName: string): void {
  onOutput(sessionName, "[3J[2J[H")
  detachSession(sessionName)
  resetSessionFresh(sessionName)
}

export function detachAll(): void {
  for (const [, term] of sessions) term.kill()
  sessions.clear()
}

export function isAttached(sessionName: string): boolean {
  return sessions.has(sessionName)
}
