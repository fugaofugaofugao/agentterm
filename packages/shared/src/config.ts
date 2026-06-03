import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import * as crypto from "crypto";
import * as os from "os";
import { AppConfig } from "./types";

function getHomeDir(): string {
  if (process.platform === "win32") return process.env.USERPROFILE || process.env.HOME || process.cwd();
  return process.env.HOME || process.env.USERPROFILE || process.cwd();
}

function getUserConfigPath(): string {
  if (process.platform === "win32") {
    const base = process.env.APPDATA || path.join(getHomeDir(), "AppData", "Roaming");
    return path.join(base, "agentterm", "config.yaml");
  }
  return path.join(getHomeDir(), ".config/agentterm/config.yaml");
}

function getDefaultShell(): string {
  return process.platform === "win32" ? "powershell.exe" : "/bin/zsh";
}

function isPackagedRuntime(): boolean {
  return !!(process as any).resourcesPath;
}

function getConfigPaths(): string[] {
  const userConfig = getUserConfigPath();
  const devConfigs = [
    path.join(process.cwd(), "config.yaml"),
    path.join(process.cwd(), "../..", "config.yaml"),
  ];
  return isPackagedRuntime() ? [userConfig, ...devConfigs] : [...devConfigs, userConfig];
}

export function getConfigPath(): string | null {
  for (const p of getConfigPaths()) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function getDefaultConfigPath(): string {
  return getUserConfigPath();
}

export function isConfigured(): boolean {
  const p = getConfigPath();
  if (!p) return false;
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const config = yaml.load(raw) as AppConfig;
    if (config.mode === "client") {
      return !!(config.remote && config.remote.url && config.remote.server_key);
    }
    return !!(config.auth && config.auth.users && config.auth.users.length > 0);
  } catch {
    return false;
  }
}

export function loadConfig(): AppConfig {
  const p = getConfigPath();
  if (!p) {
    throw new Error("config.yaml not found. Searched: " + getConfigPaths().join(", "));
  }
  const raw = fs.readFileSync(p, "utf-8");
  const config = yaml.load(raw) as AppConfig;
  if (!config.mode) config.mode = "host";
  if (!config.auth.server_key) {
    config.auth.server_key = crypto.randomBytes(16).toString("hex");
  }
  if (!config.device_id) {
    config.device_id = crypto.randomBytes(8).toString("hex");
  }
  return config;
}

export function saveConfig(config: AppConfig): void {
  let p = getConfigPath() || getDefaultConfigPath();
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const raw = yaml.dump(config, { lineWidth: -1, noRefs: true });
  fs.writeFileSync(p, raw, "utf-8");
}

export function resetConfig(): void {
  const p = getConfigPath();
  if (p && fs.existsSync(p)) {
    fs.unlinkSync(p);
  }
  const dataDirs = process.platform === "win32"
    ? [path.join(process.env.APPDATA || path.join(getHomeDir(), "AppData", "Roaming"), "@agentterm")]
    : [path.join(getHomeDir(), "Library/Application Support/@agentterm")];
  for (const electronDataDir of dataDirs) {
    if (fs.existsSync(electronDataDir)) {
      fs.rmSync(electronDataDir, { recursive: true, force: true });
    }
  }
}

export function generateServerKey(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function generateDeviceId(): string {
  return crypto.randomBytes(8).toString("hex");
}

export function getHostname(): string {
  return os.hostname();
}

export function createDefaultConfig(username: string, password: string, port?: number): AppConfig {
  const { hashPassword } = require("./auth");
  return {
    mode: "host",
    device_id: generateDeviceId(),
    server: {
      host: "0.0.0.0",
      port: port || 39488,
    },
    auth: {
      jwt_secret: crypto.randomBytes(32).toString("hex"),
      server_key: generateServerKey(),
      users: [{ username, password: hashPassword(password) }],
    },
    tmux: {
      default_shell: getDefaultShell(),
      aggressive_resize: true,
      session_prefix: "",
    },
  };
}

export function createClientConfig(url: string, serverKey: string, username: string): AppConfig {
  return {
    mode: "client",
    device_id: generateDeviceId(),
    server: { host: "127.0.0.1", port: 39488 },
    auth: { jwt_secret: "", server_key: "", users: [] },
    tmux: { default_shell: getDefaultShell(), aggressive_resize: true, session_prefix: "" },
    remote: { url, server_key: serverKey, username },
  };
}
