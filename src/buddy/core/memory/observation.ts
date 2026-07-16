import personaTemplate from "../persona/system-prompt.md?raw";
import type { HostBridge } from "../../adapters/host-bridge";
import { getBuddyConfig } from "../config";
import type { ChatMessage, JudgmentDecision } from "../types";
import type { WorkContextSnapshot, WorkContextStore, WorkSessionSummary } from "./workContext";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKLY_WORK_CONTEXT_LIMIT = 20;

interface ObservationState {
  lastDailySummary?: string | null;
  lastWeeklyReport?: string | null;
}

export class ObservationReporter {
  constructor(private readonly host: HostBridge) {}

  async maybeRunWeeklyReport(workContext?: WorkContextStore): Promise<string | null> {
    try {
      const today = formatDate(new Date());
      const state = await this.host.invoke<ObservationState>("load_observation_state");
      const lastWeeklyReport = normalizeDate(state.lastWeeklyReport);
      if (lastWeeklyReport && daysBetween(lastWeeklyReport, today) < 7) {
        return null;
      }

      const sinceMs = Date.now() - 7 * DAY_MS;
      const entries = await this.host.invoke<ChatMessage[]>("load_chat_since", {
        timestampMs: sinceMs,
      });
      const workSnapshot =
        workContext?.getSnapshot() ??
        (await this.host.invoke<WorkContextSnapshot>("load_work_context", {
          limit: WEEKLY_WORK_CONTEXT_LIMIT,
        }));
      const recentSessions = (workSnapshot.sessions ?? []).filter(
        (session) => Number(session.lastActivityMs) >= sinceMs,
      );

      const raw = await this.host.invoke<string>("codex_judge", {
        systemPrompt: buildSystemPrompt(),
        userPrompt: buildUserPrompt(entries ?? [], recentSessions),
      });
      const text = extractReportText(raw);

      await this.host.invoke("save_observation_state", {
        state: {
          lastDailySummary: normalizeDate(state.lastDailySummary),
          lastWeeklyReport: today,
        },
      });

      return text;
    } catch (error) {
      console.warn("[buddy] 週次観測レポートをスキップしました:", error);
      return null;
    }
  }
}

function buildSystemPrompt(): string {
  return [
    personaTemplate.trim(),
    "## 週次観測レポートモード",
    "これは週次の観測レポート。宮崎さんの今週の作業を観測者として総括し、紅莉栖として一言を。",
    "speak:true 固定。出力は既存ルールどおり単一行 JSON。text フィールドは日本語のみ。",
  ].join("\n\n");
}

function buildUserPrompt(entries: ChatMessage[], sessions: WorkSessionSummary[]): string {
  return [
    "今週の対話ログ:",
    formatDialogue(entries),
    "",
    "今週の実作業ストリーム:",
    formatWorkDigest(sessions),
    "",
    "今週のあんたの作業を観測してレポートして。",
  ].join("\n");
}

function formatDialogue(entries: ChatMessage[]): string {
  const filtered = entries.filter((entry) => entry && (entry.role === "user" || entry.role === "buddy"));
  if (filtered.length === 0) {
    return "(今週の対話ログなし)";
  }

  return filtered
    .map((entry) => `${entry.role === "user" ? "ユーザー" : "相棒"}: ${entry.text}`)
    .join("\n");
}

function formatWorkDigest(sessions: WorkSessionSummary[]): string {
  if (sessions.length === 0) {
    return "(今週の作業ストリームなし)";
  }

  return sessions
    .map((session, index) => {
      const project = session.projectPath?.trim() || "(プロジェクト不明)";
      const recent = previewText(session.recentText || session.title || "(内容なし)", 260);
      return [
        `- 作業${index + 1}`,
        `  エージェント: ${session.agent}`,
        `  プロジェクト: ${project}`,
        `  内容: ${recent}`,
      ].join("\n");
    })
    .join("\n\n");
}

function extractReportText(rawText: string): string {
  const candidate = JSON.parse(extractJson(rawText)) as Partial<JudgmentDecision>;
  const text =
    typeof candidate.text === "string"
      ? candidate.text.trim().slice(0, getBuddyConfig().output.maxTextChars)
      : "";
  if (!text) {
    throw new Error("週次観測レポートのtextが空でした。");
  }
  return text;
}

function extractJson(rawText: string): string {
  const start = rawText.indexOf("{");
  const end = rawText.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Codexの応答にJSONが含まれていませんでした。");
  }

  return rawText.slice(start, end + 1);
}

function normalizeDate(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function daysBetween(leftDate: string, rightDate: string): number {
  return Math.floor((startOfDayMs(rightDate) - startOfDayMs(leftDate)) / DAY_MS);
}

function startOfDayMs(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function previewText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 3)}...` : normalized;
}
