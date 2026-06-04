import * as pty from "node-pty"
import { IPty } from "node-pty"
import * as fs from "fs"
import * as path from "path"
import { getTmuxEnv, getTmuxPath as resolveTmuxPath, resetSessionFresh, scrollSessionPane, exitSessionCopyMode, sessionExists, createSession, clearSessionHistory, getSessionScrollState, configureAgentTermSession } from "@agentterm/shared"

const sessions = new Map<string, IPty>()
const sessionSizeRevisions = new Map<string, number>()
const sessionOwners = new Map<string, Set<string>>()
const sessionSizes = new Map<string, { cols: number; rows: number }>()
const suppressExit = new Set<string>()
const recentInputs = new Map<string, { data: string; at: number }>()
const freshSessions = new Set<string>()
const outputHistory = new Map<string, string[]>()
const MAX_HISTORY_CHUNKS = 5000
const MAX_HISTORY_CHARS = 4_000_000
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
export type ClearCallback = (session: string) => void
export type SizeCallback = (session: string, size: { cols: number; rows: number; revision?: number; source?: string }) => void
export interface AttachOptions { resize?: boolean; source?: string }

let onOutput: OutputCallback = () => {}
let onExit: ExitCallback = () => {}
let onScrollState: ScrollStateCallback = () => {}
let onClear: ClearCallback = () => {}
let onSize: SizeCallback = () => {}
const sizeListeners = new Set<SizeCallback>()
const outputListeners = new Set<OutputCallback>()
const exitListeners = new Set<ExitCallback>()
const clearListeners = new Set<ClearCallback>()

function rememberOutput(session: string, data: string): void {
  if (process.platform !== "win32" || !data) return
  let chunks = outputHistory.get(session)
  if (!chunks) { chunks = []; outputHistory.set(session, chunks) }
  chunks.push(data)
  let total = 0
  for (let i = chunks.length - 1; i >= 0; i--) {
    total += chunks[i].length
    if (total > MAX_HISTORY_CHARS || chunks.length - i > MAX_HISTORY_CHUNKS) {
      chunks.splice(0, i + 1)
      break
    }
  }
}

function clearOutputHistory(session: string): void {
  outputHistory.delete(session)
}

function emitOutput(session: string, data: string): void {
  rememberOutput(session, data)
  onOutput(session, data)
  for (const cb of outputListeners) cb(session, data)
}

function emitExit(session: string): void {
  onExit(session)
  for (const cb of exitListeners) cb(session)
}

function emitClear(session: string): void {
  onClear(session)
  for (const cb of clearListeners) cb(session)
}

export function setOutputCallback(cb: OutputCallback): void { onOutput = cb }
export function setExitCallback(cb: ExitCallback): void { onExit = cb }
export function setScrollStateCallback(cb: ScrollStateCallback): void { onScrollState = cb }
export function setClearCallback(cb: ClearCallback): void { onClear = cb }
export function addOutputListener(cb: OutputCallback): () => void { outputListeners.add(cb); return () => outputListeners.delete(cb) }
export function addExitListener(cb: ExitCallback): () => void { exitListeners.add(cb); return () => exitListeners.delete(cb) }
export function addClearListener(cb: ClearCallback): () => void { clearListeners.add(cb); return () => clearListeners.delete(cb) }
export function setSizeCallback(cb: SizeCallback): void { onSize = cb }
export function addSizeListener(cb: SizeCallback): () => void { sizeListeners.add(cb); return () => sizeListeners.delete(cb) }
function emitSize(session: string, size: { cols: number; rows: number; revision?: number; source?: string }): void {
  onSize(session, size)
  for (const cb of sizeListeners) cb(session, size)
}
export function getBufferedOutput(sessionName: string): string { return (outputHistory.get(sessionName) || []).join("") }
export function getTmuxPath(): string { return tmuxPath }

function shouldDropDuplicateInput(sessionName: string, data: string): boolean { return false
}

function addSessionOwner(sessionName: string, owner: string): void {
  let owners = sessionOwners.get(sessionName)
  if (!owners) { owners = new Set<string>(); sessionOwners.set(sessionName, owners) }
  owners.add(owner)
}

function removeSessionOwner(sessionName: string, owner: string): number {
  const owners = sessionOwners.get(sessionName)
  if (!owners) return 0
  owners.delete(owner)
  if (owners.size === 0) sessionOwners.delete(sessionName)
  return owners.size
}

function restoreOwners(sessionName: string, owners: Set<string> | undefined): void {
  if (owners && owners.size) sessionOwners.set(sessionName, new Set(owners))
}

function nextSizeRevision(sessionName: string): number {
  const next = (sessionSizeRevisions.get(sessionName) || 0) + 1
  sessionSizeRevisions.set(sessionName, next)
  return next
}

