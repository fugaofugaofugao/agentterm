import React, { useState } from "react"

interface SetupProps {
  onComplete: (username: string) => void
}

type Step = "mode" | "host" | "host-done" | "client"

export default function Setup({ onComplete }: SetupProps) {
  const [step, setStep] = useState<Step>("mode")
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [port, setPort] = useState("39488")
  const [serverUrl, setServerUrl] = useState("")
  const [serverKey, setServerKey] = useState("")
  const [generatedKey, setGeneratedKey] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)

  const handleHostSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    if (password !== confirmPassword) { setError("Passwords do not match"); return }
    if (password.length < 4) { setError("Password must be at least 4 characters"); return }
    setLoading(true)
    try {
      const result = await window.termSync.configSetupHost(username, password, Number(port) || undefined)
      if (result.success) {
        setGeneratedKey(result.server_key || "")
        setStep("host-done")
      } else {
        setError(result.error || "Setup failed")
      }
    } catch (err: any) { setError(err.message || "Setup failed") }
    setLoading(false)
  }

  const handleClientSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    if (!serverUrl.trim()) { setError("Server URL is required"); return }
    if (!serverKey.trim()) { setError("Server key is required"); return }
    if (!username.trim() || !password.trim()) { setError("Username and password are required"); return }
    setLoading(true)
    try {
      const result = await window.termSync.configSetupClient(serverUrl.trim(), serverKey.trim(), username, password)
      if (result.success) onComplete(result.username!)
      else setError(result.error || "Connection failed")
    } catch (err: any) { setError(err.message || "Setup failed") }
    setLoading(false)
  }

  const handleCopyKey = () => {
    navigator.clipboard.writeText(generatedKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  if (step === "mode") {
    return (
      <div className="login-page">
        <div className="login-card setup-card">
          <h1>AgentTerm Monitor</h1>
          <p className="setup-subtitle">Choose deployment mode</p>
          <div className="mode-options">
            <button className="mode-btn" onClick={() => setStep("host")}>
              <span className="mode-icon">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" />
                </svg>
              </span>
              <span className="mode-title">Host Mode</span>
              <span className="mode-desc">Deploy AgentTerm Monitor server on this machine</span>
            </button>
            <button className="mode-btn" onClick={() => setStep("client")}>
              <span className="mode-icon">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </span>
              <span className="mode-title">Client Mode</span>
              <span className="mode-desc">Connect to an existing AgentTerm Monitor server</span>
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (step === "host") {
    return (
      <div className="login-page">
        <div className="login-card setup-card">
          <div className="setup-back">
            <button className="icon-btn" onClick={() => { setStep("mode"); setError("") }}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M10 2L4 8l6 6" /></svg>
            </button>
            <h1>Host Setup</h1>
          </div>
          <form onSubmit={handleHostSubmit}>
            <label className="field-label">Admin Account</label>
            <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" autoFocus required />
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" required />
            <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="Confirm password" required />
            <label className="field-label" style={{ marginTop: "12px" }}>Server Port</label>
            <input type="number" value={port} onChange={(e) => setPort(e.target.value)} placeholder="39488" />
            <button type="submit" disabled={loading}>{loading ? "Setting up..." : "Start Server"}</button>
            {error && <p className="login-error">{error}</p>}
          </form>
        </div>
      </div>
    )
  }

  if (step === "host-done") {
    return (
      <div className="login-page">
        <div className="login-card setup-card">
          <h1 style={{ color: "#51cf66" }}>Setup Complete</h1>
          <p className="setup-subtitle">Share this key with Client devices</p>
          <div className="server-key-display">
            <code className="server-key-value">{generatedKey}</code>
            <button type="button" className="copy-btn" onClick={handleCopyKey}>
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          <p style={{ fontSize: "12px", color: "#8888aa", margin: "12px 0" }}>
            Client devices need this key to connect to your server. You can find it later in Settings.
          </p>
          <button onClick={() => onComplete(username)} style={{
            width: "100%", padding: "12px", border: "none", borderRadius: "8px",
            background: "#00d4ff", color: "#1a1a2e", fontSize: "16px",
            fontWeight: 600, cursor: "pointer", marginTop: "8px"
          }}>Continue</button>
        </div>
      </div>
    )
  }

  return (
    <div className="login-page">
      <div className="login-card setup-card">
        <div className="setup-back">
          <button className="icon-btn" onClick={() => { setStep("mode"); setError("") }}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M10 2L4 8l6 6" /></svg>
          </button>
          <h1>Connect to Server</h1>
        </div>
        <form onSubmit={handleClientSubmit}>
          <label className="field-label">Server URL</label>
          <input type="text" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="http://192.168.1.100:39488" required />
          <label className="field-label" style={{ marginTop: "12px" }}>Server Key</label>
          <input type="text" value={serverKey} onChange={(e) => setServerKey(e.target.value)} placeholder="Paste server key here" style={{ fontFamily: "monospace", fontSize: "13px" }} required />
          <label className="field-label" style={{ marginTop: "12px" }}>Account</label>
          <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" required />
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" required />
          <p style={{ fontSize: "11px", color: "#8888aa", margin: "4px 0 12px" }}>
            New username will register automatically. Existing username requires correct password.
          </p>
          <button type="submit" disabled={loading}>{loading ? "Connecting..." : "Connect"}</button>
          {error && <p className="login-error">{error}</p>}
        </form>
      </div>
    </div>
  )
}
