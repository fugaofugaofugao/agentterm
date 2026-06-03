import React, { useState, useEffect } from "react"

interface SettingsProps {
  onBack: () => void
  mode: "host" | "client"
}

export default function Settings({ onBack, mode }: SettingsProps) {
  const [host, setHost] = useState("")
  const [port, setPort] = useState("")
  const [shell, setShell] = useState("")
  const [prefix, setPrefix] = useState("")
  const [remoteUrl, setRemoteUrl] = useState("")
  const [serverKey, setServerKey] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)
  const [launchAtLogin, setLaunchAtLogin] = useState(false)
  const [persistentMode, setPersistentMode] = useState(false)
  const [keepAwake, setKeepAwake] = useState(false)

  useEffect(() => {
    window.termSync.configGet().then((config) => {
      if (config) {
        setHost(config.server.host)
        setPort(String(config.server.port))
        setShell(config.tmux.default_shell)
        setPrefix(config.tmux.session_prefix)
        if (config.remote?.url) setRemoteUrl(config.remote.url)
        if (config.auth?.server_key) setServerKey(config.auth.server_key)
      }
      window.termSync.runtimeGetSettings().then((runtime) => {
        setLaunchAtLogin(!!runtime.launch_at_login)
        setPersistentMode(!!runtime.persistent_mode)
        setKeepAwake(!!runtime.keep_awake)
      }).finally(() => setLoading(false))
    })
  }, [])

  const handleCopyKey = () => {
    navigator.clipboard.writeText(serverKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setMessage(null)
    if (newPassword && newPassword !== confirmPassword) {
      setMessage({ text: "Passwords do not match", ok: false })
      return
    }
    setSaving(true)
    const updates: any = {}
    if (mode === "host") {
      updates.server = { host, port: Number(port) }
      updates.tmux = { default_shell: shell, session_prefix: prefix }
      if (newPassword) updates.auth = { password: newPassword }
    } else {
      updates.remote = { url: remoteUrl }
    }
    const result = await window.termSync.configSave(updates)
    const runtimeResult = await window.termSync.runtimeSaveSettings({ launch_at_login: launchAtLogin, persistent_mode: persistentMode, keep_awake: keepAwake })
    setSaving(false)
    if (result.success && runtimeResult.success) {
      setMessage({ text: "Settings saved", ok: true })
      setNewPassword("")
      setConfirmPassword("")
    } else {
      setMessage({ text: result.error || runtimeResult.error || "Save failed", ok: false })
    }
  }

  const handleReset = async () => {
    if (!confirmReset) {
      setConfirmReset(true)
      return
    }
    await window.termSync.configReset()
  }

  if (loading) return null

  return (
    <div className="settings-page">
      <div className="settings-header">
        <button className="icon-btn" onClick={onBack} title="Back">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M10 2L4 8l6 6" /></svg>
        </button>
        <h2>Settings</h2>
        <span className="mode-tag">{mode === "host" ? "Host" : "Client"}</span>
      </div>
      <form className="settings-form" onSubmit={handleSave}>
        {mode === "host" ? (
          <>
            <fieldset>
              <legend>Server Key</legend>
              <div className="field-row" style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                <input value={serverKey} readOnly style={{ fontFamily: "monospace", fontSize: "12px", flex: 1 }} />
                <button type="button" onClick={handleCopyKey} style={{ whiteSpace: "nowrap", padding: "8px 14px" }}>
                  {copied ? "Copied!" : "Copy"}
                </button>
              </div>
              <p style={{ fontSize: "11px", color: "#8888aa", marginTop: "4px" }}>
                Share this key with Client devices to allow connections
              </p>
            </fieldset>
            <fieldset>
              <legend>Server</legend>
              <div className="field-row">
                <label>Bind Address</label>
                <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="0.0.0.0" />
              </div>
              <div className="field-row">
                <label>Port</label>
                <input type="number" value={port} onChange={(e) => setPort(e.target.value)} placeholder="39488" />
              </div>
            </fieldset>
            <fieldset>
              <legend>Change Password</legend>
              <div className="field-row">
                <label>New Password</label>
                <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="Leave blank to keep" />
              </div>
              <div className="field-row">
                <label>Confirm</label>
                <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="Confirm new password" />
              </div>
            </fieldset>
            <fieldset>
              <legend>Tmux</legend>
              <div className="field-row">
                <label>Default Shell</label>
                <input value={shell} onChange={(e) => setShell(e.target.value)} placeholder="/bin/zsh" />
              </div>
              <div className="field-row">
                <label>Session Prefix</label>
                <input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="(optional)" />
              </div>
            </fieldset>
          </>
        ) : (
          <fieldset>
            <legend>Remote Server</legend>
            <div className="field-row">
              <label>Server URL</label>
              <input value={remoteUrl} onChange={(e) => setRemoteUrl(e.target.value)} placeholder="http://192.168.1.100:39488" />
            </div>
          </fieldset>
        )}

        <fieldset>
          <legend>Runtime</legend>
          <label className="toggle-row">
            <input type="checkbox" checked={launchAtLogin} onChange={(e) => setLaunchAtLogin(e.target.checked)} />
            <span>Launch at login</span>
          </label>
          <label className="toggle-row">
            <input type="checkbox" checked={persistentMode} onChange={(e) => setPersistentMode(e.target.checked)} />
            <span>Keep running in background after closing the window</span>
          </label>
          <label className="toggle-row">
            <input type="checkbox" checked={keepAwake} onChange={(e) => setKeepAwake(e.target.checked)} />
            <span>Keep AgentTerm Monitor awake while running</span>
          </label>
          <p style={{ fontSize: "11px", color: "#8888aa", marginTop: "6px" }}>
            Lock screen is OK, but if macOS enters full sleep network connections will still drop unless keep-awake is enabled.
          </p>
        </fieldset>
        <button type="submit" className="save-btn" disabled={saving}>
          {saving ? "Saving..." : "Save"}
        </button>
        {message && <p className={message.ok ? "settings-ok" : "settings-err"}>{message.text}</p>}
      </form>
      <div style={{ padding: "24px 18px", borderTop: "1px solid #2a2a4a", marginTop: "24px", maxWidth: "420px", margin: "24px auto 0" }}>
        <button
          type="button"
          onClick={handleReset}
          style={{
            width: "100%", padding: "12px", border: "1px solid #ff6b6b", borderRadius: "8px",
            background: confirmReset ? "#ff6b6b" : "transparent",
            color: confirmReset ? "#1a1a2e" : "#ff6b6b",
            fontSize: "14px", fontWeight: 600, cursor: "pointer",
          }}
        >
          {confirmReset ? "Confirm Reset — All data will be deleted" : "Reset All Data"}
        </button>
        <p style={{ fontSize: "11px", color: "#8888aa", marginTop: "6px", textAlign: "center" }}>
          Removes config, accounts, and restarts the app in setup mode
        </p>
      </div>
    </div>
  )
}
