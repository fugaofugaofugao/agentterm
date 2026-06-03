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
    let failed = false
    const showError = (err: any) => {
      failed = true
      const message = err?.message || String(err) || "Unknown error"
      term.writeln("\r\n\x1b[31mFailed to attach session:\x1b[0m " + message)
      term.writeln("\x1b[90mThe session view will stay open so this error can be read.\x1b[0m")
    }
    const doFitAndAttach = () => {
      if (failed) return
      fitAddon.fit()
      if (!attached) {
        attached = true
        window.agentTerm.attachSession(sessionName, term.cols, term.rows, deviceId).catch(showError)
      } else {
        window.agentTerm.resize(sessionName, term.cols, term.rows, deviceId)
      requestAnimationFrame(updateScrollThumb)
      }
    }

    const t1 = setTimeout(doFitAndAttach, 50)
    const t2 = setTimeout(doFitAndAttach, 200)

    term.onData((data) => {
      window.agentTerm.sendInput(sessionName, data, deviceId)
    })

    const removeOutput = window.agentTerm.onOutput((session, data, outputDeviceId) => {
      if (session === sessionName && (outputDeviceId || null) === (deviceId || null)) {
        term.write(data)
        requestAnimationFrame(updateScrollThumb)
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
      if (failed) return
      fitAddon.fit()
      window.agentTerm.resize(sessionName, term.cols, term.rows, deviceId)
      requestAnimationFrame(updateScrollThumb)
    })
    observer.observe(containerRef.current)

    return () => {
      clearTimeout(t1)
      clearTimeout(t2)
      if (scrollFrame) cancelAnimationFrame(scrollFrame)
      observer.disconnect()
      window.removeEventListener("pointermove", handleScrollPointerMove)
      window.removeEventListener("pointerup", handleScrollPointerUp)
      scrollHandle?.removeEventListener("pointerdown", handleScrollPointerDown)
      scrollTargets.forEach((target) => {
        target.removeEventListener("wheel", handleWheel, { capture: true })
        target.removeEventListener("touchstart", handleTouchStart, { capture: true })
        target.removeEventListener("touchmove", handleTouchMove, { capture: true })
      })
      removeOutput()
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
