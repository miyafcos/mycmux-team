import defaultSystemPromptTemplate from "../persona/system-prompt.md?raw";
import type { HostBridge } from "../../adapters/host-bridge";
import { getBuddyConfig } from "../config";
import type { SpeechPressure } from "./cadence";
import type { BuddySignal } from "../perception/perception";
import type { Quote } from "../persona/quote-engine";
import type { JudgmentDecision, UtteranceLogEntry } from "../types";

interface JudgmentContext {
  reason: "signal" | "interval" | "userAsk";
  pressure?: SpeechPressure;
  summary: string;
  workContext: string;
  recentSignals: BuddySignal[];
  recentDialogue: UtteranceLogEntry[];
  profileText?: string;
  userText?: string;
  environmentText?: string;
  workspaceText?: string;
  quoteOpportunity?: boolean;
  quoteCandidates?: Quote[];
}

interface JudgmentEngineOptions {
  host: HostBridge;
  onStatusChange: (status: string) => void;
}

export type JudgmentInterruptHook = (signals: BuddySignal[]) => string | null;

const interruptHooks: JudgmentInterruptHook[] = [];

export function registerInterruptHook(hook: JudgmentInterruptHook): void {
  interruptHooks.push(hook);
}

export class JudgmentEngine {
  constructor(private readonly options: JudgmentEngineOptions) {}

  async ensureConfigStatus(): Promise<void> {
    this.options.onStatusChange("観測中");
  }

  async evaluate(context: JudgmentContext): Promise<JudgmentDecision> {
    this.options.onStatusChange("考え中");

    try {
      const interruptHints = interruptHooks
        .map((hook) => hook(context.recentSignals))
        .filter((value): value is string => Boolean(value));

      const raw = await this.options.host.invoke<string>("codex_judge", {
        systemPrompt: buildSystemPrompt(
          context.recentDialogue,
          context.reason,
          context.profileText,
          context.environmentText,
        ),
        userPrompt: buildUserPrompt(
          context.summary,
          context.workContext,
          context.reason,
          interruptHints,
          context.recentDialogue,
          context.userText,
          context.workspaceText,
          context.pressure,
          context.quoteOpportunity,
          context.quoteCandidates,
        ),
      });

      const decision = normalizeDecision(parseDecision(raw), context.reason);
      this.options.onStatusChange(decision.speak ? "ひとこと出力" : "観測中");
      void this.writeSpeechLogStub(context, decision);
      return decision;
    } catch (error) {
      console.error("[buddy] judgment failed:", error);
      this.options.onStatusChange("判定エラー");
      return context.reason === "userAsk"
        ? {
            speak: true,
            mood: "thinking",
            text: "…",
          }
        : {
            speak: false,
            mood: "thinking",
            text: "",
          };
    }
  }

  private async writeSpeechLogStub(
    context: JudgmentContext,
    decision: JudgmentDecision,
  ): Promise<void> {
    if (!decision.speak) {
      return;
    }

    try {
      await this.options.host.invoke("append_buddy_log", {
        line: JSON.stringify({
          timestampMs: Date.now(),
          reason: context.reason,
          summary: context.summary,
          thought: decision.thought,
          text: decision.text,
          mood: decision.mood,
          quoteOpportunity: context.quoteOpportunity ?? false,
          quoteId: decision.quoteId,
          source: "step4-skeleton",
        }),
      });
    } catch (error) {
      console.warn("[buddy] log skeleton write skipped:", error);
    }
  }
}

function formatDialogue(recentDialogue: UtteranceLogEntry[]): string {
  if (recentDialogue.length === 0) {
    return "(まだ対話履歴なし)";
  }
  // recentDialogue is newest-first; display oldest-first so the model reads it in time order
  return [...recentDialogue]
    .reverse()
    .map((entry) => {
      const speaker = entry.role === "user" ? "ユーザー" : "相棒";
      return `- ${speaker}: ${entry.text}`;
    })
    .join("\n");
}

