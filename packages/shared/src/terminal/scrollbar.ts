import { ScrollThumbLayout, TerminalScrollState } from "./types"
import { clamp } from "./scroll-accumulator"

export function calculateScrollThumb(state: TerminalScrollState, trackHeight: number, forceVisible = false): ScrollThumbLayout {
  const hasScrollableHistory = forceVisible || state.historySize > 0 || state.scrollPosition > 0
  if (!hasScrollableHistory) return { hasScrollableHistory: false, thumbHeight: 0, top: 0 }
  const safeTrackHeight = Math.max(1, trackHeight || 1)
  const visibleRatio = Math.max(0.12, Math.min(0.45, state.paneHeight / Math.max(state.historySize + state.paneHeight, 1)))
  const thumbHeight = Math.max(44, Math.min(96, Math.round(safeTrackHeight * visibleRatio)))
  const maxTop = Math.max(0, safeTrackHeight - thumbHeight)
  const maxScroll = Math.max(1, state.historySize, state.scrollPosition)
  const ratio = 1 - clamp(state.scrollPosition / maxScroll, 0, 1)
  return { hasScrollableHistory, thumbHeight, top: Math.round(maxTop * ratio) }
}

export function calculateScrollTargetFromDrag(state: TerminalScrollState, pointerStartScroll: number, dy: number, trackHeight: number, thumbHeight: number): number {
  const maxTop = Math.max(1, (trackHeight || 1) - (thumbHeight || 72))
  const historySize = Math.max(state.historySize, state.scrollPosition, 1)
  return clamp(pointerStartScroll - Math.round((dy / maxTop) * historySize), 0, historySize)
}
