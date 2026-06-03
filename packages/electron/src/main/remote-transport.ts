import WebSocket from "ws"
import http from "http"
import https from "https"
import { TmuxSession } from "@agentterm/shared"

type OutputCallback = (session: string, data: string, deviceId?: string | null) => void
type ExitCallback = (session: string, deviceId?: string | null) => void

let token: string | null = null
let baseUrl: string = ""
let onOutput: OutputCallback = () => {}
let onExit: ExitCallback = () => {}
const connections = new Map<string, { ws: WebSocket; name: string; deviceId: string | null }>()

function key(name: string, deviceId?: string | null): string { return `${deviceId || "local"}:${name}` }

export function setOutputCallback(cb: OutputCallback): void { onOutput = cb }
export function setExitCallback(cb: ExitCallback): void { onExit = cb }
export function configure(url: string, authToken: string): void { baseUrl = url.replace(/\/$/, ""); token = authToken }

function apiRequest(method: string, path: string, body?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl)
    const mod = url.protocol === "https:" ? https : http
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (token) headers["Authorization"] = `Bearer ${token}`

    const req = mod.request(url, { method, headers }, (res) => {
      let data = ""
      res.on("data", (chunk) => { data += chunk })
      res.on("end", () => { try { resolve(JSON.parse(data)) } catch { resolve(data) } })
    })
    req.on("error", reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

export async function clientConnect(url: string, serverKey: string, username: string, password: string): Promise<{ success: boolean; action?: string; error?: string; token?: string }> {
  baseUrl = url.replace(/\/$/, "")
  try {
    const result = await apiRequest("POST", "/api/auth/client-connect", { server_key: serverKey, username, password })
    if (result.token) { token = result.token; return { success: true, action: result.action, token: result.token } }
    return { success: false, error: result.message || result.error || "Connection failed" }
  } catch (err: any) { return { success: false, error: err.message || "Connection failed" } }
}

export async function login(url: string, username: string, password: string): Promise<{ success: boolean; error?: string }> {
  baseUrl = url.replace(/\/$/, "")
  try {
    const result = await apiRequest("POST", "/api/login", { username, password })
    if (result.token) { token = result.token; return { success: true } }
    return { success: false, error: result.error || "Login failed" }
  } catch (err: any) { return { success: false, error: err.message || "Connection failed" } }
}

export async function testConnection(url: string): Promise<{ success: boolean; error?: string }> {
  const testUrl = url.replace(/\/$/, "")
  try {
    const result = await new Promise<any>((resolve, reject) => {
      const u = new URL("/api/config/status", testUrl)
      const mod = u.protocol === "https:" ? https : http
      const req = mod.get(u, (res) => {
        let data = ""
        res.on("data", (chunk) => { data += chunk })
        res.on("end", () => { try { resolve(JSON.parse(data)) } catch { reject(new Error("Invalid response")) } })
      })
      req.on("error", reject)
      req.setTimeout(5000, () => { req.destroy(); reject(new Error("Timeout")) })
    })
    if (result.configured !== undefined) return { success: true }
    return { success: false, error: "Not an AgentTerm server" }
  } catch (err: any) { return { success: false, error: err.message || "Connection failed" } }
}

export async function listSessions(): Promise<TmuxSession[]> {
  if (!token) return []
  try { const result = await apiRequest("GET", "/api/sessions"); return result.sessions || [] } catch { return [] }
}
export async function createSession(name: string, deviceId?: string | null): Promise<any> { if (token) return await apiRequest("POST", "/api/sessions", { name, deviceId }) }
export async function killSession(name: string, deviceId?: string | null): Promise<any> { if (token) return await apiRequest("DELETE", `/api/sessions/${encodeURIComponent(name)}${deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : ""}`) }
export async function resetSession(name: string, deviceId?: string | null): Promise<any> { if (token) return await apiRequest("POST", `/api/sessions/${encodeURIComponent(name)}/reset`, { deviceId }) }

export function attachSession(name: string, cols = 80, rows = 24, deviceId?: string | null): void {
  const k = key(name, deviceId)
  if (!token || connections.has(k)) return
  let wsUrl = baseUrl.replace(/^http/, "ws") + `/ws?token=${token}&session=${encodeURIComponent(name)}`
  if (deviceId) wsUrl += `&deviceId=${encodeURIComponent(deviceId)}`
  const ws = new WebSocket(wsUrl)
  ws.on("open", () => { ws.send(JSON.stringify({ type: "resize", cols, rows })) })
  ws.on("message", (raw: Buffer | string) => {
    if (connections.get(k)?.ws !== ws) return
    try { const msg = JSON.parse(raw.toString()); if (msg.type === "output" && msg.data) onOutput(name, msg.data, deviceId || null) } catch {}
  })
  ws.on("close", () => {
    if (connections.get(k)?.ws !== ws) return
    connections.delete(k); onExit(name, deviceId || null)
  })
  ws.on("error", () => {
    if (connections.get(k)?.ws !== ws) return
    connections.delete(k); onExit(name, deviceId || null)
  })
  connections.set(k, { ws, name, deviceId: deviceId || null })
}

export function detachSession(name: string, deviceId?: string | null): void { const k = key(name, deviceId); const c = connections.get(k); if (c) { c.ws.close(); connections.delete(k) } }
export function writeToPty(name: string, data: string, deviceId?: string | null): void { const c = connections.get(key(name, deviceId)); if (c?.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify({ type: "input", data })) }
export function resizePty(name: string, cols: number, rows: number, deviceId?: string | null): void { const c = connections.get(key(name, deviceId)); if (c?.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify({ type: "resize", cols, rows })) }
export function scrollPty(name: string, lines: number, deviceId?: string | null): void { const c = connections.get(key(name, deviceId)); if (c?.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify({ type: "scroll", lines })) }
export function detachAll(): void { for (const [, c] of connections) c.ws.close(); connections.clear() }
export function isConnected(): boolean { return token !== null }
export function isAttached(session: string, deviceId?: string | null): boolean { return connections.has(key(session, deviceId)) }
export function getAttachedKeys(): Set<string> { return new Set(connections.keys()) }
export function getToken(): string | null { return token }
export function getBaseUrl(): string { return baseUrl }