function normalizeSize(cols?: number, rows?: number): { cols: number; rows: number } {
  return {
    cols: Math.max(20, Math.trunc(Number(cols) || 80)),
    rows: Math.max(5, Math.trunc(Number(rows) || 24)),
  }
}

export function attachSession(sessionName: string, cols = 80, rows = 24, owner = "default", options: AttachOptions = {}): void {
  const shouldResize = options.resize !== false
  const requestedSize = normalizeSize(cols, rows)
  addSessionOwner(sessionName, owner)
  if (sessions.has(sessionName)) {
    if (shouldResize) {
      const current = sessionSizes.get(sessionName)
      sessionSizes.set(sessionName, requestedSize)
      try { sessions.get(sessionName)?.resize(requestedSize.cols, requestedSize.rows) } catch {}
      if (!current || current.cols !== requestedSize.cols || current.rows !== requestedSize.rows) emitSize(sessionName, { ...requestedSize, revision: nextSizeRevision(sessionName), source: options.source })
    }
    return
  }
  sessionSizes.set(sessionName, requestedSize)
  emitSize(sessionName, { ...requestedSize, revision: nextSizeRevision(sessionName), source: options.source })

  try {
    if (!sessionExists(sessionName)) {
      createSession(sessionName, undefined, requestedSize.cols, requestedSize.rows)
      freshSessions.add(sessionName)
    }
    if (process.platform !== "win32") configureAgentTermSession(sessionName)
    const command = process.platform === "win32"
      ? getWindowsShell()
      : { file: tmuxPath, args: ["new-session", "-A", "-s", sessionName] }
    const term = pty.spawn(command.file, command.args, {
      name: "xterm-256color",
      cols: requestedSize.cols, rows: requestedSize.rows,
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
      emitOutput(sessionName, `\r\n\x1b[33mSession ended (exit ${exitCode}, signal ${signal || "none"}).\x1b[0m\r\n`)
      emitExit(sessionName)
    })
    console.log(`pty spawned: session=${sessionName} pid=${term.pid} tmux=${tmuxPath}`)
    logPtyError(`spawned session=${sessionName} pid=${term.pid}`)
  } catch (err: any) {
    console.error(`pty spawn failed: session=${sessionName} tmux=${tmuxPath}`, err)
    logPtyError(`spawn failed session=${sessionName}: ${err?.stack || err?.message || err}`)
    throw new Error(`${err?.message || err} (tmux: ${tmuxPath})`)
  }
}
export function detachSession(sessionName: string, owner = "default"): void {
  if (removeSessionOwner(sessionName, owner) > 0) return
  forceDetachSession(sessionName)
}

export function forceDetachSession(sessionName: string): void {
  sessionOwners.delete(sessionName)
  clearOutputHistory(sessionName)
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
  const size = normalizeSize(cols, rows)
  const current = sessionSizes.get(sessionName)
  sessionSizes.set(sessionName, size)
  sessions.get(sessionName)?.resize(size.cols, size.rows)
  if (!current || current.cols !== size.cols || current.rows !== size.rows) emitSize(sessionName, { ...size, revision: nextSizeRevision(sessionName) })
}

export function hasSessionOwner(sessionName: string, ownerPrefix: string): boolean {
  const owners = sessionOwners.get(sessionName)
  if (!owners) return false
  for (const owner of owners) {
    if (owner === ownerPrefix || owner.startsWith(ownerPrefix)) return true
  }
  return false
}

export function getSessionSize(sessionName: string): { cols: number; rows: number; revision?: number } | undefined {
  const size = sessionSizes.get(sessionName)
  return size ? { ...size, revision: sessionSizeRevisions.get(sessionName) || 0 } : undefined
}

export function scrollPty(sessionName: string, lines: number): void {
  if (sessions.has(sessionName)) {
    scrollSessionPane(sessionName, lines)
    onScrollState(sessionName, getSessionScrollState(sessionName))
  }
}

export function resetSession(sessionName: string): void {
  const size = sessionSizes.get(sessionName)
  const owners = sessionOwners.get(sessionName) ? new Set(sessionOwners.get(sessionName)) : undefined
  clearOutputHistory(sessionName)
  emitClear(sessionName)
  forceDetachSession(sessionName)
  resetSessionFresh(sessionName, undefined, size?.cols, size?.rows)
  freshSessions.add(sessionName)
  restoreOwners(sessionName, owners)
  if (process.platform === "win32" && owners && owners.size) {
    attachSession(sessionName, size?.cols, size?.rows, Array.from(owners)[0] || "default")
    restoreOwners(sessionName, owners)
  }
}

export function detachAll(): void {
  for (const [, term] of sessions) term.kill()
  sessions.clear()
  sessionOwners.clear()
  outputHistory.clear()
}

export function isAttached(sessionName: string): boolean {
  return sessions.has(sessionName)
}
