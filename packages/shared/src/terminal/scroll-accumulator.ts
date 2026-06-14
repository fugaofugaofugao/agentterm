import { WheelDeltaInput } from "./types"

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

export function shouldHandleVerticalWheel(deltaX = 0, deltaY = 0, horizontalRatio = 1.25): boolean {
  return Math.abs(deltaX) <= Math.abs(deltaY) * horizontalRatio
}

export function normalizeWheelDeltaToLines(input: WheelDeltaInput): number {
  const delta = input.deltaY || -(input.wheelDelta || 0) || 0
  if (!delta) return 0
  if (input.deltaMode === 1) return delta
  if (input.deltaMode === 2) return delta * Math.max(1, input.pageRows || 24)
  return delta / Math.max(1, input.linePx || 1)
}

export class ScrollAccumulator {
  private accumulatedLines = 0

  takeWholeLines(deltaLines: number, cap = 24): number {
    if (!Number.isFinite(deltaLines) || !deltaLines) return 0
    if (this.accumulatedLines && Math.sign(deltaLines) !== Math.sign(this.accumulatedLines)) {
      this.accumulatedLines = 0
    }
    this.accumulatedLines += deltaLines
    const whole = this.accumulatedLines > 0 ? Math.floor(this.accumulatedLines) : Math.ceil(this.accumulatedLines)
    if (!whole) return 0
    this.accumulatedLines -= whole
    return clamp(whole, -Math.abs(cap), Math.abs(cap))
  }

  reset(): void {
    this.accumulatedLines = 0
  }
}
