import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type BuddySignal =
  | {
      kind: "claudeEvent";
      timestamp_ms: number;
      session_id: string | null;
      project: string | null;
      text: string;
      raw_line: string;
    }
  | {
      kind: "codexEvent";
      timestamp_ms: number;
      session_id: string | null;
      text: string;
      raw_line: string;
    }
  | {
      kind: "windowFocusEvent";
      timestamp_ms: number;
      title: string;
    }
  | {
      kind: "idleEvent";
      timestamp_ms: number;
      idle_seconds: number;
    }
  | {
      kind: "userTypingEvent";
      timestamp_ms: number;
      buffer: string;
    };

const BUFFER_WINDOW_MS = 60_000;

export class PerceptionBuffer {
  private signals: BuddySignal[] = [];
  private unlisten: UnlistenFn | null = null;

  async start(onSignal: (signal: BuddySignal) => void): Promise<void> {
    this.unlisten = await listen<BuddySignal>("buddy://signal", (event) => {
      const signal = event.payload;
      this.push(signal);
      onSignal(signal);
    });
  }

  stop(): void {
    if (!this.unlisten) {
      return;
    }

    void this.unlisten();
    this.unlisten = null;
  }

  getRecentSignals(): BuddySignal[] {
    this.trim();
    return [...this.signals];
  }

  pushLocal(signal: BuddySignal): void {
    this.push(signal);
  }

  summarizeSignals(): string {
    this.trim();

    const claudeSignals = this.signals.filter(
      (signal): signal is Extract<BuddySignal, { kind: "claudeEvent" }> => signal.kind === "claudeEvent",
    );
    const codexSignals = this.signals.filter(
      (signal): signal is Extract<BuddySignal, { kind: "codexEvent" }> => signal.kind === "codexEvent",
    );
    const windowSignals = this.signals.filter(
      (signal): signal is Extract<BuddySignal, { kind: "windowFocusEvent" }> => signal.kind === "windowFocusEvent",
    );
    const typingSignals = this.signals.filter(
      (signal): signal is Extract<BuddySignal, { kind: "userTypingEvent" }> => signal.kind === "userTypingEvent",
    );

    const parts: string[] = [];

    if (typingSignals.length > 0) {
      const latest = typingSignals[typingSignals.length - 1];
      const buf = latest?.buffer ?? "";
      if (buf.length > 0) {
        parts.push(`打鍵バッファ: "${previewText(buf)}"`);
      }
    }

    if (claudeSignals.length > 0) {
      const lastClaude = claudeSignals[claudeSignals.length - 1];
      parts.push(`Claude ${claudeSignals.length}件: "${previewText(lastClaude?.text ?? "")}"`);
    }

    if (codexSignals.length > 0) {
      const lastCodex = codexSignals[codexSignals.length - 1];
      parts.push(`Codex ${codexSignals.length}件: "${previewText(lastCodex?.text ?? "")}"`);
    }

    if (windowSignals.length > 0) {
      const lastWindow = windowSignals[windowSignals.length - 1];
      parts.push(`Active window: "${previewText(lastWindow?.title ?? "")}"`);
    }

    if (parts.length === 0) {
      return "No activity in the last 60 seconds.";
    }

    return parts.join(" / ");
  }

  private push(signal: BuddySignal): void {
    this.signals.push(signal);
    this.trim();
  }

  private trim(): void {
    const threshold = Date.now() - BUFFER_WINDOW_MS;
    this.signals = this.signals.filter((signal) => signal.timestamp_ms >= threshold);
  }
}

function previewText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 60 ? `${normalized.slice(0, 57)}...` : normalized;
}
