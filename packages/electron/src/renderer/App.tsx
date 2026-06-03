import React, { useState, useEffect, useCallback } from "react"
import Login from "./Login"
import Setup from "./Setup"
import Settings from "./Settings"
import Sidebar from "./Sidebar"
import Terminal from "./Terminal"

type View = "loading" | "setup" | "login" | "main" | "settings"

interface SessionInfo {
  name: string
  windows: number
  created: string
  attached: boolean
  owner?: string
  device?: { id: string; name: string; type: "host" | "client" }
}

export default function App() {
  const [view, setView] = useState<View>("loading")
  const [user, setUser] = useState<string | null>(null)
  const [mode, setMode] = useState<"host" | "client">("host")
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [activeSession, setActiveSession] = useState<string | null>(null)
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(null)
  const [termKey, setTermKey] = useState(0)

  useEffect(() => {
    window.agentTerm.configStatus().then((status) => {
      if (!status.configured) {
        setView("setup")
        return
      }
      window.agentTerm.configGetMode().then((m) => {
        if (m.mode) setMode(m.mode)
      })
      window.agentTerm.checkAuth().then((auth) => {
        if (auth.authenticated) {
          setUser(auth.username)
          setView("main")
        } else {
          setView("login")
        }
      })
    })
  }, [])

  const refreshSessions = useCallback(async () => {
    const list = await window.agentTerm.listSessions()
    setSessions(list)
  }, [])

  useEffect(() => {
    if (user && view === "main") refreshSessions()
  }, [user, view, refreshSessions])

  useEffect(() => {
    if (!user) return
    const cleanup = window.agentTerm.onSessionExit(() => {
      refreshSessions()
    })
    return cleanup
  }, [user, refreshSessions])

  const handleSetupComplete = (username: string) => {
    window.agentTerm.configGetMode().then((m) => {
      if (m.mode) setMode(m.mode)
    })
    setUser(username)
    setView("main")
  }

  const handleLogin = (username: string) => {
    setUser(username)
    setView("main")
  }

  const handleSelectSession = (name: string, deviceId: string | null) => {
    setActiveSession(name)
    setActiveDeviceId(deviceId)
  }

  const handleCreateSession = async (name: string) => {
    await window.agentTerm.createSession(name)
    const cfg = await window.agentTerm.configGet()
    const deviceId = cfg?.device_id || null
    setSessions((prev) => prev.some((s) => s.name === name && (s.device?.id || null) === deviceId) ? prev : [
      ...prev,
      { name, windows: 1, created: new Date().toISOString(), attached: true, owner: user || "", device: { id: deviceId || "host", name: "Local", type: "host" } }
    ])
    setActiveSession(name)
    setActiveDeviceId(deviceId)
    setTimeout(refreshSessions, 600)
  }

  const handleKillSession = async (name: string, deviceId: string | null) => {
    const result = await window.agentTerm.killSession(name, deviceId)
    if (result && result.error) { alert(result.error); return }
    if (activeSession === name && activeDeviceId === deviceId) {
      setActiveSession(null)
      setActiveDeviceId(null)
    }
    await refreshSessions()
  }

  const handleResetSession = async (name: string, deviceId: string | null) => {
    const result = await window.agentTerm.resetSession(name, deviceId)
    if (result && result.error) { alert(result.error); return }
    await refreshSessions()
    setActiveDeviceId(deviceId)
    setTermKey(k => k + 1)
  }

  const handleLogout = async () => {
    await window.agentTerm.logout()
    setUser(null)
    setActiveSession(null)
    setActiveDeviceId(null)
    setSessions([])
    setView("login")
  }

  if (view === "loading") return null

  if (view === "setup") {
    return (
      <div className="app">
        <div className="titlebar" />
        <Setup onComplete={handleSetupComplete} />
      </div>
    )
  }

  if (view === "login") {
    return (
      <div className="app">
        <div className="titlebar" />
        <Login onLogin={handleLogin} />
      </div>
    )
  }

  if (view === "settings") {
    return (
      <div className="app">
        <div className="titlebar" />
        <Settings onBack={() => setView("main")} mode={mode} />
      </div>
    )
  }

  return (
    <div className="app">
      <div className="titlebar" />
      <div className="app-body">
        <Sidebar
          sessions={sessions}
          activeSession={activeSession}
          activeDeviceId={activeDeviceId}
          onSelect={handleSelectSession}
          onCreate={handleCreateSession}
          onKill={handleKillSession}
          onRefresh={refreshSessions}
          onResetSession={handleResetSession}
          onLogout={handleLogout}
          onSettings={() => setView("settings")}
          username={user!}
          mode={mode}
        />
        <div className="terminal-container">
          {activeSession ? (
            <Terminal key={`${activeSession}-${activeDeviceId}-${termKey}`} sessionName={activeSession} deviceId={activeDeviceId} />
          ) : (
            <div className="no-session">
              <p>Select or create a session</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
