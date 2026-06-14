export interface TerminalScrollState {
  scrollPosition: number
  historySize: number
  paneHeight: number
  inCopyMode?: boolean
}

export interface ScrollThumbLayout {
  hasScrollableHistory: boolean
  thumbHeight: number
  top: number
}

export interface WheelDeltaInput {
  deltaX?: number
  deltaY?: number
  wheelDelta?: number
  deltaMode?: number
  linePx: number
  pageRows: number
}
