import { getBuddyConfig } from "./config";
import { playNotificationSound } from "./notification";
import type { BuddyViewModel, JudgmentDecision, UtteranceLogEntry } from "./types";

export class ExpressionController {
  private state: BuddyViewModel = {
    mood: "idle",
    speech: null,
    status: "観測開始待ち",
    silentUntil: null,
    lastSpokenAt: null,
    loading: false,
  };

  private dialogueHistory: UtteranceLogEntry[] = [];
  private speechId = 0;
  private idleDecayTimerId: number | null = null;
  private flashTimerId: number | null = null;

  constructor(private readonly onChange: (state: BuddyViewModel) => void) {
    this.commit();
  }

  applyDecision(decision: JudgmentDecision, options: { bypassSilent?: boolean } = {}): void {
    this.refreshTransientState();

    this.state = {
      ...this.state,
      mood: decision.mood,
    };

    if (!decision.speak || (this.isSilent() && !options.bypassSilent)) {
      this.commit();
      this.scheduleIdleDecay();
      return;
    }

    const now = Date.now();
    this.speechId += 1;
    this.state = {
      ...this.state,
      mood: decision.mood,
      speech: {
        id: this.speechId,
        text: decision.text,
        mood: decision.mood,
        durationMs: computeSpeechDuration(decision.text),
        createdAt: now,
      },
      lastSpokenAt: now,
    };

    this.pushDialogue({
      role: "buddy",
      text: decision.text,
      mood: decision.mood,
      timestampMs: now,
    });

    playNotificationSound();
    this.commit();
    this.scheduleIdleDecay();
  }

  recordUserUtterance(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    this.pushDialogue({
      role: "user",
      text: trimmed,
      timestampMs: Date.now(),
    });
  }

  hydrateDialogueHistory(entries: UtteranceLogEntry[]): void {
    const limit = getBuddyConfig().cadence.dialogueHistoryLimit;
    const ordered = [...entries]
      .filter((entry) => entry && typeof entry.text === "string" && entry.text.trim().length > 0)
      .slice(-limit);
    this.dialogueHistory = ordered.reverse();
  }

  updateStatus(status: string): void {
    this.refreshTransientState();
    this.state = {
      ...this.state,
      status,
    };
    this.commit();
  }

  refreshTransientState(): void {
    if (!this.state.silentUntil) {
      return;
    }

    if (this.state.silentUntil > Date.now()) {
      return;
    }

    this.state = {
      ...this.state,
      silentUntil: null,
      status: "観測中",
    };
    this.commit();
  }

  silenceFor(milliseconds: number): void {
    const silentUntil = Date.now() + milliseconds;
    this.state = {
      ...this.state,
      silentUntil,
      status: "サイレント中",
    };
    this.clearIdleDecay();
    this.commit();
  }

  setLoading(loading: boolean): void {
    if (this.state.loading === loading) {
      return;
    }
    this.state = {
      ...this.state,
      loading,
      mood: loading ? "thinking" : this.state.mood,
    };
    this.commit();
  }

  flashMood(mood: BuddyViewModel["mood"], durationMs: number): void {
    if (this.state.loading || this.isSilent()) {
      return;
    }
    if (this.flashTimerId !== null) {
      window.clearTimeout(this.flashTimerId);
      this.flashTimerId = null;
    }
    this.state = { ...this.state, mood };
    this.commit();
    this.flashTimerId = window.setTimeout(() => {
      this.flashTimerId = null;
      if (this.state.loading) return;
      // When speech is active, restore the speech's own mood so the bubble's tone stays consistent.
      const nextMood = this.state.speech ? this.state.speech.mood : "idle";
      this.state = { ...this.state, mood: nextMood };
      this.commit();
    }, durationMs);
  }

  clearSilence(): void {
    this.state = {
      ...this.state,
      silentUntil: null,
      status: "起動中",
    };
    this.commit();
  }

  dismissCurrentSpeech(): void {
    this.state = {
      ...this.state,
      speech: null,
      mood: "idle",
    };
    this.clearIdleDecay();
    this.commit();
  }

  isSilent(now = Date.now()): boolean {
    return Boolean(this.state.silentUntil && this.state.silentUntil > now);
  }

  getRecentDialogue(): UtteranceLogEntry[] {
    return [...this.dialogueHistory];
  }

  getLastSpokenAt(): number | null {
    return this.state.lastSpokenAt;
  }

  private pushDialogue(entry: UtteranceLogEntry): void {
    const limit = getBuddyConfig().cadence.dialogueHistoryLimit;
    this.dialogueHistory = [entry, ...this.dialogueHistory].slice(0, limit);
  }

  private scheduleIdleDecay(): void {
    this.clearIdleDecay();

    if (this.state.mood === "idle") {
      return;
    }

    if (this.isSilent()) {
      return;
    }

    const idleDecayMs = getBuddyConfig().cadence.idleDecaySeconds * 1000;
    this.idleDecayTimerId = window.setTimeout(() => {
      this.idleDecayTimerId = null;
      if (this.state.mood === "idle" || this.isSilent()) {
        return;
      }
      this.state = {
        ...this.state,
        mood: "idle",
      };
      this.commit();
    }, idleDecayMs);
  }

  private clearIdleDecay(): void {
    if (this.idleDecayTimerId !== null) {
      window.clearTimeout(this.idleDecayTimerId);
      this.idleDecayTimerId = null;
    }
  }

  private commit(): void {
    this.onChange({ ...this.state });
  }
}

function computeSpeechDuration(text: string): number {
  const base = 6_000;
  const variable = text.length * 120;
  return Math.max(base, Math.min(28_000, base + variable));
}
