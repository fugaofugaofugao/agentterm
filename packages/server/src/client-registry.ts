import { WebSocket } from "ws";
import { SessionInfo, DeviceInfo } from "@agentterm/shared";

interface ConnectedClient {
  deviceId: string;
  deviceName: string;
  username: string;
  ws: WebSocket;
  sessions: SessionInfo[];
}

class ClientRegistry {
  private clients = new Map<string, ConnectedClient>();

  registerClient(deviceId: string, deviceName: string, username: string, ws: WebSocket): void {
    this.clients.set(deviceId, { deviceId, deviceName, username, ws, sessions: [] });
  }

  unregisterClient(deviceId: string): void {
    this.clients.delete(deviceId);
  }

  updateSessions(deviceId: string, sessions: SessionInfo[]): void {
    const client = this.clients.get(deviceId);
    if (client) client.sessions = sessions;
  }

  getSessionsForUser(username: string): SessionInfo[] {
    const all: SessionInfo[] = [];
    for (const client of this.clients.values()) {
      if (client.username === username) {
        all.push(...client.sessions);
      }
    }
    return all;
  }

  requestSessionSyncForUser(username: string): void {
    for (const client of this.clients.values()) {
      if (client.username === username && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify({ type: "session-sync-request" }));
      }
    }
  }

  requestSessionSyncForDevice(deviceId: string): void {
    const client = this.clients.get(deviceId);
    if (client && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify({ type: "session-sync-request" }));
    }
  }

  getClientWs(deviceId: string): WebSocket | null {
    return this.clients.get(deviceId)?.ws || null;
  }

  getClientByDeviceId(deviceId: string): ConnectedClient | undefined {
    return this.clients.get(deviceId);
  }

  findClientForSession(sessionName: string, deviceId: string): ConnectedClient | undefined {
    return this.clients.get(deviceId);
  }

  getAllClients(): ConnectedClient[] {
    return Array.from(this.clients.values());
  }

  unregisterByWs(ws: WebSocket): void {
    for (const [id, client] of this.clients) {
      if (client.ws === ws) {
        this.clients.delete(id);
        break;
      }
    }
  }
}

export const clientRegistry = new ClientRegistry();
