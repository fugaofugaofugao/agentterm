import { WebSocket } from "ws";
import * as path from "path";
import * as pty from "node-pty";
import { AppConfig, WsMessage, decodeMessage, encodeMessage, getTmuxPath, getTmuxEnv, scrollSessionPane, exitSessionCopyMode, getSessionScrollState, configureAgentTermSession } from "@agentterm/shared";
import { clientRegistry } from "./client-registry";

const relayViewers = new Map<string, Set<WebSocket>>();
const localViewers = new Map<string, Set<WebSocket>>();
const recentlyViewed = new Map<string, number>();
const RECENT_VIEW_TTL_MS = 15000;
const recentLocalInputs = new Map<string, { data: string; at: number }>();
const sessionSizeStates = new Map<string, { cols: number; rows: number; revision: number; controllerId?: string }>();

function normalizeSize(cols?: number, rows?: number): { cols: number; rows: number } {
  return { cols: Math.max(20, Math.trunc(Number(cols) || 80)), rows: Math.max(5, Math.trunc(Number(rows) || 24)) };
}

function getSizeState(key: string, fallback?: { cols?: number; rows?: number; revision?: number }): { cols: number; rows: number; revision: number; controllerId?: string } {
  const existing = sessionSizeStates.get(key);
  if (existing) return existing;
  const size = normalizeSize(fallback?.cols, fallback?.rows);
  const state = { ...size, revision: Number(fallback?.revision || 0) };
  sessionSizeStates.set(key, state);
  return state;
}

function updateSizeState(key: string, cols: number, rows: number, controllerId?: string): { cols: number; rows: number; revision: number; controllerId?: string } {
  const size = normalizeSize(cols, rows);
  const prev = getSizeState(key, size);
  const changed = prev.cols !== size.cols || prev.rows !== size.rows;
  const state = { cols: size.cols, rows: size.rows, revision: changed ? prev.revision + 1 : prev.revision, controllerId: controllerId || prev.controllerId };
  sessionSizeStates.set(key, state);
  return state;
}

export interface LocalTerminalAdapter {
  attachSession(sessionName: string, cols?: number, rows?: number, owner?: string, options?: { resize?: boolean }): void;
  detachSession(sessionName: string, owner?: string): void;
  forceDetachSession(sessionName: string): void;
  resetSession(sessionName: string): void;
  writeToPty(sessionName: string, data: string): void;
  resizePty(sessionName: string, cols: number, rows: number): void;
  scrollPty(sessionName: string, lines: number): void;
  addOutputListener(cb: (session: string, data: string) => void): () => void;
  addExitListener(cb: (session: string) => void): () => void;
  addClearListener?(cb: (session: string) => void): () => void;
  getBufferedOutput?(sessionName: string): string;
  isAttached?(sessionName: string): boolean;
  hasSessionOwner?(sessionName: string, ownerPrefix: string): boolean;
  getSessionSize?(sessionName: string): { cols: number; rows: number; revision?: number } | undefined;
  addSizeListener?(cb: (session: string, size: { cols: number; rows: number; revision?: number; source?: string }) => void): () => void;
}


export interface WsServerOptions {
  localTerminalAdapter?: LocalTerminalAdapter;
}

function getWindowsShell(): { file: string; args: string[] } {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return { file: process.env.AGENTTERM_WINDOWS_SHELL || powershell, args: ["-NoLogo"] };
}

function getDefaultCwd(): string {
  return process.env.USERPROFILE || process.env.HOME || process.cwd();
}

export function handleWsConnection(
  ws: WebSocket,
  sessionName: string,
  deviceId: string | null,
  config: AppConfig,
  options: WsServerOptions = {}
): void {
  if (deviceId && deviceId !== config.device_id) {
    handleRelayViewer(ws, sessionName, deviceId);
    return;
  }

  handleLocalSession(ws, sessionName, config, options);
}

function shouldDropDuplicateInput(map: Map<string, { data: string; at: number }>, sessionName: string, data: string): boolean { return false; }

function sendError(ws: WebSocket, message: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(encodeMessage({ type: "output", data: `\r\n\x1b[31m${message}\x1b[0m\r\n` }));
  }
}

