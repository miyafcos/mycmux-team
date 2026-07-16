export type BuddyMood = "idle" | "thinking" | "tsukkomi" | "applaud";
export type { BuddyReaction } from "./reaction/reaction-types";
import type { BuddyReaction } from "./reaction/reaction-types";

export interface JudgmentDecision {
  thought?: string;
  speak: boolean;
  mood: BuddyMood;
  text: string;
  /** Set by the LLM when it wove a canonical quote from the library into `text`. */
  quoteId?: string;
}

export interface ChatMessage {
  role: "user" | "buddy";
  text: string;
  timestampMs: number;
}

export interface BuddySpeech {
  id: number;
  text: string;
  mood: BuddyMood;
  durationMs: number;
  createdAt: number;
}

export interface BuddyViewModel {
  mood: BuddyMood;
  speech: BuddySpeech | null;
  reaction: BuddyReaction | null;
  status: string;
  silentUntil: number | null;
  lastSpokenAt: number | null;
  loading: boolean;
}

export interface UtteranceLogEntry {
  role: "user" | "buddy";
  text: string;
  mood?: BuddyMood;
  timestampMs: number;
}
