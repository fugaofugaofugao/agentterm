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
    window.termSync.configStatus().then((status) => {
      if (!status.configured) {
        setView("setup")
        return
      }
      window.termSync.configGetMode().then((m) => {
        if (m.mode) setMode(m.mode)
      })
      window.termSync.checkAuth().then((auth) => {
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
    const list = await window.termSync.listSessions()
    setSessions(list)
  }, [])

  useEffect(() => {
    if (user && view === "main") refreshSessions()
  }, [user, view, refreshSessions])

  useEffect(() => {
    if (!user) return
    const cleanup = window.termSync.onSessionExit(() => {
      refreshSessions()
    })
    return cleanup
  }, [user, refreshSessions])

  const handleSetupComplete = (username: string) => {
    window.termSync.configGetMode().then((m) => {
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
    await window.termSync.createSession(name)
    await refreshSessions()
    setActiveSession(name)
    const cfg = await window.termSync.configGet()
    setActiveDeviceId(cfg?.device_id || null)
  }

  const handleKillSession = async (name: string, deviceId: string | null) => {
    const result = await window.termSync.killSession(name, deviceId)
    if (result && result.error) { alert(result.error); return }
    if (activeSession === name && activeDeviceId === deviceId) {
      setActiveSession(null)
      setActiveDeviceId(null)
    }
    await refreshSessions()
  }

  const handleResetSession = async (name: string, deviceId: string | null) => {
    const result = await window.termSync.resetSession(name, deviceId)
    if (result && result.error) { alert(result.error); return }
    await refreshSessions()
    setActiveDeviceId(deviceId)
    setTermKey(k => k + 1)
  }

  const handleLogout = async () => {
    await window.termSync.logout()
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