function buildSystemPrompt(
  recentDialogue: UtteranceLogEntry[],
  reason: JudgmentContext["reason"],
  profileText?: string,
  environmentText?: string,
): string {
  const override = getBuddyConfig().persona.systemPrompt.trim();
  const systemPromptTemplate = override.length > 0 ? override : defaultSystemPromptTemplate;
  const personaStyleBlock = buildPersonaStyleBlock();
  const dialogueBlock = `## 直近の対話 (古い順)\n${formatDialogue(recentDialogue)}`;

  const environmentBlock =
    environmentText && environmentText.trim().length > 0 ? environmentText.trim() : null;

  const profileBlock =
    profileText && profileText.trim().length > 0
      ? `## ユーザーについて (これまでの観察メモ)\n${profileText.trim()}`
      : "## ユーザーについて (これまでの観察メモ)\n(まだ蓄積なし。会話から学んでいく)";

  const dialogueModeBlock =
    reason === "userAsk"
      ? [
          "## 対話モード追加指示",
          "- ユーザーが今あなたに直接話しかけている。質問や依頼に答えること。",
          "- 直近の対話と上のメモを踏まえて、前提を外さずに答える。",
          "- 必ず speak:true にすること。",
          "- 出力は既存ルールどおり単一行 JSON、日本語のみ。",
        ].join("\n")
      : null;

  return [
    systemPromptTemplate.trim(),
    personaStyleBlock,
    environmentBlock,
    profileBlock,
    dialogueModeBlock,
    dialogueBlock,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildUserPrompt(
  summary: string,
  workContext: string,
  reason: JudgmentContext["reason"],
  interruptHints: string[],
  recentDialogue: UtteranceLogEntry[],
  userText?: string,
  workspaceText?: string,
  pressure?: JudgmentContext["pressure"],
  quoteOpportunity?: boolean,
  quoteCandidates?: Quote[],
): string {
  const dialogueSection = `直近の対話 (古い順):\n${formatDialogue(recentDialogue)}`;
  const workspaceSection =
    workspaceText && workspaceText.trim().length > 0 ? workspaceText.trim() : null;

  if (reason === "userAsk") {
    const parts = ["トリガー: ユーザー発言", dialogueSection];
    if (workspaceSection) parts.push(workspaceSection);
    parts.push(
      "直近のClaude/Codexの流れ:",
      summary,
      "Claude/Codex 横断コンテキスト:",
      workContext,
      "ユーザーからの今回のメッセージ:",
      userText?.trim() || "",
      "上記メッセージに日本語で答えてください。speak:true 固定。直近の対話履歴と前提、そして現在のワークスペース状況を踏まえて前提不足のない返答を。",
    );
    return parts.join("\n\n");
  }

  const triggerLabel = reason === "signal" ? "新着シグナル" : "定期チェック";
  const sections = [`トリガー: ${triggerLabel}`, dialogueSection];
  if (workspaceSection) sections.push(workspaceSection);
  sections.push(
    `直近のシグナル:\n${summary}`,
    `Claude/Codex 横断コンテキスト:\n${workContext}`,
  );

  const rhythmHint = buildRhythmHint(reason, pressure);
  if (rhythmHint) {
    sections.push(rhythmHint);
  }

  if (interruptHints.length > 0) {
    sections.push(`補助ヒント:\n${interruptHints.map((hint) => `- ${hint}`).join("\n")}`);
  }

  if (quoteOpportunity && quoteCandidates && quoteCandidates.length > 0) {
    const candidateLines = quoteCandidates.map(
      (quote) => `- [${quote.id}] 「${quote.text}」 — ${quote.context}`,
    );
    sections.push(
      [
        "## 名言ライブラリ(候補)",
        "今回は名言を添えてよい機会。下の候補のうち、今の状況に本当に合うものが1つだけあれば、原文どおり、自分の発話に自然に織り込んで使ってよい。合うものが無ければ無理に使わず、普通に喋ること。使ったら quoteId にその id を入れる。",
        ...candidateLines,
      ].join("\n"),
    );
  }

  sections.push("JSONオブジェクトのみを1行で返してください。text フィールドは日本語のみ使用。");
  return sections.join("\n\n");
}

function buildRhythmHint(
  reason: JudgmentContext["reason"],
  pressure?: JudgmentContext["pressure"],
): string | null {
  if (reason === "userAsk") {
    return null;
  }

  if (pressure === "low") {
    return "リズムヒント:\n先輩にはついさっき声をかけたばかり。よほど意味のある観察でなければ speak:false に倒すこと。";
  }

  if (pressure === "high") {
    return "リズムヒント:\nしばらく静かにしていた。意味のある観察があれば speak:true で声をかけてよい。";
  }

  return null;
}

function buildPersonaStyleBlock(): string | null {
  const preset = getBuddyConfig().persona.stylePreset;
  if (preset !== "kurisu-work") {
    return null;
  }

  return [
    "## 運用上のガード",
    "- Claude Code と Codex を同等に扱う。片方だけを本体扱いしない。",
    "- 見えている事実と推測を混ぜない。根拠が薄い時は観測だけに留める。",
    "- 自動実行や代理操作はしない。今の役割は観測・要約・質問応答まで。",
  ].join("\n");
}

function parseDecision(rawText: string): JudgmentDecision {
  const jsonCandidate = extractJson(rawText);
  return JSON.parse(jsonCandidate) as JudgmentDecision;
}

function normalizeDecision(
  candidate: JudgmentDecision,
  reason: JudgmentContext["reason"],
): JudgmentDecision {
  const validMoods = new Set<JudgmentDecision["mood"]>(["idle", "thinking", "tsukkomi", "applaud"]);
  const mood = validMoods.has(candidate.mood) ? candidate.mood : "idle";
  const maxChars = getBuddyConfig().output.maxTextChars;
  const text = typeof candidate.text === "string" ? candidate.text.trim().slice(0, maxChars) : "";
  const quoteId =
    typeof candidate.quoteId === "string" && candidate.quoteId.trim().length > 0
      ? candidate.quoteId.trim()
      : undefined;

  if (reason === "userAsk") {
    return {
      speak: true,
      mood,
      text: text || "…",
      quoteId,
    };
  }

  return {
    speak: Boolean(candidate.speak) && text.length > 0,
    mood,
    text,
    quoteId,
  };
}

function extractJson(rawText: string): string {
  const start = rawText.indexOf("{");
  const end = rawText.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Codex response did not include JSON.");
  }

  return rawText.slice(start, end + 1);
}
