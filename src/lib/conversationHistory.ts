export type ConversationHistoryMode = "legacy" | "manual" | "boundary" | "agent-wheel";
/** Coordinator-approved default. Native gate downgrade changes this ONE line. */
export const DEFAULT_CONVERSATION_HISTORY_MODE: ConversationHistoryMode = "agent-wheel";
export function normalizeConversationHistoryMode(value: unknown): ConversationHistoryMode {
  return value === "legacy" || value === "manual" || value === "boundary" || value === "agent-wheel" ? value : DEFAULT_CONVERSATION_HISTORY_MODE;
}
