import express from "express";
import http from "http";
import path from "path";
import { WebSocketServer, WebSocket } from "ws";
import {
  loadConfig, saveConfig, isConfigured, createDefaultConfig, getHostname,
  verifyUser, findUser, registerUser, verifyServerKey, signToken, verifyToken,
  hashPassword, listSessions,
} from "@agentterm/shared";
import type { AppConfig, SessionInfo, DeviceInfo, WsMessage } from "@agentterm/shared";
import { handleWsConnection, handleRelayOutput, handleRelayClear, handleRelayScrollState, handleRelayExit, cleanupRelayForDevice, isSessionViewed, isRelayViewed, sendRelayControl, broadcastLocalClear } from "./ws";
import { clientRegistry } from "./client-registry";

function decodeRelayMessage(raw: string): WsMessage | null {
  try { return JSON.parse(raw); } catch { return null; }
}

export function startServer(config: AppConfig): { server: http.Server; close: () => void } {
  const app = express();
  const server = http.createServer(app);

  app.use(express.json());
  app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!err) { next(); return; }
    const message = err?.type === "entity.parse.failed" ? "Invalid JSON request body" : (err?.message || "Request failed");
    res.status(err?.status || 400).json({ error: "bad_request", message });
  });
  const fs = require("fs");
  const resourcesPublic = (process as any).resourcesPath ? path.join((process as any).resourcesPath, "server-public") : null;
  const publicDir = (resourcesPublic && fs.existsSync(resourcesPublic)) ? resourcesPublic : path.join(__dirname, "../public");
  app.use(express.static(publicDir, {
    etag: false,
    maxAge: 0,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".js") || filePath.endsWith(".css") || filePath.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        res.setHeader("Pragma", "no-cache");
      }
      if (filePath.endsWith(".woff2") || filePath.endsWith(".woff") || filePath.endsWith(".ttf")) {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Cache-Control", "public, max-age=3600");
      }
    },
  }));

  let currentConfig = config;

  function requireAuth(req: express.Request, res: express.Response): string | null {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) { res.status(401).json({ error: "Unauthorized" }); return null; }
    const payload = verifyToken(currentConfig.auth.jwt_secret, auth.slice(7));
    if (!payload) { res.status(401).json({ error: "Invalid token" }); return null; }
    return payload.username;
  }

  function getHostDevice(): DeviceInfo {
    return {
      id: currentConfig.device_id || "host",
      name: getHostname(),
      type: "host",
    };
  }

  // --- Config API ---

  app.get("/api/config/status", (_req, res) => {
    res.json({ configured: isConfigured() });
  });

  app.post("/api/config/setup", (req, res) => {
    if (isConfigured()) {
      res.status(400).json({ error: "Already configured" });
      return;
    }
    const { username, password, port } = req.body;
    if (!username || !password) {
      res.status(400).json({ error: "Username and password required" });
      return;
    }
    const newConfig = createDefaultConfig(username, password, port);
    saveConfig(newConfig);
    currentConfig = loadConfig();
    const token = signToken(currentConfig.auth.jwt_secret, username);
    res.json({ ok: true, token, username, server_key: currentConfig.auth.server_key });
  });

  app.get("/api/config", (req, res) => {
    const user = requireAuth(req, res);
    if (!user) return;
    const safe = {
      server: currentConfig.server,
      auth: {
        server_key: currentConfig.auth.server_key,
        users: currentConfig.auth.users.map((u) => ({ username: u.username, password: "••••••" })),
      },
      tmux: currentConfig.tmux,
    };
    res.json(safe);
  });

  app.put("/api/config", (req, res) => {
    const user = requireAuth(req, res);
    if (!user) return;
    const updates = req.body;
    if (updates.server) {
      if (updates.server.port) currentConfig.server.port = Number(updates.server.port);
      if (updates.server.host) currentConfig.server.host = updates.server.host;
    }
    if (updates.auth) {
      if (updates.auth.password) {
        const u = currentConfig.auth.users.find((u) => u.username === user);
        if (u) u.password = hashPassword(updates.auth.password);
      }
    }
    if (updates.tmux) {
      if (updates.tmux.default_shell) currentConfig.tmux.default_shell = updates.tmux.default_shell;
      if (updates.tmux.session_prefix !== undefined) currentConfig.tmux.session_prefix = updates.tmux.session_prefix;
    }
    saveConfig(currentConfig);
    currentConfig = loadConfig();
    res.json({ ok: true });
  });

  // --- Auth API ---

  app.post("/api/login", (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      res.status(400).json({ error: "Missing username or password" });
      return;
    }
    if (!verifyUser(currentConfig.auth, username, password)) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }
    const token = signToken(currentConfig.auth.jwt_secret, username);
    res.json({ token, username });
  });

  app.post("/api/auth/client-connect", (req, res) => {
    const { server_key, username, password } = req.body;
    if (!server_key || !username || !password) {
      res.status(400).json({ error: "missing_fields", message: "Missing required fields" });
      return;
    }
    if (!verifyServerKey(currentConfig.auth, server_key)) {
      res.status(400).json({ error: "server_key_invalid", message: "服务器秘钥错误" });
      return;
    }
    const existingUser = findUser(currentConfig.auth, username);
    if (existingUser) {
      if (!verifyUser(currentConfig.auth, username, password)) {
        res.status(401).json({ error: "password_invalid", message: "密码错误" });
        return;
      }
      const token = signToken(currentConfig.auth.jwt_secret, username);
      res.json({ action: "login", token, username });
    } else {
      registerUser(currentConfig.auth, username, password);
      saveConfig(currentConfig);
      currentConfig = loadConfig();
      const token = signToken(currentConfig.auth.jwt_secret, username);
      res.json({ action: "registered", token, username });
    }
  });

  app.get("/api/server-key", (req, res) => {
    const user = requireAuth(req, res);
    if (!user) return;
    res.json({ server_key: currentConfig.auth.server_key });
  });

  // --- Sessions API ---

  app.get("/api/sessions", (req, res) => {
    const user = requireAuth(req, res);
    if (!user) return;
    clientRegistry.requestSessionSyncForUser(user);

    const hostDevice = getHostDevice();
    const hostSessions: SessionInfo[] = listSessions().map((s) => ({
      ...s,
      attached: true,
      owner: user,
      device: hostDevice,
    }));

    const clientSessions = clientRegistry.getSessionsForUser(user).map((s: any) => ({
      ...s,
      attached: true,
    }));
    const allSessions = [...hostSessions, ...clientSessions];
    res.json({ sessions: allSessions });
  });

  app.post("/api/sessions", (req, res) => {
    const user = requireAuth(req, res);
    if (!user) return;
    const { name, deviceId } = req.body;
    if (!name) { res.status(400).json({ error: "Session name required" }); return; }
    if (deviceId && deviceId !== currentConfig.device_id) {
      const ok = sendRelayControl(deviceId, { type: "relay-create", sessionName: name });
      if (!ok) { res.status(404).json({ error: "Client device not connected" }); return; }
      clientRegistry.requestSessionSyncForDevice(deviceId);
      res.json({ ok: true });
      return;
    }
    const { createSession } = require("@agentterm/shared");
    createSession(name);
    res.json({ ok: true });
  });

  app.delete("/api/sessions/:name", (req, res) => {
    const user = requireAuth(req, res);
    if (!user) return;
    const deviceId = String(req.query.deviceId || "");
    if (deviceId && deviceId !== currentConfig.device_id) {
      const ok = sendRelayControl(deviceId, { type: "relay-kill", sessionName: req.params.name });
      if (!ok) { res.status(404).json({ error: "Client device not connected" }); return; }
      clientRegistry.requestSessionSyncForDevice(deviceId);
      res.json({ ok: true });
      return;
    }
    const { killSession } = require("@agentterm/shared");
    killSession(req.params.name);
    res.json({ ok: true });
  });

  app.post("/api/sessions/:name/reset", (req, res) => {
    const user = requireAuth(req, res);
    if (!user) return;
    const { deviceId } = req.body || {};
    if (deviceId && deviceId !== currentConfig.device_id) {
      const ok = sendRelayControl(deviceId, { type: "relay-reset", sessionName: req.params.name });
      if (!ok) { res.status(404).json({ error: "Client device not connected" }); return; }
      clientRegistry.requestSessionSyncForDevice(deviceId);
      res.json({ ok: true });
      return;
    }
    broadcastLocalClear(req.params.name);
    const { resetSessionFresh } = require("@agentterm/shared");
    resetSessionFresh(req.params.name, currentConfig.tmux?.default_shell);
    res.json({ ok: true });
  });

  // --- WebSocket ---

  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws, req) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const token = url.searchParams.get("token");
    const session = url.searchParams.get("session") || "default";
    const deviceId = url.searchParams.get("deviceId") || null;
    const role = url.searchParams.get("role");

    if (role === "client-relay") {
      handleClientRelay(ws, token, currentConfig);
      return;
    }

    if (!token) { ws.close(4001, "Missing token"); return; }
    const payload = verifyToken(currentConfig.auth.jwt_secret, token);
    if (!payload) { ws.close(4001, "Invalid token"); return; }

    handleWsConnection(ws, session, deviceId, currentConfig);
  });

  function handleClientRelay(ws: WebSocket, token: string | null, config: AppConfig): void {
    if (!token) { ws.close(4001, "Missing token"); return; }
    const payload = verifyToken(config.auth.jwt_secret, token);
    if (!payload) { ws.close(4001, "Invalid token"); return; }

    let registeredDeviceId: string | null = null;

    ws.on("message", (raw: Buffer | string) => {
      const msg = decodeRelayMessage(raw.toString());
      if (!msg) return;

      switch (msg.type) {
        case "client-hello":
          if (msg.deviceId && msg.deviceName) {
            registeredDeviceId = msg.deviceId;
            clientRegistry.registerClient(msg.deviceId, msg.deviceName, payload.username, ws);
          }
          break;
        case "session-sync":
          if (registeredDeviceId && msg.sessions) {
            clientRegistry.updateSessions(registeredDeviceId, msg.sessions);
          }
          break;
        case "relay-output":
          if (registeredDeviceId && msg.sessionName && msg.data) {
            handleRelayOutput(registeredDeviceId, msg.sessionName, msg.data);
          }
          break;
        case "relay-clear":
          if (registeredDeviceId && msg.sessionName) {
            handleRelayClear(registeredDeviceId, msg.sessionName);
          }
          break;
        case "relay-scroll-state":
          if (registeredDeviceId && msg.sessionName) {
            handleRelayScrollState(registeredDeviceId, msg.sessionName, msg);
          }
          break;
        case "relay-exit":
          if (registeredDeviceId && msg.sessionName) {
            handleRelayExit(registeredDeviceId, msg.sessionName);
          }
          break;
        case "ping":
          ws.send(JSON.stringify({ type: "pong" }));
          break;
      }
    });

    ws.on("close", () => {
      if (registeredDeviceId) {
        cleanupRelayForDevice(registeredDeviceId);
        clientRegistry.unregisterClient(registeredDeviceId);
      }
    });
  }

  const port = currentConfig.server.port || 39488;
  const host = currentConfig.server.host || "0.0.0.0";
  server.listen(port, host, () => {
    console.log(`AgentTerm server running at http://${host}:${port}`);
  });

  return {
    server,
    close: () => {
      wss.close();
      server.close();
    },
  };
}

if (require.main === module) {
  if (!isConfigured()) {
    console.log("Not configured yet. Visit the web UI to set up.");
  }
  const config = isConfigured() ? loadConfig() : createDefaultConfig("admin", "admin");
  startServer(config);
}
