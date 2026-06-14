export function readCompositionTextValue(eventData: string, targetValue: string, helperValue: string, previousDraft: string): string {
  const value = targetValue || helperValue || ""
  if (eventData) return eventData
  if (value.length >= previousDraft.length) return value
  return previousDraft || value
}
