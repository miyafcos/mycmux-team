import { invoke } from "@tauri-apps/api/core";
import { getBuddyConfig } from "./config";
import type { ChatMessage } from "./types";

const LAST_SUMMARY_RE = /<!--\s*last-summary:\s*(\d{4}-\d{2}-\d{2})\s*-->/;
const MIN_ENTRIES_FOR_SUMMARY = 4;

export class ProfileStore {
  private text = "";
  private loaded = false;
  private summaryRunning = false;

  async load(): Promise<void> {
    try {
      const content = await invoke<string>("load_buddy_profile");
      this.text = content ?? "";
      this.loaded = true;
    } catch (error) {
      console.warn("[buddy] failed to load profile:", error);
      this.text = "";
      this.loaded = true;
    }
  }

  getText(): string {
    return this.text;
  }

  async maybeRunDailySummary(): Promise<void> {
    if (!this.loaded || this.summaryRunning) {
      return;
    }

    const today = formatDate(new Date());
    const lastSummary = extractLastSummary(this.text);
    if (lastSummary === today) {
      return;
    }

    this.summaryRunning = true;
    try {
      const sinceMs = startOfDayMs(lastSummary ? nextDay(lastSummary) : yesterday(today));
      const rawEntries = await invoke<ChatMessage[]>("load_chat_since", {
        timestampMs: sinceMs,
      });
      const entries = (rawEntries ?? []).filter(
        (entry) => entry && (entry.role === "user" || entry.role === "buddy"),
      );

      if (entries.length < MIN_ENTRIES_FOR_SUMMARY) {
        return;
      }

      const dialogueText = entries
        .map((entry) => `${entry.role === "user" ? "ユーザー" : "相棒"}: ${entry.text}`)
        .join("\n");

      const prompt = buildSummaryPrompt(dialogueText, today);
      const summary = await invoke<string>("codex_summarize", { prompt });
      const cleaned = sanitizeSummary(summary);
      if (!cleaned) {
        return;
      }

      const updated = this.appendSummary(today, cleaned);
      await invoke("save_buddy_profile", { content: updated });
      this.text = updated;
    } catch (error) {
      console.warn("[buddy] daily summary skipped:", error);
    } finally {
      this.summaryRunning = false;
    }
  }

  private appendSummary(date: string, summary: string): string {
    const maxChars = getBuddyConfig().profile.maxChars;
    const base = this.text.replace(LAST_SUMMARY_RE, "").trimEnd();
    const block = `## ${date} の観察\n${summary}`;
    const separator = base.length > 0 ? "\n\n" : "";
    let combined = `${base}${separator}${block}\n\n<!-- last-summary: ${date} -->\n`;

    if (combined.length > maxChars) {
      combined = trimOldestBlock(combined, maxChars);
    }

    return combined;
  }
}

function buildSummaryPrompt(dialogueText: string, today: string): string {
  return [
    `今日は ${today}。以下は過去約24時間のユーザーと相棒 buddy の対話ログです。`,
    "このログからユーザー (宮崎さん) について、相棒が明日以降の会話で参照したい観察を抽出してください。",
    "",
    "抽出観点 (見出し不要、自然な日本語箇条書き 3〜6 行で):",
    "1. 進行中の案件・関心事 (何に時間を使っているか)",
    "2. 詰まりパターンや癖 (指示の出し方、迷いやすいポイント)",
    "3. 好みや価値観 (評価の基準、避けたい方向性)",
    "",
    "出力は markdown の箇条書きのみ。前置き・見出し・コードフェンス禁止。全体で 280 字以内。",
    "新情報がなければ '新情報なし' とだけ返してください。",
    "",
    "--- 対話ログ ---",
    dialogueText,
  ].join("\n");
}

function sanitizeSummary(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "新情報なし") {
    return "";
  }
  const withoutFence = trimmed.replace(/^```[a-zA-Z]*\n?/, "").replace(/\n?```$/, "");
  return withoutFence.trim().slice(0, 400);
}

function extractLastSummary(text: string): string | null {
  const match = text.match(LAST_SUMMARY_RE);
  return match ? match[1] : null;
}

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function startOfDayMs(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

function nextDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const next = new Date(y, m - 1, d + 1, 0, 0, 0, 0);
  return formatDate(next);
}

function yesterday(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const prev = new Date(y, m - 1, d - 1, 0, 0, 0, 0);
  return formatDate(prev);
}

function trimOldestBlock(content: string, maxChars: number): string {
  const lines = content.split("\n");
  const firstBlockStart = lines.findIndex((line) => /^##\s+\d{4}-\d{2}-\d{2}\s+の観察/.test(line));
  if (firstBlockStart === -1) {
    return content.slice(-maxChars);
  }
  const nextBlockStart = lines.findIndex(
    (line, index) => index > firstBlockStart && /^##\s+\d{4}-\d{2}-\d{2}\s+の観察/.test(line),
  );
  if (nextBlockStart === -1) {
    return content.slice(-maxChars);
  }
  const kept = [...lines.slice(0, firstBlockStart), ...lines.slice(nextBlockStart)].join("\n");
  return kept;
}
