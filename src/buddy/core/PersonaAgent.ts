import { getBuddyConfig, loadBuddyConfig } from "./config";
import { ExpressionController } from "./expression/expression";
import { CadenceController } from "./judgment/cadence";
import { JudgmentEngine } from "./judgment/judgment";
import { KeystrokeTracker, type KeystrokeReaction } from "./perception/keystroke";
import { ObservationReporter } from "./memory/observation";
import { PerceptionBuffer, type BuddySignal } from "./perception/perception";
import { classifySignal, type SignalImportance } from "./perception/signal-classifier";
import { ReactionEngine } from "./reaction/reaction-engine";
import { ProfileStore } from "./memory/profile";
import { QuoteEngine } from "./persona/quote-engine";
import type { BuddyViewModel, ChatMessage, UtteranceLogEntry } from "./types";
import { WorkContextStore } from "./memory/workContext";
import { buildWorkspaceContextText } from "./memory/workspace";
import type { BuddyDomEvents } from "../adapters/dom-events";
import type { HostBridge } from "../adapters/host-bridge";
import type { Notifier } from "../adapters/notifier";
import type { Scheduler } from "../adapters/scheduler";

const SILENT_MODE_MS = 30 * 60_000;

export interface PersonaAgentDependencies {
  host: HostBridge;
  scheduler: Scheduler;
  notifier: Notifier;
  domEvents: BuddyDomEvents;
}

export class PersonaAgent {
  private readonly host: HostBridge;
  private readonly scheduler: Scheduler;
  private readonly domEvents: BuddyDomEvents;
  private readonly perception: PerceptionBuffer;
  private readonly expression: ExpressionController;
  private readonly reaction: ReactionEngine;
  private readonly cadence: CadenceController;
  private readonly judgment: JudgmentEngine;
  private readonly profile: ProfileStore;
  private readonly workContext: WorkContextStore;
  private readonly keystroke: KeystrokeTracker;
  private readonly quoteEngine: QuoteEngine;
  private debounceTimerId: number | null = null;
  private debounceTimerImportance: SignalImportance | null = null;
  private pendingCooldownTimerId: number | null = null;
  private isJudging = false;
  private isChatting = false;
  private isBusyNotifier?: (busy: boolean) => void;
  private lastEvaluationAt = 0;
  private environmentText = "";
  private weeklyReportTimerId: number | null = null;
  private memoryReportTimerId: number | null = null;
  private intervalTimerId: number | null = null;
  private activationFallbackTimerId: number | null = null;
  private activated = false;
  private activating: Promise<void> | null = null;
  private stopped = true;

  constructor(onChange: (state: BuddyViewModel) => void, dependencies: PersonaAgentDependencies) {
    this.host = dependencies.host;
    this.scheduler = dependencies.scheduler;
    this.domEvents = dependencies.domEvents;
    this.perception = new PerceptionBuffer(this.host);
    this.expression = new ExpressionController(onChange, dependencies.scheduler, dependencies.notifier);
    this.reaction = new ReactionEngine({
      scheduler: dependencies.scheduler,
      config: () => getBuddyConfig().reactions,
      isSilent: () => this.expression.isSilent(),
      onReaction: (reaction) => this.expression.flashReaction(reaction),
    });
    this.cadence = new CadenceController();
    this.judgment = new JudgmentEngine({
      host: this.host,
      onStatusChange: (status) => this.expression.updateStatus(status),
    });
    this.profile = new ProfileStore(this.host);
    this.workContext = new WorkContextStore(this.host);
    this.keystroke = new KeystrokeTracker(this.scheduler, this.domEvents);
    this.quoteEngine = new QuoteEngine();
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.expression.updateStatus("観測中");
    await loadBuddyConfig(this.host, this.domEvents);
    await this.judgment.ensureConfigStatus();

    await this.perception.start((signal) => {
      this.reaction.onSignal(signal);
      if (signal.kind === "idleEvent") {
        this.reaction.onIdleTick({ idleSeconds: signal.idle_seconds });
      }

      if (signal.kind !== "claudeEvent" && signal.kind !== "codexEvent") {
        return;
      }

      void this.ensureActivated("signal");
      this.scheduleEvaluation(classifySignal(signal));
    });

    this.keystroke.start({
      onFastReact: (reaction) => this.handleKeystrokeReaction(reaction, false),
      onIdle: (reaction) => this.handleKeystrokeReaction(reaction, true),
    });

    this.activationFallbackTimerId = this.scheduler.setTimeout(() => {
      this.activationFallbackTimerId = null;
      void this.ensureActivated("timer");
    }, 90_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.debounceTimerId !== null) {
      this.scheduler.clearTimeout(this.debounceTimerId);
      this.debounceTimerId = null;
      this.debounceTimerImportance = null;
    }
    if (this.weeklyReportTimerId !== null) {
      this.scheduler.clearTimeout(this.weeklyReportTimerId);
      this.weeklyReportTimerId = null;
    }
    if (this.memoryReportTimerId !== null) {
      this.scheduler.clearTimeout(this.memoryReportTimerId);
      this.memoryReportTimerId = null;
    }
    if (this.intervalTimerId !== null) {
      this.scheduler.clearTimeout(this.intervalTimerId);
      this.intervalTimerId = null;
    }
    if (this.activationFallbackTimerId !== null) {
      this.scheduler.clearTimeout(this.activationFallbackTimerId);
      this.activationFallbackTimerId = null;
    }
    if (this.pendingCooldownTimerId !== null) {
      this.scheduler.clearTimeout(this.pendingCooldownTimerId);
      this.pendingCooldownTimerId = null;
    }

    this.keystroke.stop();
    this.reaction.stop();
    this.perception.stop();
  }

