import { invoke } from "@tauri-apps/api/core";
import { getBuddyConfig, loadBuddyConfig } from "./config";
import { ExpressionController } from "./expression";
import { JudgmentEngine } from "./judgment";
import { KeystrokeTracker, type KeystrokeReaction } from "./keystroke";
import { PerceptionBuffer } from "./perception";
import { ProfileStore } from "./profile";
import type { BuddyViewModel, ChatMessage, UtteranceLogEntry } from "./types";
import { buildWorkspaceContextText } from "./workspace";

const SILENT_MODE_MS = 30 * 60_000;

export class PersonaAgent {
  private readonly perception = new PerceptionBuffer();
  private readonly expression: ExpressionController;
  private readonly judgment: JudgmentEngine;
  private readonly profile = new ProfileStore();
  private readonly keystroke = new KeystrokeTracker();
  private debounceTimerId: number | null = null;
  private isJudging = false;
  private isChatting = false;
  private isBusyNotifier?: (busy: boolean) => void;
  private lastEvaluationAt = 0;
  private environmentText = "";

  constructor(onChange: (state: BuddyViewModel) => void) {
    this.expression = new ExpressionController(onChange);
    this.judgment = new JudgmentEngine({
      onStatusChange: (status) => this.expression.updateStatus(status),
    });
  }

  async start(): Promise<void> {
    this.expression.updateStatus("観測中");
    await loadBuddyConfig();
    await this.judgment.ensureConfigStatus();

    await this.hydrateDialogueHistory();
    await this.profile.load();
    void this.profile.maybeRunDailySummary();
    await this.hydrateEnvironmentText();

    await this.perception.start((signal) => {
      if (signal.kind !== "claudeEvent" && signal.kind !== "codexEvent") {
        return;
      }

      this.scheduleEvaluation();
    });

    this.keystroke.start({
      onFastReact: (reaction) => this.handleKeystrokeReaction(reaction, false),
      onIdle: (reaction) => this.handleKeystrokeReaction(reaction, true),
    });
  }

  stop(): void {
    if (this.debounceTimerId !== null) {
      window.clearTimeout(this.debounceTimerId);
      this.debounceTimerId = null;
    }

    this.keystroke.stop();
    this.perception.stop();
  }

  private handleKeystrokeReaction(reaction: KeystrokeReaction, isIdle: boolean): void {
    if (reaction.isSensitive && !reaction.isDangerous) {
      return;
    }

    this.expression.flashMood(reaction.mood, reaction.durationMs);

    if (!isIdle) return;

    const cfg = getBuddyConfig();
    if (!cfg.keystroke.enabled) return;
    if (reaction.fromBuffer.length < cfg.keystroke.minCharsForLLM) return;

    this.perception.pushLocal({
      kind: "userTypingEvent",
      timestamp_ms: Date.now(),
      buffer: reaction.fromBuffer,
    });
    this.scheduleEvaluation();
  }

  silenceForThirtyMinutes(): void {
    this.expression.silenceFor(SILENT_MODE_MS);
  }

  toggleSilence(): void {
    if (this.expression.isSilent()) {
      this.expression.clearSilence();
    } else {
      this.expression.silenceFor(SILENT_MODE_MS);
    }
  }

  dismissSpeech(): void {
    this.expression.dismissCurrentSpeech();
  }

  setBusyNotifier(fn: (busy: boolean) => void): void {
    this.isBusyNotifier = fn;
    this.isBusyNotifier(this.isChatting);
  }