function sendClear(ws: WebSocket): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(encodeMessage({ type: "clear" }));
  }
}

function sendScrollState(ws: WebSocket, sessionName: string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  const state = getSessionScrollState(sessionName);
  ws.send(encodeMessage({ type: "scroll-state", ...state }));
}

function handleLocalSession(ws: WebSocket, sessionName: string, config: AppConfig, options: WsServerOptions = {}): void {
  if (process.platform === "win32" && options.localTerminalAdapter) {
    handleAdapterLocalSession(ws, sessionName, options.localTerminalAdapter);
    return;
  }
  if (!localViewers.has(sessionName)) localViewers.set(sessionName, new Set());
  localViewers.get(sessionName)!.add(ws);
  recentlyViewed.set(sessionName, Date.now() + RECENT_VIEW_TTL_MS);
  const shell = config.tmux.default_shell || (process.platform === "win32" ? "powershell.exe" : "/bin/zsh");
  const tmuxPath = getTmuxPath();
  if (process.platform !== "win32") configureAgentTermSession(sessionName);

  const owner = `web:${sessionName}:${Date.now()}:${localViewers.get(sessionName)!.size}`;
  const state = getSizeState(`local:${sessionName}`);
  let controllerId = state.controllerId;
  let term: pty.IPty;
  const sendTerminalSize = (role: "controller" | "observer" = controllerId === owner ? "controller" : "observer") => {
    const s = getSizeState(`local:${sessionName}`);
    if (ws.readyState === WebSocket.OPEN) ws.send(encodeMessage({ type: "terminal-size", cols: s.cols, rows: s.rows, revision: s.revision, controllerId: s.controllerId, role } as any));
  };
  try {
    const command = process.platform === "win32"
      ? getWindowsShell()
      : { file: tmuxPath, args: ["new-session", "-A", "-s", sessionName] };
    term = pty.spawn(command.file, command.args, {
    name: "xterm-256color",
    cols: state.cols,
    rows: state.rows,
    cwd: getDefaultCwd(),
    env: getTmuxEnv({ TERM: "xterm-256color", SHELL: shell }),
  });
  } catch (err: any) {
    sendError(ws, `Failed to attach tmux session: ${err?.message || err} (tmux: ${tmuxPath})`);
    ws.close(1011, "tmux attach failed");
    return;
  }


  sendScrollState(ws, sessionName);

  term.onData((data: string) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(encodeMessage({ type: "output", data }));
    }
  });

  ws.on("message", (raw: Buffer | string) => {
    const msg = decodeMessage(raw.toString());
    if (!msg) return;

    switch (msg.type) {
      case "input":
        if (msg.data && !shouldDropDuplicateInput(recentLocalInputs, sessionName, msg.data)) {
          if (process.platform !== "win32") exitSessionCopyMode(sessionName);
          term.write(msg.data);
          sendScrollState(ws, sessionName);
        }
        break;
      case "resize-intent": {
        controllerId = String((msg as any).clientId || owner);
        const next = updateSizeState(`local:${sessionName}`, msg.cols || term.cols, msg.rows || term.rows, controllerId);
        term.resize(next.cols, next.rows);
        const out = encodeMessage({ type: "terminal-size", cols: next.cols, rows: next.rows, revision: next.revision, controllerId, sourceClientId: controllerId, role: "controller" } as any);
        for (const viewer of localViewers.get(sessionName) || []) if (viewer.readyState === WebSocket.OPEN) viewer.send(out);
        break;
      }
      case "resize": {
        const clientId = String((msg as any).clientId || owner);
        const state = getSizeState(`local:${sessionName}`);
        if (msg.cols && msg.rows && (!state.controllerId || state.controllerId === clientId)) {
          controllerId = clientId;
          const next = updateSizeState(`local:${sessionName}`, msg.cols, msg.rows, clientId);
          term.resize(next.cols, next.rows);
          const out = encodeMessage({ type: "terminal-size", cols: next.cols, rows: next.rows, revision: next.revision, controllerId: clientId, sourceClientId: clientId, role: "controller" } as any);
          for (const viewer of localViewers.get(sessionName) || []) if (viewer.readyState === WebSocket.OPEN) viewer.send(out);
        } else sendTerminalSize("observer");
        break;
      }
      case "scroll":
        if (msg.lines) {
          scrollSessionPane(sessionName, msg.lines);
          sendScrollState(ws, sessionName);
        }
        break;
      case "ping":
        ws.send(encodeMessage({ type: "pong" }));
        break;
    }
  });

  ws.on("close", () => {
    const viewers = localViewers.get(sessionName);
    viewers?.delete(ws);
    if (viewers && viewers.size === 0) localViewers.delete(sessionName);
    term.kill();
  });

  term.onExit(() => {
    if (ws.readyState === WebSocket.OPEN) ws.close();
  });
}


