import { create } from "zustand";

export interface RecentInput {
  text: string;
  at: number;
}

interface RecentInputState {
  recentBySession: Record<string, RecentInput>;
  recordCommittedText: (sessionId: string, text: string) => void;
}

const MAX_RECENT_INPUT_LENGTH = 500;
const draftsBySession = new Map<string, string>();

function printableText(value: string): string {
  return value.replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, "");
}

function lastCommittedLine(value: string): string | null {
  const lines = printableText(value)
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const line = lines[lines.length - 1];
  return line ? line.slice(0, MAX_RECENT_INPUT_LENGTH) : null;
}

export const useRecentInputStore = create<RecentInputState>((set) => ({
  recentBySession: {},
  recordCommittedText: (sessionId, text) => {
    const line = lastCommittedLine(text);
    if (!line) return;
    set((state) => ({
      recentBySession: { ...state.recentBySession, [sessionId]: { text: line, at: Date.now() } },
    }));
  },
}));

export function recordRecentInputText(sessionId: string, text: string): void {
  useRecentInputStore.getState().recordCommittedText(sessionId, text);
}

export function recordRecentKeystroke(sessionId: string, data: string): void {
  const printable = printableText(data);
  if (!printable) return;
  const draft = `${draftsBySession.get(sessionId) ?? ""}${printable}`;
  const parts = draft.split(/[\r\n]/);
  draftsBySession.set(sessionId, parts.pop() ?? "");
  for (const line of parts) recordRecentInputText(sessionId, line);
}
