import { invoke } from "@tauri-apps/api/core";
import defaultSystemPromptTemplate from "../persona/system-prompt.md?raw";
import { getBuddyConfig } from "./config";
import type { BuddySignal } from "./perception";
import type { JudgmentDecision, UtteranceLogEntry } from "./types";

interface JudgmentContext {
  reason: "signal" | "interval" | "userAsk";
  summary: string;
  recentSignals: BuddySignal[];
  recentDialogue: UtteranceLogEntry[];
  profileText?: string;
  userText?: string;
  environmentText?: string;
  workspaceText?: string;
}

interface JudgmentEngineOptions {
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

      const raw = await invoke<string>("codex_judge", {
        systemPrompt: buildSystemPrompt(
          context.recentDialogue,
          context.reason,
          context.profileText,
          context.environmentText,
        ),
        userPrompt: buildUserPrompt(
          context.summary,
          context.reason,
          interruptHints,
          context.recentDialogue,
          context.userText,
          context.workspaceText,
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
      await invoke("append_buddy_log", {
        line: JSON.stringify({
          timestampMs: Date.now(),
          reason: context.reason,
          summary: context.summary,
          text: decision.text,
          mood: decision.mood,
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
  const dialogueBlock = `## 直近の対話 (古い順)\n${formatDialogue(recentDialogue)}`;

  const environmentBlock =
    environmentText && environmentText.trim().length > 0
      ? environmentText.trim()
      : null;

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

  return [systemPromptTemplate.trim(), environmentBlock, profileBlock, dialogueModeBlock, dialogueBlock]
    .filter(Boolean)
    .join("\n\n");
}

function buildUserPrompt(
  summary: string,
  reason: JudgmentContext["reason"],
  interruptHints: string[],
  recentDialogue: UtteranceLogEntry[],
  userText?: string,
  workspaceText?: string,
): string {
  const dialogueSection = `直近の対話 (古い順):\n${formatDialogue(recentDialogue)}`;
  const workspaceSection =
    workspaceText && workspaceText.trim().length > 0 ? workspaceText.trim() : null;

  if (reason === "userAsk") {
    const parts = [
      "トリガー: ユーザー発言",
      dialogueSection,
    ];
    if (workspaceSection) parts.push(workspaceSection);
    parts.push(
      "直近のClaude/Codexの流れ:",
      summary,
      "ユーザーからの今回のメッセージ:",
      userText?.trim() || "",
      "上記メッセージに日本語で答えてください。speak:true 固定。直近の対話履歴と前提、そして現在のワークスペース状況を踏まえて前提不足のない返答を。",
    );
    return parts.join("\n\n");
  }

  const triggerLabel = reason === "signal" ? "新着シグナル" : "定期チェック";
  const sections: string[] = [`トリガー: ${triggerLabel}`, dialogueSection];
  if (workspaceSection) sections.push(workspaceSection);
  sections.push(`直近のシグナル:\n${summary}`);

  if (interruptHints.length > 0) {
    sections.push(`補助ヒント:\n${interruptHints.map((hint) => `- ${hint}`).join("\n")}`);
  }

  sections.push("JSONオブジェクトのみを1行で返してください。text フィールドは日本語のみ使用。");
  return sections.join("\n\n");
}

function parseDecision(rawText: string): JudgmentDecision {
  const jsonCandidate = extractJson(rawText);
  return JSON.parse(jsonCandidate) as JudgmentDecision;
}

function normalizeDecision(
  candidate: JudgmentDecision,
  reason: JudgmentContext["reason"],
): JudgmentDecision {
  const validMoods = new Set<JudgmentDecision["mood"]>([
    "idle",
    "listening",
    "thinking",
    "tsukkomi",
    "applaud",
    "curious",
    "amused",
    "alert",
    "sleepy",
  ]);
  const mood = validMoods.has(candidate.mood) ? candidate.mood : "idle";
  const maxChars = getBuddyConfig().output.maxTextChars;
  const text = typeof candidate.text === "string" ? sanitizeSpeechText(candidate.text).slice(0, maxChars) : "";

  if (reason === "userAsk") {
    return {
      speak: true,
      mood,
      text: text || "…",
    };
  }

  return {
    speak: Boolean(candidate.speak) && text.length > 0,
    mood,
    text,
  };
}

function sanitizeSpeechText(raw: string): string {
  return raw.replace(/\n+/g, "").trim();
}

function extractJson(rawText: string): string {
  const start = rawText.indexOf("{");
  const end = rawText.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Codex response did not include JSON.");
  }

  return rawText.slice(start, end + 1);
}
