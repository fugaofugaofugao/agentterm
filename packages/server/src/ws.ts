import { WebSocket } from "ws";
import * as pty from "node-pty";
import { AppConfig, WsMessage, decodeMessage, encodeMessage, getTmuxPath, getTmuxEnv, captureSessionPane, scrollSessionPane, exitSessionCopyMode } from "@termsync/shared";
import { clientRegistry } from "./client-registry";

const relayViewers = new Map<string, Set<WebSocket>>();
const localViewers = new Map<string, Set<WebSocket>>();
const recentlyViewed = new Map<string, number>();
const RECENT_VIEW_TTL_MS = 15000;
const recentLocalInputs = new Map<string, { data: string; at: number }>();

export function handleWsConnection(
  ws: WebSocket,
  sessionName: string,
  deviceId: string | null,
  config: AppConfig
): void {
  if (deviceId && deviceId !== config.device_id) {
    handleRelayViewer(ws, sessionName, deviceId);
    return;
  }

  handleLocalSession(ws, sessionName, config);
}

function shouldDropDuplicateInput(map: Map<string, { data: string; at: number }>, sessionName: string, data: string): boolean { return false; }

function sendError(ws: WebSocket, message: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(encodeMessage({ type: "output", data: `\r\n\x1b[31m${message}\x1b[0m\r\n` }));
  }
}

function handleLocalSession(ws: WebSocket, sessionName: string, config: AppConfig): void {
  if (!localViewers.has(sessionName)) localViewers.set(sessionName, new Set());
  localViewers.get(sessionName)!.add(ws);
  recentlyViewed.set(sessionName, Date.now() + RECENT_VIEW_TTL_MS);
  const shell = config.tmux.default_shell || "/bin/zsh";
  const tmuxPath = getTmuxPath();

  let term: pty.IPty;
  try {
    term = pty.spawn(tmuxPath, ["new-session", "-A", "-s", sessionName], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: process.env.HOME || "/",
    env: getTmuxEnv({ TERM: "xterm-256color", SHELL: shell }),
  });
  } catch (err: any) {
    sendError(ws, `Failed to attach tmux session: ${err?.message || err} (tmux: ${tmuxPath})`);
    ws.close(1011, "tmux attach failed");
    return;
  }

  const snapshot = captureSessionPane(sessionName);
  if (snapshot && ws.readyState === WebSocket.OPEN) {
    ws.send(encodeMessage({ type: "output", data: snapshot.replace(/\n/g, "\r\n") + "\r\n" }));
  }

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
          exitSessionCopyMode(sessionName);
          term.write(msg.data);
        }
        break;
      case "resize":
        if (msg.cols && msg.rows) term.resize(msg.cols, msg.rows);
        break;
      case "scroll":
        if (msg.lines) scrollSessionPane(sessionName, msg.lines);
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
      cols: 80,
      rows: 24,
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