function handleAdapterLocalSession(ws: WebSocket, sessionName: string, adapter: LocalTerminalAdapter): void {
  if (!localViewers.has(sessionName)) localViewers.set(sessionName, new Set());
  localViewers.get(sessionName)!.add(ws);
  recentlyViewed.set(sessionName, Date.now() + RECENT_VIEW_TTL_MS);

  const owner = `web:${sessionName}:${Date.now()}:${localViewers.get(sessionName)!.size}`;
  let passiveViewer = false;
  const sendAdapterScrollState = () => sendScrollState(ws, sessionName);
  const removeOutput = adapter.addOutputListener((session, data) => {
    if (session === sessionName && ws.readyState === WebSocket.OPEN) {
      ws.send(encodeMessage({ type: "output", data }));
    }
  });
  const removeExit = adapter.addExitListener((session) => {
    if (session === sessionName && ws.readyState === WebSocket.OPEN) ws.close();
  });
  const removeClear = adapter.addClearListener ? adapter.addClearListener((session) => {
    if (session === sessionName && ws.readyState === WebSocket.OPEN) ws.send(encodeMessage({ type: "clear" }));
  }) : () => {};
  const removeSize = adapter.addSizeListener ? adapter.addSizeListener((session, size) => {
    if (session !== sessionName) return;
    const state = updateSizeState(`local:${sessionName}`, size.cols, size.rows, (size as any).source || getSizeState(`local:${sessionName}`).controllerId);
    const msg = encodeMessage({ type: "terminal-size", cols: state.cols, rows: state.rows, revision: state.revision, controllerId: state.controllerId, sourceClientId: (size as any).source, role: state.controllerId === owner ? "controller" : "observer" } as any);
    for (const viewer of localViewers.get(sessionName) || []) if (viewer.readyState === WebSocket.OPEN) viewer.send(msg);
  }) : () => {};

  try {
    const wasAttached = adapter.isAttached?.(sessionName) || false;
    const hasRendererOwner = !!adapter.hasSessionOwner?.(sessionName, "renderer");
    const passiveSize = wasAttached || hasRendererOwner;
    passiveViewer = passiveSize;
    const initialSize = adapter.getSessionSize?.(sessionName) || { cols: 80, rows: 24, revision: 0 };
    const state = getSizeState(`local:${sessionName}`, initialSize);
    adapter.attachSession(sessionName, state.cols, state.rows, owner, { resize: !passiveSize });
    const size = adapter.getSessionSize?.(sessionName) || state;
    const currentState = getSizeState(`local:${sessionName}`, size);
    const buffered = adapter.getBufferedOutput?.(sessionName) || "";
    if (ws.readyState === WebSocket.OPEN && size) ws.send(encodeMessage({ type: "terminal-size", cols: currentState.cols, rows: currentState.rows, revision: currentState.revision, controllerId: currentState.controllerId, role: currentState.controllerId === owner ? "controller" : "observer", passive: passiveSize } as any));
    if (ws.readyState === WebSocket.OPEN) ws.send(encodeMessage({ type: "clear" }));
    if (buffered && ws.readyState === WebSocket.OPEN) {
      for (let i = 0; i < buffered.length; i += 8192) {
        ws.send(encodeMessage({ type: "output", data: buffered.slice(i, i + 8192) }));
      }
    }
    sendAdapterScrollState();
  } catch (err: any) {
    removeOutput();
    removeExit();
    removeClear();
    removeSize();
    const viewers = localViewers.get(sessionName);
    viewers?.delete(ws);
    if (viewers && viewers.size === 0) localViewers.delete(sessionName);
    sendError(ws, `Failed to attach shared Windows session: ${err?.message || err}`);
    ws.close(1011, "windows pty attach failed");
    return;
  }

  ws.on("message", (raw: Buffer | string) => {
    const msg = decodeMessage(raw.toString());
    if (!msg) return;

    switch (msg.type) {
      case "input":
        if (msg.data && !shouldDropDuplicateInput(recentLocalInputs, sessionName, msg.data)) {
          adapter.writeToPty(sessionName, msg.data);
          sendAdapterScrollState();
        }
        break;
      case "resize-intent": {
        const clientId = String((msg as any).clientId || owner);
        const next = updateSizeState(`local:${sessionName}`, msg.cols || getSizeState(`local:${sessionName}`).cols, msg.rows || getSizeState(`local:${sessionName}`).rows, clientId);
        passiveViewer = false;
        adapter.resizePty(sessionName, next.cols, next.rows);
        break;
      }
      case "resize": {
        const clientId = String((msg as any).clientId || owner);
        const state = getSizeState(`local:${sessionName}`);
        if (msg.cols && msg.rows && state.controllerId === clientId) {
          const next = updateSizeState(`local:${sessionName}`, msg.cols, msg.rows, clientId);
          adapter.resizePty(sessionName, next.cols, next.rows);
        } else if (ws.readyState === WebSocket.OPEN) {
          const size = adapter.getSessionSize?.(sessionName) || state;
          ws.send(encodeMessage({ type: "terminal-size", cols: size.cols, rows: size.rows, revision: (size as any).revision || state.revision, controllerId: state.controllerId, role: "observer", passive: true } as any));
        }
        break;
      }
      case "scroll":
        if (msg.lines) {
          adapter.scrollPty(sessionName, msg.lines);
          sendAdapterScrollState();
        }
        break;
      case "ping":
        ws.send(encodeMessage({ type: "pong" }));
        break;
    }
  });

  ws.on("close", () => {
    removeOutput();
    removeExit();
    removeClear();
    removeSize();
    const viewers = localViewers.get(sessionName);
    viewers?.delete(ws);
    if (viewers && viewers.size === 0) localViewers.delete(sessionName);
    adapter.detachSession(sessionName, owner);
  });
}

