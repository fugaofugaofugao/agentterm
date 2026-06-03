import { execFileSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { TmuxSession } from "./types";

function getProcessResourcesPath(): string | null {
  const resourcesPath = (process as any).resourcesPath || process.env.AGENTTERM_RESOURCES_PATH;
  return resourcesPath || null;
}

function tryExec(bin: string, env?: Record<string, string>): boolean {
  try {
    execFileSync(bin, ["-V"], { stdio: "pipe", timeout: 3000, env: env || getTmuxEnv() });
    return true;
  } catch {
    return false;
  }
}

function findBundledTmux(): string | null {
  const candidates: string[] = [];
  const resourcesPath = getProcessResourcesPath();
  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, "tmux", "tmux"));
  }
  candidates.push(path.join(__dirname, "../../resources/tmux/tmux"));
  candidates.push(path.join(__dirname, "../../../resources/tmux/tmux"));

  for (const p of candidates) {
    if (fs.existsSync(p) && tryExec(p)) return p;
  }
  return null;
}

function findTmux(): string {
  if (process.env.TMUX_PATH && tryExec(process.env.TMUX_PATH)) return process.env.TMUX_PATH;

  const bundled = findBundledTmux();
  if (bundled) return bundled;

  const resourcesPath = getProcessResourcesPath();
  if (resourcesPath) {
    const expected = path.join(resourcesPath, "tmux", "tmux");
    console.warn(`Bundled tmux not usable at ${expected}; falling back to system tmux`);
  }

  const candidates = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"];
  for (const p of candidates) {
    if (fs.existsSync(p) && tryExec(p)) return p;
  }
  return "tmux";
}

const TMUX = findTmux();

export function getTmuxPath(): string {
  return TMUX;
}

export function getBundledTerminfoPath(): string | null {
  const resourcesPath = getProcessResourcesPath();
  if (!resourcesPath) return null;
  const bundled = path.join(resourcesPath, "tmux", "terminfo");
  return fs.existsSync(bundled) ? bundled : null;
}

export function getTmuxEnv(extra?: Record<string, string | undefined>): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  const extraPaths = ["/opt/homebrew/bin", "/usr/local/bin"];
  const currentPath = env.PATH || "";
  const missing = extraPaths.filter((p) => !currentPath.split(":").includes(p));
  if (missing.length) env.PATH = [...missing, currentPath].filter(Boolean).join(":");

  env.TERM = extra?.TERM || env.TERM || "xterm-256color";
  env.SHELL = extra?.SHELL || env.SHELL || "/bin/zsh";
  env.LANG = extra?.LANG || env.LANG || "en_US.UTF-8";
  env.LC_ALL = extra?.LC_ALL || env.LC_ALL || "en_US.UTF-8";

  const bundledTerminfo = getBundledTerminfoPath();
  if (bundledTerminfo) {
    env.TERMINFO = bundledTerminfo;
    env.TERMINFO_DIRS = bundledTerminfo;
  } else {
    env.TERMINFO = extra?.TERMINFO || env.TERMINFO || "/usr/share/terminfo";
    env.TERMINFO_DIRS = extra?.TERMINFO_DIRS || env.TERMINFO_DIRS || "/usr/share/terminfo:/usr/share/lib/terminfo:/opt/homebrew/share/terminfo:/usr/local/share/terminfo";
  }

  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined) env[key] = value;
    }
  }
  return env;
}

function execTmux(args: string[]): string {
  return execFileSync(TMUX, args, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: getTmuxEnv(),
  });
}

function execTmuxQuiet(args: string[]): void {
  execFileSync(TMUX, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: getTmuxEnv(),
  });
}

export function listSessions(): TmuxSession[] {
  try {
    const out = execTmux(["list-sessions", "-F", "#{session_name}|#{session_windows}|#{session_created}|#{session_attached}"]);
    return out
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, windows, created, attached] = line.split("|");
        return {
          name,
          windows: parseInt(windows, 10),
          created: new Date(parseInt(created, 10) * 1000).toISOString(),
          attached: attached !== "0",
        };
      });
  } catch {
    return [];
  }
}

export function sessionExists(name: string): boolean {
  try {
    execTmuxQuiet(["has-session", "-t", name]);
    return true;
  } catch {
    return false;
  }
}

export function createSession(name: string, shell?: string): void {
  if (sessionExists(name)) return;
  const home = process.env.HOME || "/";
  const args = ["new-session", "-d", "-s", name, "-c", home];
  if (shell) args.push(shell);
  execTmuxQuiet(args);
}

export function killSession(name: string): void {
  execTmuxQuiet(["kill-session", "-t", name]);
}

export function captureSessionPane(name: string, lines = 1000): string {
  try {
    return execTmux(["capture-pane", "-p", "-e", "-J", "-S", `-${lines}`, "-t", name]);
  } catch {
    return "";
  }
}
export function scrollSessionPane(name: string, lines: number): void {
  if (!Number.isFinite(lines) || lines === 0) return;
  try {
    if (lines < 0) execTmuxQuiet(["copy-mode", "-u", "-t", name]);
    const command = lines < 0 ? "scroll-up" : "scroll-down";
    const count = Math.min(Math.max(Math.abs(Math.trunc(lines)), 1), 200);
    for (let i = 0; i < count; i += 1) {
      execTmuxQuiet(["send-keys", "-t", name, "-X", command]);
    }
  } catch {
  }
}

export function exitSessionCopyMode(name: string): void {
  try {
    const inMode = execTmux(["display-message", "-p", "-t", name, "#{pane_in_mode}"]).trim();
    if (inMode === "1") execTmuxQuiet(["send-keys", "-t", name, "-X", "cancel"]);
  } catch {
  }
}


export function respawnSessionPane(name: string, shell?: string): void {
  try {
    execTmuxQuiet(["respawn-pane", "-k", "-t", name, shell || process.env.SHELL || "/bin/zsh"]);
  } catch {
    try {
      if (!sessionExists(name)) createSession(name, shell);
    } catch {
    }
  }
}
