export type BuddyMood =
  | "idle"
  | "listening"
  | "thinking"
  | "tsukkomi"
  | "applaud"
  | "curious"
  | "amused"
  | "alert"
  | "sleepy";

export interface JudgmentDecision {
  speak: boolean;
  mood: BuddyMood;
  text: string;
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
