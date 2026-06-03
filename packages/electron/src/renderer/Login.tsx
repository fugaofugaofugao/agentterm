import React, { useState } from "react"

interface LoginProps {
  onLogin: (username: string) => void
  onReset?: () => void
}

export default function Login({ onLogin, onReset }: LoginProps) {
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [resetting, setResetting] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    setLoading(true)
    const result = await window.termSync.login(username, password)
    setLoading(false)
    if (result.success) {
      onLogin(result.username!)
    } else {
      setError(result.error || "Login failed")
    }
  }

  const handleReset = async () => {
    if (!confirm("Reset all configuration? This will clear your host/client setup and restart the app.")) return
    setResetting(true)
    try {
      await window.termSync.configReset()
    } catch {
      setResetting(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>AgentTerm Monitor</h1>
        <form onSubmit={handleSubmit}>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Username"
            autoFocus
            required
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            required
          />
          <button type="submit" disabled={loading}>
            {loading ? "..." : "Login"}
          </button>
          {error && <p className="login-error">{error}</p>}
        </form>
        <button
          type="button"
          className="reset-btn"
          onClick={handleReset}
          disabled={resetting}
        >
          {resetting ? "Resetting..." : "Reset Configuration"}
        </button>
      </div>
    </div>
  )
}
