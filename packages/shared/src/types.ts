export interface User {
  username: string;
  password: string;
}

export interface DeviceInfo {
  id: string;
  name: string;
  type: "host" | "client";
}

export interface SessionInfo {
  name: string;
  windows: number;
  created: string;
  attached: boolean;
  owner: string;
  device: DeviceInfo;
}

export interface ServerConfig {
  host: string;
  port: number;
}

export interface TmuxConfig {
  default_shell: string;
  aggressive_resize: boolean;
  session_prefix: string;
}

export interface AuthConfig {
  jwt_secret: string;
  server_key: string;
  users: User[];
}

export interface RemoteConfig {
  url: string;
  server_key: string;
  username: string;
}

export interface RuntimeConfig {
  launch_at_login?: boolean;
  persistent_mode?: boolean;
  keep_awake?: boolean;
}

export interface AppConfig {
  mode: "host" | "client";
  device_id?: string;
  server: ServerConfig;
  auth: AuthConfig;
  tmux: TmuxConfig;
  remote?: RemoteConfig;
  runtime?: RuntimeConfig;
}

export interface TmuxSession {
  name: string;
  windows: number;
  created: string;
  attached: boolean;
}

export type WsMessageType =
  | "input"
  | "output"
  | "resize"
  | "scroll"
  | "clear"
  | "terminal-size"
  | "resize-intent"
  | "resize-control"
  | "scroll-state"
  | "ping"
  | "pong"
  | "client-hello"
  | "session-sync"
  | "session-sync-request"
  | "relay-attach"
  | "relay-detach"
  | "relay-input"
  | "relay-output"
  | "relay-clear"
  | "relay-scroll-state"
  | "relay-resize"
  | "relay-scroll"
  | "relay-create"
  | "relay-kill"
  | "relay-reset"
  | "relay-exit";

export interface WsMessage {
  type: WsMessageType;
  data?: string;
  cols?: number;
  rows?: number;
  lines?: number;
  deviceId?: string;
  deviceName?: string;
  username?: string;
  token?: string;
  sessionName?: string;
  sessions?: SessionInfo[];
  scrollPosition?: number;
  historySize?: number;
  paneHeight?: number;
  inCopyMode?: boolean;
  passive?: boolean;
  role?: "controller" | "observer";
  clientId?: string;
  controllerId?: string;
  sourceClientId?: string;
  revision?: number;
  reason?: string;
}
