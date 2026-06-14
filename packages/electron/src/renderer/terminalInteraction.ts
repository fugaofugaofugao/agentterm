import { Terminal as XTerm } from "@xterm/xterm"
import {
  ScrollAccumulator,
  calculateScrollTargetFromDrag,
  calculateScrollThumb,
  filterTerminalInput,
  normalizeWheelDeltaToLines,
  readCompositionTextValue,
  shouldHandleVerticalWheel,
  type TerminalScrollState,
} from "../../../shared/src/terminal"

export type { TerminalScrollState }

export interface TerminalInteractionControllerOptions {
  terminal: XTerm
  shell: HTMLElement
  container: HTMLElement
  scrollHandle: HTMLElement
  scrollThumb: HTMLElement
  remotePane: boolean
  sendScroll(lines: number): void
  sendInput(data: string): void
  onInputFocus?(): void
  onRefresh?(): void
}

export interface TerminalInteractionController {
  updateScrollState(state: Partial<TerminalScrollState>): void
  dispose(): void
}

const LOCAL_LINE_PX = 18
const REMOTE_LINE_PX = 32
const REMOTE_FLUSH_MS = 42

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

export function attachTerminalInteractionController(options: TerminalInteractionControllerOptions): TerminalInteractionController {
  const { terminal, container, scrollHandle, scrollThumb, remotePane, sendScroll, sendInput, onInputFocus } = options
  const scrollState: TerminalScrollState = { scrollPosition: 0, historySize: 0, paneHeight: 0, inCopyMode: false }
  const wheelAccumulator = new ScrollAccumulator()
  let pendingScrollLines = 0
  let scrollFrame = 0
  let remoteScrollTimer: ReturnType<typeof setTimeout> | null = null
  let touchStartY = 0
  let accumulatedTouch = 0
  let pointerStartY = 0
  let pointerStartScroll = 0
  let pointerAccumulated = 0
  let isComposing = false
  let compositionDraft = ""
  let compositionFilterDraft = ""
  let recentCompositionDraft = ""
  let recentCompositionFilterDraft = ""
  let recentCompositionTimer: ReturnType<typeof setTimeout> | null = null

  const termElement = container.querySelector(".xterm") as HTMLElement | null
  const helperTextarea = container.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement | null
  const scrollTargets = [container, termElement, termElement?.querySelector(".xterm-viewport") as HTMLElement | null, termElement?.querySelector(".xterm-screen") as HTMLElement | null].filter(Boolean) as HTMLElement[]

  const readCompositionText = (event?: CompositionEvent | InputEvent | Event): string => {
    const target = event?.target as HTMLTextAreaElement | null
    return readCompositionTextValue((event as CompositionEvent | undefined)?.data || "", target?.value || "", helperTextarea?.value || "", compositionDraft)
  }

  const readCompositionFilterText = (event?: CompositionEvent | InputEvent | Event): string => {
    const target = event?.target as HTMLTextAreaElement | null
    return target?.value || helperTextarea?.value || compositionFilterDraft || compositionDraft || ((event as CompositionEvent | undefined)?.data || "")
  }

  // Integrated terminal IME, native-anchored.
  //
  // We deliberately do NOT draw our own preedit overlay or transform .xterm-rows.
  // xterm.js already renders the marked/preedit text inline at the cursor via its
  // CompositionHelper and pins the hidden .xterm-helper-textarea to the cursor cell
  // so the OS candidate window tracks the caret (same model VS Code's terminal uses).
  // The previous custom overlay desynced the textarea from the real cursor, which is
  // why the candidate panel flew to the corner and the draft overlapped on the last
  // line. Here we only (a) mark the composing state for cursor styling and (b) nudge
  // xterm to re-anchor the composition elements after each update so wrapping/last-row
  // cases stay glued to the caret.

    const patchNativeCompositionHelper = () => {
    const helper = (terminal as any)._core?._compositionHelper as any
    if (!helper || helper.__agentTermImePatchApplied) return helper
    const compositionView = helper._compositionView as HTMLElement | undefined
    const textarea = helper._textarea as HTMLTextAreaElement | undefined
    if (!compositionView || !textarea) return helper

    // xterm 5.5 sizes the hidden helper textarea from the full preedit width. With
    // Squirrel/Rime long candidates that makes the macOS candidate panel enormous.
    // Newer xterm caps the marked text to the space from the cursor to the right
    // edge and follows the tail with direction=rtl. Apply that behavior locally so
    // IME anchoring stays native instead of using a separate, misaligned overlay.
    const originalCompositionUpdate = helper.compositionupdate?.bind(helper)
    const originalUpdateElements = helper.updateCompositionElements?.bind(helper)
    const caret = document.createElement("span")
    caret.className = "agentterm-ime-caret"
    caret.setAttribute("aria-hidden", "true")

    const renderCompositionText = (data: string) => {
      compositionView.textContent = data ? `\u200E${data}\u200E` : ""
      if (data) compositionView.appendChild(caret)
    }

    helper.compositionupdate = (event: Pick<CompositionEvent, "data">) => {
      const data = event?.data || ""
      if (originalCompositionUpdate) originalCompositionUpdate({ ...event, data })
      renderCompositionText(data)
      helper.updateCompositionElements?.()
    }

    helper.updateCompositionElements = (dontRecurse?: boolean) => {
      if (!helper.isComposing) return
      originalUpdateElements?.(true)

      const renderService = (terminal as any)._core?._renderService
      const bufferService = (terminal as any)._core?._bufferService
      const cellWidth = Number(renderService?.dimensions?.css?.cell?.width) || 8
      const cols = Number(bufferService?.cols || terminal.cols || 0)
      const cursorLeft = Number.parseFloat(compositionView.style.left || "0") || 0
      const maxWidth = Math.max(cellWidth, cols * cellWidth - cursorLeft)

      compositionView.style.maxWidth = `${maxWidth}px`
      compositionView.style.overflow = "hidden"
      compositionView.style.direction = "rtl"
      compositionView.style.whiteSpace = "nowrap"
      compositionView.style.overflowWrap = "normal"
      compositionView.style.wordBreak = "normal"

      const bounds = compositionView.getBoundingClientRect()
      textarea.style.width = `${Math.max(Math.min(bounds.width, maxWidth), 1)}px`
      textarea.style.height = `${Math.max(bounds.height, 1)}px`
      textarea.style.lineHeight = `${Math.max(bounds.height, 1)}px`

      if (!dontRecurse) setTimeout(() => helper.updateCompositionElements?.(true), 0)
    }

    helper.__agentTermImePatchApplied = true
    return helper
  }

  const reanchorNativeComposition = () => {
    const helper = patchNativeCompositionHelper()
    if (!helper?.isComposing) return
    try { helper.updateCompositionElements?.(true) } catch {}
  }

  const scheduleNativeCompositionReanchor = () => {
    patchNativeCompositionHelper()
    queueMicrotask(reanchorNativeComposition)
    requestAnimationFrame(reanchorNativeComposition)
  }

  const setComposingState = (active: boolean) => {
    container.classList.toggle("is-ime-composing", active)
  }

  const updateInlineComposition = (text = "") => {

    if (!isComposing || !text) {
      compositionDraft = ""
      if (!isComposing) compositionFilterDraft = ""
      setComposingState(false)
      return
    }
    compositionDraft = text
    setComposingState(true)
    scheduleNativeCompositionReanchor()
  }

  patchNativeCompositionHelper()
  requestAnimationFrame(() => patchNativeCompositionHelper())

  const handleCompositionStart = (event: CompositionEvent) => {
    isComposing = true
    compositionDraft = readCompositionText(event)
    compositionFilterDraft = readCompositionFilterText(event)
    updateInlineComposition(compositionDraft)
  }
  const handleCompositionUpdate = (event: CompositionEvent) => {
    isComposing = true
    compositionDraft = readCompositionText(event)
    compositionFilterDraft = readCompositionFilterText(event)
    updateInlineComposition(compositionDraft)
  }
  const handleCompositionInput = (event: Event) => {
    if (!isComposing) return
    compositionDraft = readCompositionText(event)
    compositionFilterDraft = readCompositionFilterText(event)
    updateInlineComposition(compositionDraft)
  }

  const handleCompositionEnd = (event?: CompositionEvent) => {
    const draft = compositionDraft
    const filterDraft = readCompositionFilterText(event)
    isComposing = false
    compositionDraft = ""
    compositionFilterDraft = ""
    if (draft || filterDraft) {
      recentCompositionDraft = draft
      recentCompositionFilterDraft = filterDraft
      if (recentCompositionTimer) clearTimeout(recentCompositionTimer)
      recentCompositionTimer = setTimeout(() => { recentCompositionDraft = ""; recentCompositionFilterDraft = ""; recentCompositionTimer = null }, 350)
    }
    updateInlineComposition("")
  }

  setComposingState(false)

  const usesRemoteScroll = () => remotePane || scrollState.paneHeight > 0
  const getLocalState = (): TerminalScrollState => {
    const buffer = terminal.buffer.active
    return { scrollPosition: Math.max(0, buffer.baseY - buffer.viewportY), historySize: Math.max(0, buffer.baseY), paneHeight: terminal.rows, inCopyMode: false }
  }
  const getEffectiveState = () => usesRemoteScroll() ? scrollState : getLocalState()
  const updateScrollThumb = () => {
    const layout = calculateScrollThumb(getEffectiveState(), scrollHandle.clientHeight || 1, usesRemoteScroll())
    scrollHandle.classList.toggle("is-scrollable", layout.hasScrollableHistory)
    scrollHandle.setAttribute("aria-hidden", layout.hasScrollableHistory ? "false" : "true")
    if (!layout.hasScrollableHistory) return
    scrollThumb.style.height = layout.thumbHeight + "px"
    scrollThumb.style.transform = `translateY(${layout.top}px)`
  }
  const flushScroll = () => {
    scrollFrame = 0
    if (remoteScrollTimer) { clearTimeout(remoteScrollTimer); remoteScrollTimer = null }
    if (!pendingScrollLines) return
    const remote = usesRemoteScroll()
    const lines = clamp(pendingScrollLines, remote ? -36 : -120, remote ? 36 : 120)
    pendingScrollLines -= lines
    if (remote) sendScroll(lines)
    else { terminal.scrollLines(lines); requestAnimationFrame(updateScrollThumb) }
    if (pendingScrollLines) scheduleScrollFlush()
  }
  const scheduleScrollFlush = () => {
    if (usesRemoteScroll()) {
      if (!remoteScrollTimer) remoteScrollTimer = setTimeout(flushScroll, REMOTE_FLUSH_MS)
    } else if (!scrollFrame) {
      scrollFrame = requestAnimationFrame(flushScroll)
    }
  }
  const queueScroll = (lines: number) => {
    if (!Number.isFinite(lines) || !lines) return
    if (usesRemoteScroll()) {
      scrollState.scrollPosition = Math.max(0, Math.min(Math.max(scrollState.historySize, scrollState.scrollPosition), scrollState.scrollPosition - lines))
      updateScrollThumb()
    }
    pendingScrollLines += lines
    scheduleScrollFlush()
  }
  const stopScrollEvent = (event: WheelEvent | TouchEvent) => {
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
  }
  const handleWheel = (event: WheelEvent) => {
    if ((event as any).__agentTermWheelHandled) return
    if (!shouldHandleVerticalWheel(event.deltaX || 0, event.deltaY || 0)) return
    ;(event as any).__agentTermWheelHandled = true
    stopScrollEvent(event)
    const linePx = usesRemoteScroll() ? REMOTE_LINE_PX : LOCAL_LINE_PX
    const rawLines = normalizeWheelDeltaToLines({ deltaX: event.deltaX, deltaY: event.deltaY, wheelDelta: (event as any).wheelDelta, deltaMode: event.deltaMode, linePx, pageRows: terminal.rows || 24 })
    const lines = wheelAccumulator.takeWholeLines(rawLines, 24)
    if (lines) queueScroll(lines)
  }
  const handleTouchStart = (event: TouchEvent) => {
    if (event.touches.length === 1) { touchStartY = event.touches[0].clientY; accumulatedTouch = 0 }
  }
  const handleTouchMove = (event: TouchEvent) => {
    if (event.touches.length !== 1) return
    stopScrollEvent(event)
    const dy = touchStartY - event.touches[0].clientY
    touchStartY = event.touches[0].clientY
    accumulatedTouch += dy
    const linePx = usesRemoteScroll() ? REMOTE_LINE_PX : LOCAL_LINE_PX
    while (Math.abs(accumulatedTouch) >= linePx) {
      queueScroll(accumulatedTouch > 0 ? 1 : -1)
      accumulatedTouch += accumulatedTouch > 0 ? -linePx : linePx
    }
  }
  const handleScrollPointerMove = (event: PointerEvent) => {
    event.preventDefault()
    const state = getEffectiveState()
    if (usesRemoteScroll() || state.historySize > 0 || state.scrollPosition > 0) {
      const targetScroll = calculateScrollTargetFromDrag(state, pointerStartScroll, event.clientY - pointerStartY, scrollHandle.clientHeight || 1, scrollThumb.clientHeight || 72)
      const delta = targetScroll - state.scrollPosition
      if (delta) {
        if (usesRemoteScroll()) { scrollState.scrollPosition = targetScroll; updateScrollThumb(); queueScroll(delta > 0 ? -Math.abs(delta) : Math.abs(delta)) }
        else { terminal.scrollToLine(Math.max(0, terminal.buffer.active.baseY - targetScroll)); updateScrollThumb() }
      }
      return
    }
    const dy = event.clientY - pointerStartY
    pointerStartY = event.clientY
    pointerAccumulated += dy
    while (Math.abs(pointerAccumulated) >= 8) {
      queueScroll(pointerAccumulated > 0 ? 2 : -2)
      pointerAccumulated += pointerAccumulated > 0 ? -8 : 8
    }
  }
  const handleScrollPointerUp = () => {
    scrollHandle.classList.remove("is-dragging")
    window.removeEventListener("pointermove", handleScrollPointerMove)
    window.removeEventListener("pointerup", handleScrollPointerUp)
    if (pendingScrollLines) flushScroll()
  }
  const handleScrollPointerDown = (event: PointerEvent) => {
    event.preventDefault()
    scrollHandle.classList.add("is-dragging")
    pointerStartY = event.clientY
    pointerStartScroll = getEffectiveState().scrollPosition
    pointerAccumulated = 0
    window.addEventListener("pointermove", handleScrollPointerMove, { passive: false })
    window.addEventListener("pointerup", handleScrollPointerUp, { once: true })
  }

  const inputDisposable = terminal.onData((data) => {
    const outgoing = filterTerminalInput(data, isComposing ? (compositionFilterDraft || compositionDraft) : (recentCompositionFilterDraft || recentCompositionDraft))
    if (!outgoing) return
    if (isComposing && /^[\x20-\x7e]+$/.test(outgoing)) return
    onInputFocus?.()
    sendInput(outgoing)
  })

  ;(terminal as any).attachCustomWheelEventHandler?.((event: WheelEvent) => { handleWheel(event); return false })
  scrollTargets.forEach((target) => {
    target.addEventListener("wheel", handleWheel, { capture: true, passive: false })
    target.addEventListener("touchstart", handleTouchStart, { capture: true, passive: true })
    target.addEventListener("touchmove", handleTouchMove, { capture: true, passive: false })
  })
  scrollHandle.addEventListener("pointerdown", handleScrollPointerDown, { passive: false })
  helperTextarea?.addEventListener("compositionstart", handleCompositionStart)
  helperTextarea?.addEventListener("compositionupdate", handleCompositionUpdate)
  helperTextarea?.addEventListener("compositionend", handleCompositionEnd)
  helperTextarea?.addEventListener("input", handleCompositionInput)
  requestAnimationFrame(updateScrollThumb)

  return {
    updateScrollState(state) {
      scrollState.scrollPosition = Number(state.scrollPosition || 0)
      scrollState.historySize = Number(state.historySize || 0)
      scrollState.paneHeight = Number(state.paneHeight || 0)
      scrollState.inCopyMode = !!state.inCopyMode
      updateScrollThumb()
    },
    dispose() {
      if (scrollFrame) cancelAnimationFrame(scrollFrame)
      if (remoteScrollTimer) clearTimeout(remoteScrollTimer)
      if (recentCompositionTimer) clearTimeout(recentCompositionTimer)
      setComposingState(false)
      window.removeEventListener("pointermove", handleScrollPointerMove)
      window.removeEventListener("pointerup", handleScrollPointerUp)
      scrollHandle.removeEventListener("pointerdown", handleScrollPointerDown)
      helperTextarea?.removeEventListener("compositionstart", handleCompositionStart)
      helperTextarea?.removeEventListener("compositionupdate", handleCompositionUpdate)
      helperTextarea?.removeEventListener("compositionend", handleCompositionEnd)
      helperTextarea?.removeEventListener("input", handleCompositionInput)
      scrollTargets.forEach((target) => {
        target.removeEventListener("wheel", handleWheel, { capture: true } as any)
        target.removeEventListener("touchstart", handleTouchStart, { capture: true } as any)
        target.removeEventListener("touchmove", handleTouchMove, { capture: true } as any)
      })
      inputDisposable.dispose()
    },
  }
}