function handleRelayViewer(ws: WebSocket, sessionName: string, deviceId: string): void {
  const clientWs = clientRegistry.getClientWs(deviceId);
  if (!clientWs || clientWs.readyState !== WebSocket.OPEN) {
    ws.close(4002, "Client device not connected");
    return;
  }

  const relayKey = `${deviceId}:${sessionName}`;

  if (!relayViewers.has(relayKey)) {
    relayViewers.set(relayKey, new Set());
  }
  relayViewers.get(relayKey)!.add(ws);
  recentlyViewed.set(relayKey, Date.now() + RECENT_VIEW_TTL_MS);

  try {
    clientWs.send(encodeMessage({
      type: "relay-attach",
      sessionName,
    }));
  } catch (err: any) {
    sendError(ws, `Failed to request client relay: ${err?.message || err}`);
    ws.close(1011, "relay attach failed");
    return;
  }

  ws.on("message", (raw: Buffer | string) => {
    const msg = decodeMessage(raw.toString());
    if (!msg) return;

    switch (msg.type) {
      case "input":
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(encodeMessage({
            type: "relay-input",
            sessionName,
            data: msg.data,
          }));
        }
        break;
      case "resize-intent":
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(encodeMessage({
            type: "resize-intent",
            sessionName,
            cols: msg.cols,
            rows: msg.rows,
            clientId: (msg as any).clientId,
          } as any));
        }
        break;
      case "resize":
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(encodeMessage({
            type: "relay-resize",
            sessionName,
            cols: msg.cols,
            rows: msg.rows,
          }));
        }
        break;
      case "scroll":
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(encodeMessage({
            type: "relay-scroll",
            sessionName,
            lines: msg.lines,
          }));
        }
        break;
      case "ping":
        ws.send(encodeMessage({ type: "pong" }));
        break;
    }
  });

  ws.on("close", () => {
    const viewers = relayViewers.get(relayKey);
    if (viewers) {
      viewers.delete(ws);
      if (viewers.size === 0) {
        relayViewers.delete(relayKey);
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(encodeMessage({
            type: "relay-detach",
            sessionName,
          }));
        }
      }
    }
  });
}

