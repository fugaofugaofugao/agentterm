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

export default function Terminal({ sessionName, deviceId }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const scrollHandleRef = useRef<HTMLDivElement>(null)
  const scrollThumbRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!containerRef.current) return

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
        brightRed: "#ff8787",
        brightGreen: "#69db7c",
        brightYellow: "#ffe066",
        brightBlue: "#5c7cfa",
        brightMagenta: "#da77f2",
        brightCyan: "#3bc9db",
        brightWhite: "#f8f9fa",
      },
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(new WebLinksAddon())
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = "11"

    term.open(containerRef.current)

    const requestControl = () => { try { sendResizeIntent() } catch {} }
    containerRef.current.addEventListener("focusin", requestControl)
    containerRef.current.addEventListener("pointerdown", requestControl, { passive: true })

    let failed = false

    const termElement = containerRef.current.querySelector(".xterm") as HTMLElement | null
    const scrollTargets = [
      termElement,
      termElement?.querySelector(".xterm-viewport") as HTMLElement | null,
      termElement?.querySelector(".xterm-screen") as HTMLElement | null,
    ].filter(Boolean) as HTMLElement[]
    let touchStartY = 0
    let accumulatedTouch = 0
    let pendingScrollLines = 0
    let scrollFrame = 0
    const linePx = 18
    const scrollState = { scrollPosition: 0, historySize: 0, paneHeight: 0, inCopyMode: false }
    const usesTmuxScroll = () => scrollState.paneHeight > 0
    const getLocalScrollState = () => {
      const buffer = term.buffer.active
      const historySize = Math.max(0, buffer.baseY)
      const scrollPosition = Math.max(0, buffer.baseY - buffer.viewportY)
      return { scrollPosition, historySize, paneHeight: term.rows }
    }
    const getEffectiveScrollState = () => usesTmuxScroll() ? scrollState : getLocalScrollState()
    const updateScrollThumb = () => {
      const handle = scrollHandleRef.current
      const thumb = scrollThumbRef.current
      if (!handle || !thumb) return
      const state = getEffectiveScrollState()
      const hasScrollableHistory = state.historySize > 0 || state.scrollPosition > 0
      handle.style.display = hasScrollableHistory ? "block" : "none"
      if (!hasScrollableHistory) return
      const trackHeight = handle.clientHeight
      const thumbHeight = Math.max(44, Math.min(96, Math.round(trackHeight * Math.max(0.12, Math.min(0.45, state.paneHeight / Math.max(state.historySize + state.paneHeight, 1))))))
      const maxTop = Math.max(0, trackHeight - thumbHeight)
      const maxScroll = Math.max(1, state.historySize)
      const ratio = 1 - Math.max(0, Math.min(1, state.scrollPosition / maxScroll))
      thumb.style.height = thumbHeight + "px"
      thumb.style.transform = `translateY(${Math.round(maxTop * ratio)}px)`
    }
    const fitIfVisible = () => {
      const container = containerRef.current
      if (!container || container.clientWidth <= 0 || container.clientHeight <= 0) return false
      try { fitAddon.fit(); return true } catch { return false }
    }
    const refreshTerminalView = (scrollToBottom = false, allowFit = false) => {
      requestAnimationFrame(() => {
        if (failed) return
        if (allowFit && resizeRole === "controller") fitIfVisible()
        if (scrollToBottom) { try { term.scrollToBottom() } catch {} }
        try { (term as any).refresh?.(0, Math.max(0, term.rows - 1)) } catch {}
        requestAnimationFrame(updateScrollThumb)
      })
    }
    const stabilizeImeLayout = () => {
      requestAnimationFrame(() => {
        if (failed) return
        if (resizeRole === "controller") {
          const fitted = fitIfVisible()
          if (fitted) scheduleControllerResize()
        }
        refreshTerminalView(false)
      })
    }
    const helperTextarea = containerRef.current.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement | null
    const compositionEvents = ["compositionstart", "compositionupdate", "compositionend", "input"] as const
    compositionEvents.forEach((eventName) => helperTextarea?.addEventListener(eventName, stabilizeImeLayout))
    const flushScroll = () => {
      scrollFrame = 0
      if (!pendingScrollLines) return
      const lines = Math.max(-120, Math.min(120, pendingScrollLines))
      pendingScrollLines -= lines
      if (usesTmuxScroll()) window.agentTerm.scroll(sessionName, lines, deviceId)
      else { term.scrollLines(lines); requestAnimationFrame(updateScrollThumb) }
      if (pendingScrollLines) scrollFrame = requestAnimationFrame(flushScroll)
    }
    const queueScroll = (lines: number) => {
      if (usesTmuxScroll()) {
        if (scrollState.historySize > 0) {
          scrollState.scrollPosition = Math.max(0, Math.min(scrollState.historySize, scrollState.scrollPosition - lines))
          updateScrollThumb()
        }
      }
      pendingScrollLines += lines
      if (!scrollFrame) scrollFrame = requestAnimationFrame(flushScroll)
    }
    const stopScrollEvent = (event: WheelEvent | TouchEvent) => {
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
    }
    const handleWheel = (event: WheelEvent) => {
      stopScrollEvent(event)
      const delta = event.deltaY || -event.wheelDelta || 0
      const lines = Math.max(1, Math.round(Math.abs(delta) / linePx))
      queueScroll(delta > 0 ? lines : -lines)
    }
    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length === 1) {
        touchStartY = event.touches[0].clientY
        accumulatedTouch = 0
      }
    }
    const handleTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1) return
      stopScrollEvent(event)
      const dy = touchStartY - event.touches[0].clientY
      touchStartY = event.touches[0].clientY
      accumulatedTouch += dy
      while (Math.abs(accumulatedTouch) >= linePx) {
        queueScroll(accumulatedTouch > 0 ? 1 : -1)
        accumulatedTouch += accumulatedTouch > 0 ? -linePx : linePx
      }
    }
    let pointerStartY = 0
    let pointerStartScroll = 0
    let pointerAccumulated = 0
    const handleScrollPointerMove = (event: PointerEvent) => {
      event.preventDefault()
      const handle = scrollHandleRef.current
      const thumb = scrollThumbRef.current
      const state = getEffectiveScrollState()
      if (handle && thumb && state.historySize > 0) {
        const trackHeight = handle.clientHeight
        const thumbHeight = thumb.clientHeight || 72
        const maxTop = Math.max(1, trackHeight - thumbHeight)
        const dy = event.clientY - pointerStartY
        const targetScroll = Math.max(0, Math.min(state.historySize, pointerStartScroll - Math.round((dy / maxTop) * state.historySize)))
        const delta = targetScroll - state.scrollPosition
        if (delta) {
          if (usesTmuxScroll()) {
            scrollState.scrollPosition = targetScroll
            updateScrollThumb()
            queueScroll(delta > 0 ? -Math.abs(delta) : Math.abs(delta))
          } else {
            term.scrollToLine(Math.max(0, term.buffer.active.baseY - targetScroll))
            updateScrollThumb()
          }
        }
        return
      }
      const dy = event.clientY - pointerStartY
      pointerStartY = event.clientY
      pointerAccumulated += dy
      while (Math.abs(pointerAccumulated) >= 6) {
        queueScroll(pointerAccumulated > 0 ? 2 : -2)
        pointerAccumulated += pointerAccumulated > 0 ? -6 : 6
      }
    }
    const handleScrollPointerUp = () => {
      window.removeEventListener("pointermove", handleScrollPointerMove)
      window.removeEventListener("pointerup", handleScrollPointerUp)
    }
    const handleScrollPointerDown = (event: PointerEvent) => {
      event.preventDefault()
      pointerStartY = event.clientY
      pointerStartScroll = getEffectiveScrollState().scrollPosition
      pointerAccumulated = 0
      window.addEventListener("pointermove", handleScrollPointerMove, { passive: false })
      window.addEventListener("pointerup", handleScrollPointerUp, { once: true })
    }
    scrollTargets.forEach((target) => {
      target.addEventListener("wheel", handleWheel, { capture: true, passive: false })
      target.addEventListener("touchstart", handleTouchStart, { capture: true, passive: true })
      target.addEventListener("touchmove", handleTouchMove, { capture: true, passive: false })
    })
    const scrollHandle = scrollHandleRef.current
    scrollHandle?.addEventListener("pointerdown", handleScrollPointerDown, { passive: false })

    let attached = false
    const clientId = `electron:${deviceId || "local"}:${sessionName}:${Date.now()}`
    let resizeRole: "controller" | "observer" = "controller"
    let knownRevision = 0
    let applyingRemoteSize = false
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    let lastSentSize = ""
    let writeQueue: string[] = []
    let writing = false
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
      writing = false
      try { term.clear() } catch {}
      try { term.reset() } catch {}
      term.write("[3J[2J[H", () => refreshTerminalView(true))
    }
    const showError = (err: any) => {
      failed = true
      const message = err?.message || String(err) || "Unknown error"
      term.writeln("\r\n\x1b[31mFailed to attach session:\x1b[0m " + message)
      term.writeln("\x1b[90mThe session view will stay open so this error can be read.\x1b[0m")
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

    term.onData((data) => {
      sendResizeIntent()
      window.agentTerm.sendInput(sessionName, data, deviceId)
    })

    const removeOutput = window.agentTerm.onOutput((session, data, outputDeviceId) => {
      if (session === sessionName && (outputDeviceId || null) === (deviceId || null)) {
        enqueueWrite(data)
      }
    })
    const removeClear = window.agentTerm.onClear((session, outputDeviceId) => {
      if (session === sessionName && (outputDeviceId || null) === (deviceId || null)) clearTerminal()
    })
    const removeSize = window.agentTerm.onSize((session, size, outputDeviceId) => {
      if (session === sessionName && (outputDeviceId || null) === (deviceId || null) && size.cols && size.rows) {
        knownRevision = Number(size.revision || knownRevision)
        resizeRole = size.role === "controller" || size.controllerId === clientId ? "controller" : "observer"
        if (size.sourceClientId === clientId || (size.controllerId === clientId && resizeRole === "controller")) return
        applyingRemoteSize = true
        try { term.resize(Number(size.cols), Number(size.rows)) } catch {}
        requestAnimationFrame(() => { applyingRemoteSize = false; refreshTerminalView(true, false) })
      }
    })
    const removeScrollState = window.agentTerm.onScrollState((session, state, outputDeviceId) => {
      if (session === sessionName && (outputDeviceId || null) === (deviceId || null)) {
        scrollState.scrollPosition = Number(state.scrollPosition || 0)
        scrollState.historySize = Number(state.historySize || 0)
        scrollState.paneHeight = Number(state.paneHeight || 0)
        scrollState.inCopyMode = !!state.inCopyMode
        updateScrollThumb()
      }
    })
    requestAnimationFrame(updateScrollThumb)

    const observer = new ResizeObserver(() => {
      if (failed || applyingRemoteSize) return
      if (resizeRole === "controller" && fitIfVisible()) scheduleControllerResize()
      refreshTerminalView(false, false)
    })
    observer.observe(containerRef.current)

    return () => {
      cancelAnimationFrame(t1)
      clearTimeout(t2)
      clearTimeout(t3)
      clearTimeout(t4)
      if (scrollFrame) cancelAnimationFrame(scrollFrame)
      if (resizeTimer) clearTimeout(resizeTimer)
      observer.disconnect()
      containerRef.current?.removeEventListener("focusin", requestControl)
      containerRef.current?.removeEventListener("pointerdown", requestControl)
      window.removeEventListener("pointermove", handleScrollPointerMove)
      window.removeEventListener("pointerup", handleScrollPointerUp)
      scrollHandle?.removeEventListener("pointerdown", handleScrollPointerDown)
      compositionEvents.forEach((eventName) => helperTextarea?.removeEventListener(eventName, stabilizeImeLayout))
      scrollTargets.forEach((target) => {
        target.removeEventListener("wheel", handleWheel, { capture: true })
        target.removeEventListener("touchstart", handleTouchStart, { capture: true })
        target.removeEventListener("touchmove", handleTouchMove, { capture: true })
      })
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
