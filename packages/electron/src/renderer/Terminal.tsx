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
    const linePx = 24
    const stopScrollEvent = (event: WheelEvent | TouchEvent) => {
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
    }
    const handleWheel = (event: WheelEvent) => {
      stopScrollEvent(event)
      const delta = event.deltaY || -event.wheelDelta || 0
      const lines = Math.max(1, Math.round(Math.abs(delta) / linePx))
      window.termSync.scroll(sessionName, delta > 0 ? lines : -lines, deviceId)
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
        window.termSync.scroll(sessionName, accumulatedTouch > 0 ? 1 : -1, deviceId)
        accumulatedTouch += accumulatedTouch > 0 ? -linePx : linePx
      }
    }
    scrollTargets.forEach((target) => {
      target.addEventListener("wheel", handleWheel, { capture: true, passive: false })
      target.addEventListener("touchstart", handleTouchStart, { capture: true, passive: true })
      target.addEventListener("touchmove", handleTouchMove, { capture: true, passive: false })
    })

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
        window.termSync.attachSession(sessionName, term.cols, term.rows, deviceId).catch(showError)
      } else {
        window.termSync.resize(sessionName, term.cols, term.rows, deviceId)
      }
    }

    const t1 = setTimeout(doFitAndAttach, 50)
    const t2 = setTimeout(doFitAndAttach, 200)

    term.onData((data) => {
      window.termSync.sendInput(sessionName, data, deviceId)
    })

    const removeOutput = window.termSync.onOutput((session, data, outputDeviceId) => {
      if (session === sessionName && (outputDeviceId || null) === (deviceId || null)) {
        term.write(data)
      }
    })

    const observer = new ResizeObserver(() => {
      if (failed) return
      fitAddon.fit()
      window.termSync.resize(sessionName, term.cols, term.rows, deviceId)
    })
    observer.observe(containerRef.current)

    return () => {
      clearTimeout(t1)
      clearTimeout(t2)
      observer.disconnect()
      scrollTargets.forEach((target) => {
        target.removeEventListener("wheel", handleWheel, { capture: true })
        target.removeEventListener("touchstart", handleTouchStart, { capture: true })
        target.removeEventListener("touchmove", handleTouchMove, { capture: true })
      })
      removeOutput()
      window.termSync.detachSession(sessionName, deviceId)
      term.dispose()
    }
  }, [sessionName, deviceId])

  return <div ref={containerRef} className="terminal" />
}