  private handleKeystrokeReaction(reaction: KeystrokeReaction, isIdle: boolean): void {
    if (reaction.isSensitive && !reaction.isDangerous) {
      return;
    }

    this.reaction.onSignal({
      kind: "userTypingEvent",
      timestamp_ms: Date.now(),
      buffer: reaction.fromBuffer,
      is_dangerous: reaction.isDangerous,
      backspace_streak: !isIdle && reaction.mood === "applaud" ? 5 : 0,
      is_idle: isIdle,
    });

    if (!isIdle) return;

    const cfg = getBuddyConfig();
    if (!cfg.keystroke.enabled) return;
    if (reaction.fromBuffer.length < cfg.keystroke.minCharsForLLM) return;

    if (cfg.keystroke.triggersEvaluation) {
      this.perception.pushLocal({
        kind: "userTypingEvent",
        timestamp_ms: Date.now(),
        buffer: reaction.fromBuffer,
      });
      this.scheduleEvaluation("normal");
    }
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
    await this.ensureActivated("user");
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

      const workspaceText = await buildWorkspaceContextText(this.host, {
        sensitiveSuppress: this.keystroke.isSensitiveNow(),
      });

      const decision = await this.judgment.evaluate({
        reason: "userAsk",
        pressure: this.cadence.pressure(Date.now()),
        userText: normalizedText,
        summary: this.perception.summarizeSignals(),
        workContext: await this.getWorkContextForPrompt(true),
        recentSignals: this.perception.getRecentSignals(),
        recentDialogue: this.expression.getRecentDialogue(),
        profileText: this.profile.getText(),
        environmentText: this.environmentText,
        workspaceText,
      });

      this.expression.applyDecision(decision, { bypassSilent: true });

      if (decision.speak) {
        this.cadence.recordUtterance(Date.now());
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

  private scheduleEvaluation(importance: SignalImportance): void {
    const debounceMs =
      (importance === "important"
        ? getBuddyConfig().cadence.fastLaneDebounceSeconds
        : getBuddyConfig().cadence.debounceSeconds) * 1000;

    if (this.debounceTimerId !== null) {
      if (importance !== "important" || this.debounceTimerImportance === "important") {
        return;
      }

      this.scheduler.clearTimeout(this.debounceTimerId);
      this.debounceTimerId = null;
      this.debounceTimerImportance = null;
    }

    this.debounceTimerImportance = importance;
    this.debounceTimerId = this.scheduler.setTimeout(() => {
      this.debounceTimerId = null;
      this.debounceTimerImportance = null;
      void this.maybeEvaluate("signal");
    }, debounceMs);
  }

  private scheduleInterval(): void {
    if (this.stopped || this.intervalTimerId !== null) {
      return;
    }

    const intervalMs = getBuddyConfig().cadence.intervalMinutes * 60_000;
    this.intervalTimerId = this.scheduler.setTimeout(() => {
      this.intervalTimerId = null;
      if (this.stopped) {
        return;
      }

      void this.runIntervalEvaluation(intervalMs);
    }, intervalMs);
  }

  private async runIntervalEvaluation(intervalMs: number): Promise<void> {
    try {
      if (Date.now() - this.lastEvaluationAt >= intervalMs) {
        await this.maybeEvaluate("interval");
      }
    } finally {
      this.scheduleInterval();
    }
  }

  private async maybeEvaluate(reason: "signal" | "interval"): Promise<void> {
    await this.ensureActivated("signal");

    if (this.isJudging || this.isChatting) {
      return;
    }

    if (this.expression.isSilent()) {
      this.expression.updateStatus("サイレント中");
      return;
    }

    const recentSignals = this.perception.getRecentSignals();
    const now = Date.now();
    const cooldownMs = this.cadence.effectiveCooldownMs(
      now,
      getBuddyConfig().cadence.cooldownMinutes * 60_000,
    );
    const elapsedSinceEvaluation = now - this.lastEvaluationAt;
    if (elapsedSinceEvaluation < cooldownMs) {
      this.schedulePendingCooldownEvaluation(recentSignals, cooldownMs - elapsedSinceEvaluation);
      return;
    }

    if (recentSignals.length === 0 && reason === "signal") {
      return;
    }

    this.isJudging = true;
    const evaluationStartedAt = Date.now();
    this.lastEvaluationAt = evaluationStartedAt;
    this.expression.setLoading(true);

    try {
      const workspaceText = await buildWorkspaceContextText(this.host, {
        sensitiveSuppress: this.keystroke.isSensitiveNow(),
      });

      const notable = recentSignals.some((signal) => classifySignal(signal) === "important");
      const quoteOpportunity = this.quoteEngine.shouldOfferOpportunity({ notable });
      const quoteCandidates = quoteOpportunity
        ? this.quoteEngine.selectCandidates(this.perception.summarizeSignals())
        : [];

      const decision = await this.judgment.evaluate({
        reason,
        pressure: this.cadence.pressure(evaluationStartedAt),
        summary: this.perception.summarizeSignals(),
        workContext: await this.getWorkContextForPrompt(false),
        recentSignals,
        recentDialogue: this.expression.getRecentDialogue(),
        profileText: this.profile.getText(),
        environmentText: this.environmentText,
        workspaceText,
        quoteOpportunity,
        quoteCandidates,
      });
      this.expression.applyDecision(decision);

      if (decision.quoteId) {
        this.quoteEngine.recordUsed(decision.quoteId);
      }

      if (decision.speak) {
        this.cadence.recordUtterance(Date.now());
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

  private schedulePendingCooldownEvaluation(recentSignals: BuddySignal[], remainingCooldownMs: number): void {
    if (this.pendingCooldownTimerId !== null) {
      return;
    }

    if (!recentSignals.some((signal) => classifySignal(signal) === "important")) {
      return;
    }

    this.pendingCooldownTimerId = this.scheduler.setTimeout(() => {
      this.pendingCooldownTimerId = null;
      if (this.stopped) {
        return;
      }
      void this.maybeEvaluate("signal");
    }, Math.max(1_000, remainingCooldownMs));
  }

  private async hydrateEnvironmentText(): Promise<void> {
    try {
      const text = await this.host.invoke<string>("load_buddy_environment");
      this.environmentText = typeof text === "string" ? text : "";
      if (this.environmentText.length > 0) {
        console.info(`[buddy] environment text loaded (${this.environmentText.length} chars)`);
      }
    } catch (error) {
      console.warn("[buddy] environment scan failed:", error);
      this.environmentText = "";
    }
  }

  private async ensureActivated(reason: "signal" | "user" | "timer"): Promise<void> {
    if (this.activated) {
      return;
    }
    if (this.activating) {
      return this.activating;
    }

    this.activating = (async () => {
      try {
        if (this.stopped) {
          return;
        }

        await this.hydrateDialogueHistory();
        await this.profile.load();
        await this.workContext.refresh(true);
        await this.hydrateEnvironmentText();
        this.scheduleInterval();
        this.scheduleMemoryReports();
        this.activated = true;
        if (this.activationFallbackTimerId !== null) {
          this.scheduler.clearTimeout(this.activationFallbackTimerId);
          this.activationFallbackTimerId = null;
        }
      } catch (error) {
        console.warn(`[buddy] deferred activation failed (${reason}):`, error);
      } finally {
        this.activating = null;
      }
    })();

    return this.activating;
  }

  private scheduleMemoryReports(): void {
    if (this.stopped || this.memoryReportTimerId !== null) {
      return;
    }

    const reporter = new ObservationReporter(this.host);

    this.memoryReportTimerId = this.scheduler.setTimeout(() => {
      this.memoryReportTimerId = null;
      if (this.stopped) {
        return;
      }

      void (async () => {
        try {
          await this.profile.maybeRunDailySummary(this.workContext);
          if (this.stopped) {
            return;
          }

          const report = await reporter.maybeRunWeeklyReport(this.workContext);
          if (!report || this.stopped) {
            return;
          }

          this.weeklyReportTimerId = this.scheduler.setTimeout(() => {
            this.weeklyReportTimerId = null;
            if (this.stopped) {
              return;
            }
            this.expression.applyDecision({ speak: true, mood: "thinking", text: report }, {});
          }, 10_000);
        } catch (error) {
          console.warn("[buddy] 週次観測レポートの起動に失敗しました:", error);
        }
      })();
    }, 30_000);
  }

  private async hydrateDialogueHistory(): Promise<void> {
    try {
      const entries = await this.host.invoke<ChatMessage[]>("load_recent_chat", {
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

  private async getWorkContextForPrompt(force: boolean): Promise<string> {
    await this.workContext.refresh(force);
    return this.workContext.toPromptText();
  }

  private async appendChatMessage(message: ChatMessage): Promise<void> {
    try {
      await this.host.invoke("append_buddy_chat", {
        line: JSON.stringify(message),
      });
    } catch (error) {
      console.warn("[buddy] failed to append chat log:", error);
    }
  }
}
