/** LLM work is never part of navigation or panel loading. */
export function isExplicitLlmIntent(intent: string): boolean {
  return intent === "startSummarize" || intent === "summarizeSession";
}
