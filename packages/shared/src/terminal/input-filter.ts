export function stripTerminalDeviceAnswers(data: string): string {
  return data
    .replace(/\x1b\[(?:\?|>)?[0-9;]*c/g, "")
    .replace(/(?:\??|>?)[0-9;]+c/g, "")
}

export function shouldDropCompositionDraft(outgoing: string, activeDraft: string): boolean {
  if (!activeDraft || !/^[\x00-\x7f]+$/.test(outgoing)) return false
  const draft = activeDraft.replace(/\s+/g, "")
  const compact = outgoing.replace(/\s+/g, "")
  return outgoing === activeDraft || compact === draft || draft.startsWith(compact) || compact.startsWith(draft)
}

export function filterTerminalInput(data: string, activeDraft = ""): string {
  const outgoing = stripTerminalDeviceAnswers(data)
  if (!outgoing) return ""
  if (shouldDropCompositionDraft(outgoing, activeDraft)) return ""
  return outgoing
}
