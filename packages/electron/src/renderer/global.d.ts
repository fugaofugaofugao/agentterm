interface TmuxSession {
  name: string
  windows: number
  created: string
  attached: boolean
  owner?: string
  device?: {
    id: string
    name: string
    type: "host" | "client"
  }
}

interface AgentTermAPI {
  configStatus(): Promise<{ configured: boolean }>
  configGetMode(): Promise<{ mode: "host" | "client" | null }>
  configSetupHost(username: string, password: string, port?: number): Promise<{ success: boolean; error?: string; username?: string; server_key?: string }>
  configSetupClient(url: string, serverKey: string, username: string, password: string): Promise<{ success: boolean; error?: string; username?: string }>
  configGet(): Promise<any>
  configSave(updates: any): Promise<{ success: boolean; error?: string }>
  configReset(): Promise<{ success: boolean; error?: string }>
  runtimeGetSettings(): Promise<{ launch_at_login: boolean; persistent_mode: boolean; keep_awake: boolean }>
  runtimeSaveSettings(runtime: any): Promise<{ success: boolean; error?: string }>

  remoteLogin(url: string, username: string, password: string): Promise<{ success: boolean; error?: string }>
  remoteTestConnection(url: string): Promise<{ success: boolean; error?: string }>

  login(username: string, password: string): Promise<{ success: boolean; error?: string; username?: string }>
  checkAuth(): Promise<{ authenticated: boolean; username: string | null }>
  logout(): Promise<void>

  listSessions(): Promise<TmuxSession[]>
  createSession(name: string): Promise<void>
  killSession(name: string, deviceId?: string | null): Promise<{ success?: boolean; error?: string } | void>
  resetSession(name: string, deviceId?: string | null): Promise<{ success?: boolean; error?: string } | void>

  attachSession(name: string, cols?: number, rows?: number, deviceId?: string | null): Promise<void>
  detachSession(name: string, deviceId?: string | null): Promise<void>
  sendInput(session: string, data: string, deviceId?: string | null): void
  resize(session: string, cols: number, rows: number, deviceId?: string | null): void
  scroll(session: string, lines: number, deviceId?: string | null): void

  onOutput(callback: (session: string, data: string, deviceId?: string | null) => void): () => void
  onSessionExit(callback: (session: string, deviceId?: string | null) => void): () => void
}

interface Window {
  agentTerm: AgentTermAPI
}