export function handleRelayOutput(deviceId: string, sessionName: string, data: string): void {
  const relayKey = `${deviceId}:${sessionName}`;
  const viewers = relayViewers.get(relayKey);
  if (!viewers) return;
  const msg = encodeMessage({ type: "output", data });
  for (const ws of viewers) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

export function broadcastLocalClear(sessionName: string): void {
  const viewers = localViewers.get(sessionName);
  if (!viewers) return;
  for (const ws of viewers) sendClear(ws);
}

export function handleRelayClear(deviceId: string, sessionName: string): void {
  const relayKey = `${deviceId}:${sessionName}`;
  const viewers = relayViewers.get(relayKey);
  if (!viewers) return;
  for (const ws of viewers) sendClear(ws);
}

export function handleRelayScrollState(deviceId: string, sessionName: string, state: { scrollPosition?: number; historySize?: number; paneHeight?: number; inCopyMode?: boolean }): void {
  const relayKey = `${deviceId}:${sessionName}`;
  const viewers = relayViewers.get(relayKey);
  if (!viewers) return;
  const msg = encodeMessage({ type: "scroll-state", ...state });
  for (const ws of viewers) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}


export function handleRelayTerminalSize(deviceId: string, sessionName: string, size: { cols?: number; rows?: number; passive?: boolean; revision?: number; controllerId?: string; sourceClientId?: string; role?: string }): void {
  const relayKey = `${deviceId}:${sessionName}`;
  const viewers = relayViewers.get(relayKey);
  if (!viewers) return;
  const cols = Math.max(20, Math.trunc(Number(size.cols) || 80));
  const rows = Math.max(5, Math.trunc(Number(size.rows) || 24));
  const state = updateSizeState(relayKey, cols, rows, size.controllerId);
  const msg = encodeMessage({ type: "terminal-size" as any, cols: state.cols, rows: state.rows, revision: size.revision || state.revision, controllerId: size.controllerId || state.controllerId, sourceClientId: size.sourceClientId, role: size.role, passive: !!size.passive } as any);
  for (const ws of viewers) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

export function handleRelayExit(deviceId: string, sessionName: string): void {
  const relayKey = `${deviceId}:${sessionName}`;
  const viewers = relayViewers.get(relayKey);
  if (!viewers) return;
  for (const ws of viewers) {
    if (ws.readyState === WebSocket.OPEN) ws.close();
  }
  relayViewers.delete(relayKey);
}

export function cleanupRelayForDevice(deviceId: string): void {
  for (const [key, viewers] of relayViewers) {
    if (key.startsWith(deviceId + ":")) {
      for (const ws of viewers) {
        if (ws.readyState === WebSocket.OPEN) ws.close();
      }
      relayViewers.delete(key);
    }
  }
}


function isRecentlyViewed(key: string): boolean {
  const expires = recentlyViewed.get(key) || 0;
  if (expires > Date.now()) return true;
  recentlyViewed.delete(key);
  return false;
}

export function isSessionViewed(sessionName: string): boolean {
  return (localViewers.get(sessionName)?.size || 0) > 0 || isRecentlyViewed(sessionName);
}

export function isRelayViewed(deviceId: string, sessionName: string): boolean {
  const key = `${deviceId}:${sessionName}`;
  return (relayViewers.get(key)?.size || 0) > 0 || isRecentlyViewed(key);
}


export function sendRelayControl(deviceId: string, msg: any): boolean {
  const clientWs = clientRegistry.getClientWs(deviceId);
  if (!clientWs || clientWs.readyState !== WebSocket.OPEN) return false;
  clientWs.send(encodeMessage(msg));
  return true;
}
