import React, { useEffect, useRef } from "react"
import { Terminal as XTerm } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebLinksAddon } from "@xterm/addon-web-links"
import { Unicode11Addon } from "@xterm/addon-unicode11"
import "@xterm/xterm/css/xterm.css"

interface TerminalProps {
  sessionName: string
  deviceId: string | null
}

import { attachTerminalInteractionController } from "./terminalInteraction"

export default function Terminal({ sessionName, deviceId }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const scrollHandleRef = useRef<HTMLDivElement>(null)
  const scrollThumbRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    const scrollHandle = scrollHandleRef.current
    const scrollThumb = scrollThumbRef.current
    const shell = container?.parentElement as HTMLElement | null
    if (!container || !scrollHandle || !scrollThumb || !shell) return

    const term = new XTerm({
      fontFamily: "Menlo, Monaco, \"Courier New\", monospace",
      fontSize: 14,
      lineHeight: 1.2,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
      customGlyphs: false,
      theme: {
        background: "#1a1a2e",
        foreground: "#e0e0e0",
        cursor: "#00d4ff",
        selectionBackground: "rgba(0, 212, 255, 0.3)",
        black: "#1a1a2e",
        red: "#ff6b6b",
        green: "#51cf66",
        yellow: "#ffd43b",
        blue: "#339af0",
        magenta: "#cc5de8",
        cyan: "#00d4ff",
        white: "#e0e0e0",
        brightBlack: "#495057",
        brightRed: "#ff6b6b",
        brightGreen: "#51cf66",
        brightYellow: "#ffd43b",
        brightBlue: "#339af0",
        brightMagenta: "#cc5de8",
        brightCyan: "#00d4ff",
        brightWhite: "#f8f9fa",
      },
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(new WebLinksAddon())
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = "11"
    term.open(container)

    let failed = false
    let attached = false
    const clientId = `electron:${deviceId || "local"}:${sessionName}:${Date.now()}`
    let resizeRole: "controller" | "observer" = "controller"
    let applyingRemoteSize = false
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    let lastSentSize = ""
    let writeQueue: string[] = []
    let writing = false

    const fitIfVisible = () => {
      if (container.clientWidth <= 0 || container.clientHeight <= 0) return false
      try { fitAddon.fit(); return true } catch { return false }
    }
    const refreshTerminalView = (scrollToBottom = false, allowFit = false) => {
      requestAnimationFrame(() => {
        if (failed) return
        if (allowFit && resizeRole === "controller") fitIfVisible()
        if (scrollToBottom) { try { term.scrollToBottom() } catch {} }
        try { (term as any).refresh?.(0, Math.max(0, term.rows - 1)) } catch {}
      })
    }
    const sendResizeIntent = () => {
      if (failed || applyingRemoteSize || !fitIfVisible()) return
      resizeRole = "controller"
      try { window.agentTerm.resizeIntent(sessionName, term.cols, term.rows, deviceId, clientId) } catch {}
    }
    const sendControllerResize = () => {
      if (failed || applyingRemoteSize || resizeRole !== "controller" || !fitIfVisible()) return
      const sizeKey = `${term.cols}x${term.rows}`
      if (sizeKey === lastSentSize) return
      lastSentSize = sizeKey
      try { window.agentTerm.resize(sessionName, term.cols, term.rows, deviceId, clientId) } catch {}
    }
    const scheduleControllerResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(sendControllerResize, 100)
    }
    const pumpWriteQueue = () => {
      if (writing || !writeQueue.length) return
      const chunk = writeQueue.shift() || ""
      writing = true
      term.write(chunk, () => {
        writing = false
        refreshTerminalView(false)
        pumpWriteQueue()
      })
    }
    const enqueueWrite = (data: string) => {
      if (!data) return
      const maxChunk = 8192
      for (let i = 0; i < data.length; i += maxChunk) writeQueue.push(data.slice(i, i + maxChunk))
      pumpWriteQueue()
    }
    const clearTerminal = () => {
      writeQueue = []
      try { term.clear() } catch {}
      try { term.reset() } catch {}
      writing = true
      term.write("\x1b[3J\x1b[2J\x1b[H", () => {
        writing = false
        refreshTerminalView(true)
        pumpWriteQueue()
      })
    }
    const showError = (err: any) => {
      failed = true
      const message = err?.message || String(err) || "Unknown error"
      term.writeln("\r\n\x1b[31mFailed to attach session:\x1b[0m " + message)
      term.writeln("\x1b[90mThe session view will stay open so this error can be read.\x1b[0m")
    }

    const controller = attachTerminalInteractionController({
      terminal: term,
      shell,
      container,
      scrollHandle,
      scrollThumb,
      remotePane: !!deviceId,
      sendScroll: (lines) => window.agentTerm.scroll(sessionName, lines, deviceId),
      sendInput: (data) => window.agentTerm.sendInput(sessionName, data, deviceId),
      onInputFocus: sendResizeIntent,
      onRefresh: () => refreshTerminalView(false),
    })

    const requestControl = () => { try { sendResizeIntent() } catch {} }
    container.addEventListener("focusin", requestControl)
    container.addEventListener("pointerdown", requestControl, { passive: true })

    const doFitAndAttach = () => {
      if (failed || !fitIfVisible()) return
      if (!attached) {
        attached = true
        window.agentTerm.attachSession(sessionName, term.cols, term.rows, deviceId)
          .then(() => { sendResizeIntent(); refreshTerminalView(true, false) })
          .catch(showError)
      } else {
        scheduleControllerResize()
        refreshTerminalView(false, resizeRole === "controller")
      }
    }

    const t1 = requestAnimationFrame(doFitAndAttach)
    const t2 = setTimeout(doFitAndAttach, 180)
    const t3 = setTimeout(() => refreshTerminalView(true), 350)
    const t4 = setTimeout(() => refreshTerminalView(true), 1000)

    const removeOutput = window.agentTerm.onOutput((session, data, outputDeviceId) => {
      if (session === sessionName && (outputDeviceId || null) === (deviceId || null)) enqueueWrite(data)
    })
    const removeClear = window.agentTerm.onClear((session, outputDeviceId) => {
      if (session === sessionName && (outputDeviceId || null) === (deviceId || null)) clearTerminal()
    })
    const removeSize = window.agentTerm.onSize((session, size, outputDeviceId) => {
      if (session === sessionName && (outputDeviceId || null) === (deviceId || null) && size.cols && size.rows) {
        resizeRole = size.role === "controller" || size.controllerId === clientId ? "controller" : "observer"
        if (size.sourceClientId === clientId || (size.controllerId === clientId && resizeRole === "controller")) return
        applyingRemoteSize = true
        try { term.resize(Number(size.cols), Number(size.rows)) } catch {}
        requestAnimationFrame(() => { applyingRemoteSize = false; refreshTerminalView(true, false) })
      }
    })
    const removeScrollState = window.agentTerm.onScrollState((session, state, outputDeviceId) => {
      if (session === sessionName && (outputDeviceId || null) === (deviceId || null)) controller.updateScrollState(state)
    })
    const observer = new ResizeObserver(() => {
      if (failed || applyingRemoteSize) return
      if (resizeRole === "controller" && fitIfVisible()) scheduleControllerResize()
      refreshTerminalView(false, false)
    })
    observer.observe(container)

    return () => {
      cancelAnimationFrame(t1)
      clearTimeout(t2)
      clearTimeout(t3)
      clearTimeout(t4)
      if (resizeTimer) clearTimeout(resizeTimer)
      observer.disconnect()
      container.removeEventListener("focusin", requestControl)
      container.removeEventListener("pointerdown", requestControl)
      controller.dispose()
      removeOutput()
      removeClear()
      removeSize()
      removeScrollState()
      window.agentTerm.detachSession(sessionName, deviceId)
      term.dispose()
    }
  }, [sessionName, deviceId])

  return (
    <div className="terminal-shell">
      <div ref={containerRef} className="terminal" />
      <div ref={scrollHandleRef} className="terminal-scroll-handle" title="Drag to scroll terminal history">
        <div ref={scrollThumbRef} className="terminal-scroll-thumb" />
      </div>
    </div>
  )
}