  async askFromUser(text: string): Promise<void> {
    const normalizedText = text.trim().slice(0, 500);
    if (!normalizedText || this.isJudging || this.isChatting) {
      return;
    }

    this.isChatting = true;
    this.notifyBusy(true);
    this.expression.setLoading(true);

    try {
      this.expression.recordUserUtterance(normalizedText);

      await this.appendChatMessage({
        role: "user",
        text: normalizedText,
        timestampMs: Date.now(),
      });

      const workspaceText = await buildWorkspaceContextText({
        sensitiveSuppress: this.keystroke.isSensitiveNow(),
      });

      const decision = await this.judgment.evaluate({
        reason: "userAsk",
        userText: normalizedText,
        summary: this.perception.summarizeSignals(),
        recentSignals: this.perception.getRecentSignals(),
        recentDialogue: this.expression.getRecentDialogue(),
        profileText: this.profile.getText(),
        environmentText: this.environmentText,
        workspaceText,
      });

      this.expression.applyDecision(decision, { bypassSilent: true });

      if (decision.speak) {
        await this.appendChatMessage({
          role: "buddy",
          text: decision.text,
          timestampMs: Date.now(),
        });
      }
    } finally {
      this.isChatting = false;
      this.notifyBusy(false);
      this.expression.setLoading(false);
    }
  }

  private scheduleEvaluation(): void {
    if (this.debounceTimerId !== null) {
      return;
    }

    const debounceMs = getBuddyConfig().cadence.debounceSeconds * 1000;
    this.debounceTimerId = window.setTimeout(() => {
      void this.maybeEvaluate();
    }, debounceMs);
  }

  private async maybeEvaluate(): Promise<void> {
    this.debounceTimerId = null;

    if (this.isJudging || this.isChatting) {
      return;
    }

    if (this.expression.isSilent()) {
      this.expression.updateStatus("サイレント中");
      return;
    }

    const cooldownMs = getBuddyConfig().cadence.cooldownMinutes * 60_000;
    if (Date.now() - this.lastEvaluationAt < cooldownMs) {
      return;
    }

    const recentSignals = this.perception.getRecentSignals();
    if (recentSignals.length === 0) {
      return;
    }

    this.isJudging = true;
    this.lastEvaluationAt = Date.now();
    this.expression.setLoading(true);

    try {
      const workspaceText = await buildWorkspaceContextText({
        sensitiveSuppress: this.keystroke.isSensitiveNow(),
      });

      const decision = await this.judgment.evaluate({
        reason: "signal",
        summary: this.perception.summarizeSignals(),
        recentSignals,
        recentDialogue: this.expression.getRecentDialogue(),
        profileText: this.profile.getText(),
        environmentText: this.environmentText,
        workspaceText,
      });
      this.expression.applyDecision(decision);

      if (decision.speak) {
        await this.appendChatMessage({
          role: "buddy",
          text: decision.text,
          timestampMs: Date.now(),
        });
      }
    } finally {
      this.isJudging = false;
      this.expression.setLoading(false);
    }
  }

  private async hydrateEnvironmentText(): Promise<void> {
    try {
      const text = await invoke<string>("load_buddy_environment");
      this.environmentText = typeof text === "string" ? text : "";
      if (this.environmentText.length > 0) {
        console.info(`[buddy] environment text loaded (${this.environmentText.length} chars)`);
      }
    } catch (error) {
      console.warn("[buddy] environment scan failed:", error);
      this.environmentText = "";
    }
  }

  private async hydrateDialogueHistory(): Promise<void> {
    try {
      const entries = await invoke<ChatMessage[]>("load_recent_chat", {
        limit: getBuddyConfig().cadence.dialogueHistoryLimit,
      });
      const utterances: UtteranceLogEntry[] = entries
        .filter((entry) => entry && (entry.role === "user" || entry.role === "buddy"))
        .map((entry) => ({
          role: entry.role,
          text: entry.text,
          timestampMs: entry.timestampMs,
        }));
      this.expression.hydrateDialogueHistory(utterances);
    } catch (error) {
      console.warn("[buddy] failed to hydrate dialogue history:", error);
    }
  }

  private notifyBusy(busy: boolean): void {
    this.isBusyNotifier?.(busy);
  }

  private async appendChatMessage(message: ChatMessage): Promise<void> {
    try {
      await invoke("append_buddy_chat", {
        line: JSON.stringify(message),
      });
    } catch (error) {
      console.warn("[buddy] failed to append chat log:", error);
    }
  }
}

