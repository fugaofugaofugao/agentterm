import { execFileSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { TmuxSession } from "./types";

export interface TmuxScrollState {
  scrollPosition: number;
  historySize: number;
  paneHeight: number;
  inCopyMode: boolean;
}

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

export function createSession(name: string, shell?: string, cols?: number, rows?: number): void {
  if (sessionExists(name)) return;
  const home = process.env.HOME || "/";
  const args = ["new-session", "-d", "-s", name];
  if (Number.isFinite(cols) && Number.isFinite(rows) && cols && rows) {
    args.push("-x", String(Math.max(20, Math.trunc(cols))), "-y", String(Math.max(5, Math.trunc(rows))));
  }
  args.push("-c", home);
  if (shell) args.push(shell);
  execTmuxQuiet(args);
}

export function killSession(name: string): void {
  execTmuxQuiet(["kill-session", "-t", name]);
}

export function clearSessionHistory(name: string): void {
  try {
    execTmuxQuiet(["clear-history", "-t", name]);
  } catch {
  }
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
    const count = Math.min(Math.max(Math.abs(Math.trunc(lines)), 1), 200);
    const state = getSessionScrollState(name);

    if (lines < 0) {
      // Ignore tiny tmux history created by attach/resize/prompt redraw. Those
      // few bookkeeping lines are what made a fresh one-line prompt become
      // [3/3] with duplicate ghost prompts when the user merely nudged upward.
      if (!state.inCopyMode && state.historySize <= 3) return;

      // Enter copy-mode without the implicit one-page jump from `copy-mode -u`.
      // `-e` lets tmux leave copy-mode when the view returns to the live screen;
      // `-H` hides the position badge so it does not look like terminal output.
      if (!state.inCopyMode) execTmuxQuiet(["copy-mode", "-e", "-H", "-t", name]);
      execTmuxQuiet(["send-keys", "-t", name, "-N", String(count), "-X", "scroll-up"]);
      return;
    }

    if (!state.inCopyMode) return;
    execTmuxQuiet(["send-keys", "-t", name, "-N", String(count), "-X", "scroll-down"]);
    const after = getSessionScrollState(name);
    if (after.scrollPosition <= 0) execTmuxQuiet(["send-keys", "-t", name, "-X", "cancel"]);
  } catch {
  }
}

export function getSessionScrollState(name: string): TmuxScrollState {
  try {
    const out = execTmux(["display-message", "-p", "-t", name, "#{scroll_position}|#{history_size}|#{pane_height}|#{pane_in_mode}"]).trim();
    const [scrollPosition, historySize, paneHeight, inCopyMode] = out.split("|");
    return {
      scrollPosition: Math.max(0, parseInt(scrollPosition || "0", 10) || 0),
      historySize: Math.max(0, parseInt(historySize || "0", 10) || 0),
      paneHeight: Math.max(0, parseInt(paneHeight || "0", 10) || 0),
      inCopyMode: inCopyMode === "1",
    };
  } catch {
    return { scrollPosition: 0, historySize: 0, paneHeight: 0, inCopyMode: false };
  }
}

export function exitSessionCopyMode(name: string): void {
  try {
    const inMode = execTmux(["display-message", "-p", "-t", name, "#{pane_in_mode}"]).trim();
    if (inMode === "1") execTmuxQuiet(["send-keys", "-t", name, "-X", "cancel"]);
  } catch {
  }
}


export function resetSessionFresh(name: string, shell?: string, cols?: number, rows?: number): void {
  try {
    exitSessionCopyMode(name);
  } catch {
  }

  try {
    if (sessionExists(name)) {
      killSession(name);
    }
    createSession(name, shell, cols, rows);
    clearSessionHistory(name);
    return;
  } catch {
  }

  try {
    respawnSessionPane(name, shell);
    clearSessionHistory(name)
  } catch {
    try { if (!sessionExists(name)) createSession(name, shell, cols, rows); } catch {}
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
