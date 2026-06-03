import React, { useState } from "react"

interface SidebarProps {
  sessions: SessionInfo[]
  activeSession: string | null
  activeDeviceId: string | null
  onSelect: (name: string, deviceId: string | null) => void
  onCreate: (name: string) => void
  onKill: (name: string, deviceId: string | null) => void
  onRefresh: () => void
  onResetSession: (name: string, deviceId: string | null) => void
  onLogout: () => void
  onSettings: () => void
  username: string
  mode: "host" | "client"
}

interface SessionInfo {
  name: string
  windows: number
  created: string
  attached: boolean
  owner?: string
  device?: { id: string; name: string; type: "host" | "client" }
}

export default function Sidebar({ sessions, activeSession, activeDeviceId, onSelect, onCreate, onKill, onRefresh, onResetSession, onLogout, onSettings, username, mode }: SidebarProps) {
  const [newName, setNewName] = useState("")
  const [creating, setCreating] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [createError, setCreateError] = useState("")

  const handleRefresh = async () => {
    setRefreshing(true)
    await onRefresh()
    setTimeout(() => setRefreshing(false), 400)
  }

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name) return
    setCreateError("")
    try {
      await onCreate(name)
      setNewName("")
      setCreating(false)
    } catch (err: any) {
      setCreateError(err?.message || "Failed to create session")
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); handleCreate() }
    if (e.key === "Escape") { setCreating(false); setCreateError("") }
  }

  function deviceTag(s: SessionInfo): string {
    if (!s.device) return "local"
    return s.device.type === "host" ? "host" : "client"
  }

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">Sessions</span>
        <div className="sidebar-actions">
          <button className={`icon-btn ${refreshing ? "spinning" : ""}`} onClick={handleRefresh} title="Refresh list">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M1 1v5h5" /><path d="M2.5 10.5a6 6 0 1 0 1-4.5L1 6" />
            </svg>
          </button>
          <button className="icon-btn" onClick={() => { setCreating(true); setCreateError("") }} title="New session">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M8 2v12M2 8h12" />
            </svg>
          </button>
        </div>
      </div>

      {creating && (
        <div className="new-session-input">
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Session name..."
          />
          <button className="create-confirm-btn" onClick={handleCreate}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M2 8l4.5 4.5L14 3" /></svg>
          </button>
          <button className="create-cancel-btn" onClick={() => { setCreating(false); setCreateError("") }}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M3 3l10 10M13 3L3 13" /></svg>
          </button>
          {createError && <div className="create-error">{createError}</div>}
        </div>
      )}

      <div className="session-list">
        {sessions.map((s) => {
          const isActive = s.name === activeSession && (s.device?.id || null) === activeDeviceId
          const tag = deviceTag(s)
          return (
            <div key={`${s.device?.id || "l"}-${s.name}`} className={`session-item ${isActive ? "active" : ""}`} onClick={() => onSelect(s.name, s.device?.id || null)}>
              <div className="session-info">
                <div className="session-name-row">
                  <span className="session-name">{s.name}</span>
                  <span className={`session-tag tag-${tag}`}>{tag}</span>
                </div>
                <span className="session-meta">{s.windows} window{s.windows !== 1 ? "s" : ""}</span>
              </div>
              <div className="session-actions">
                {isActive && (
                  <button className="session-action-btn" onClick={(e) => { e.stopPropagation(); onResetSession(s.name, s.device?.id || null) }} title="Reset session">
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M1 1v5h5" /><path d="M2.5 10.5a6 6 0 1 0 1-4.5L1 6" />
                    </svg>
                  </button>
                )}
                <button className="kill-btn" onClick={(e) => { e.stopPropagation(); onKill(s.name, s.device?.id || null) }} title="Kill session">&times;</button>
              </div>
            </div>
          )
        })}
        {sessions.length === 0 && !creating && (
          <div className="no-sessions">No active sessions</div>
        )}
      </div>

      <div className="sidebar-footer">
        <span className="sidebar-user">{username}</span>
        <div className="sidebar-footer-actions">
          <button className="icon-btn" onClick={onSettings} title="Settings">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <circle cx="8" cy="8" r="2.5" />
              <path d="M13.5 8a5.5 5.5 0 0 0-.1-.8l1.3-1-.7-1.2-1.5.5a5.5 5.5 0 0 0-1.2-.7L11 3.3h-1.4l-.3 1.5a5.5 5.5 0 0 0-1.2.7l-1.5-.5-.7 1.2 1.3 1a5.5 5.5 0 0 0 0 1.6l-1.3 1 .7 1.2 1.5-.5a5.5 5.5 0 0 0 1.2.7l.3 1.5H11l.3-1.5a5.5 5.5 0 0 0 1.2-.7l1.5.5.7-1.2-1.3-1a5.5 5.5 0 0 0 .1-.8z" />
            </svg>
          </button>
          <button className="icon-btn" onClick={onLogout} title="Logout">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 2H3v12h3M11 4l4 4-4 4M7 8h8" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}
