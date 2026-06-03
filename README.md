# AgentTerm

**Remote monitor and control for Claude Code, Codex, Gemini CLI, and AI terminal agents.**

AgentTerm is a macOS-first remote terminal monitor and control platform for long-running AI coding agents and terminal tools such as **Claude Code**, **Codex**, **Gemini CLI**, and any tmux-based shell workflow.

Run your AI terminal sessions on a Host Mac, keep them alive in tmux, and monitor or take over from another Mac, a browser, or a phone.

## Why I built this

AI coding agents are most useful when they can keep working for long stretches: refactoring a project, running tests, fixing build failures, watching logs, or iterating on a feature. The problem is that these agents often live inside a terminal on one computer.

AgentTerm came from the need to continuously monitor tools like Claude Code while away from the desk. With it, you can leave your computer, check the current AI terminal state from a phone or another machine, type follow-up instructions, and let the agent continue project work from anywhere. The goal is simple: free AI-assisted development from one physical workspace.

## Features

- **Remote AI terminal monitoring** — watch Claude Code, Codex, Gemini CLI, shells, scripts, and build logs from a browser.
- **Remote control** — type into the same tmux-backed session from another device.
- **Host / Client device model** — a Host exposes Web UI and relay; Clients can sync their own local tmux sessions back to the Host.
- **Bundled tmux runtime** — packaged Electron app includes tmux and terminfo resources for consistent behavior.
- **Device-aware sessions** — sessions keep their owning device identity to avoid accidentally controlling the wrong machine.
- **Scrollback support** — browser and Electron terminals can browse tmux history.
- **Runtime options** — launch at login, keep running in background, and keep the app awake while AgentTerm is running.

## How the terminal reliability fixes work

AgentTerm uses tmux as the source of truth for terminal state. The v1.0.0 terminal fixes focus on making every entry point behave consistently:

- A shared tmux runtime helper resolves bundled tmux, terminfo, environment variables, pane capture, copy-mode scrolling, and copy-mode exit logic.
- Electron local sessions, browser WebSocket sessions, and Client relay sessions all reuse the same tmux helpers.
- Wheel and touch scrolling are converted into tmux copy-mode scroll commands, so browser and mobile scrollback reads the real tmux history.
- Before user input is written to a pty, AgentTerm exits tmux copy-mode so normal typing does not get interpreted as copy-mode control keys.
- Device-aware routing keeps Host and Client sessions separate even when sessions share the same name.

## Architecture

AgentTerm is a pnpm monorepo:

```text
.
├── packages/
│   ├── electron/   # Electron + React desktop app
│   ├── server/     # Express + WebSocket + browser terminal UI
│   └── shared/     # Config, auth, protocol, tmux helpers
├── config.example.yaml
├── pnpm-workspace.yaml
└── package.json
```

Core stack:

- Electron
- React
- xterm.js
- node-pty
- tmux
- Express
- WebSocket
- pnpm workspaces
- TypeScript

## Typical use cases

- Start Claude Code on your Mac and monitor it from your phone.
- Keep Codex or Gemini CLI running on a workstation while controlling it from a laptop.
- Share a tmux-backed terminal session between Electron and a browser.
- Monitor long-running AI-assisted refactors, builds, tests, and server logs.

## Setup overview

### Host mode

Use Host mode on the machine that exposes the Web UI and accepts Client connections.

1. Open AgentTerm.
2. Select **Host** during setup.
3. Create an admin username/password.
4. Copy the generated Server Key if you want Clients to connect.
5. Open the Web UI at the configured host/port, for example:

```text
http://127.0.0.1:39488
http://your-host:39488
```

### Client mode

Use Client mode on another Mac whose local tmux sessions should appear on the Host.

1. Open AgentTerm on the Client machine.
2. Select **Client** during setup.
3. Enter the Host URL and Server Key.
4. Log in or register a user through the Host.
5. Client sessions should appear in Host Electron and Web UI with a Client badge.

## Configuration

AgentTerm stores real runtime configuration locally. Do **not** commit real config files.

Use `config.example.yaml` only as a template:

```yaml
server:
  host: 127.0.0.1
  port: 39488

auth:
  jwt_secret: change-this-to-a-random-string
  server_key: change-this-server-key
  users: []

tmux:
  default_shell: /bin/zsh
  aggressive_resize: true
  session_prefix: ""
```

Real config may contain JWT secrets, server keys, users, and remote URLs. Keep it private.

## Development

Install dependencies:

```bash
pnpm install
```

Build packages:

```bash
pnpm build:shared
pnpm build:server
pnpm build:electron
```

Run server in development:

```bash
pnpm dev:server
```

Run Electron in development:

```bash
pnpm dev:electron
```

Package macOS app:

```bash
pnpm --filter @agentterm/electron package
```

## Security notes

- Do not expose AgentTerm directly to the public Internet without HTTPS, strong passwords, and network access controls.
- Treat Server Keys and JWT secrets as credentials.
- Rotate secrets if a config file is accidentally shared.
- AgentTerm is intended for your own devices and trusted networks.

## License

Apache License 2.0. See [LICENSE](LICENSE).
