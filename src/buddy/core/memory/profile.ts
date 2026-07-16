import type { HostBridge } from "../../adapters/host-bridge";
import { getBuddyConfig } from "../config";
import type { ChatMessage } from "../types";
import type { WorkContextSnapshot, WorkContextStore, WorkSessionSummary } from "./workContext";

const MIN_ENTRIES_FOR_SUMMARY = 4;
const WORK_CONTEXT_LIMIT = 20;

type ProfileFacetKey = "workDomain" | "patterns" | "preferences" | "projects";
type ProfileFacetName = "work-domain" | "patterns" | "preferences" | "projects";

interface ProfileFacets {
  workDomain: string;
  patterns: string;
  preferences: string;
  projects: string;
}

interface ObservationState {
  lastDailySummary?: string | null;
  lastWeeklyReport?: string | null;
}

interface ProfileFacetDefinition {
  key: ProfileFacetKey;
  name: ProfileFacetName;
  heading: string;
}

const FACET_DEFINITIONS: ProfileFacetDefinition[] = [
  { key: "workDomain", name: "work-domain", heading: "領域知識" },
  { key: "patterns", name: "patterns", heading: "詰まり方・判断のクセ" },
  { key: "preferences", name: "preferences", heading: "評価軸・好み" },
  { key: "projects", name: "projects", heading: "進行中案件" },
];

export class ProfileStore {
  private facets: ProfileFacets = createEmptyFacets();
  private loaded = false;
  private summaryRunning = false;

  constructor(private readonly host: HostBridge) {}

  async load(): Promise<void> {
    try {
      const facets = await this.host.invoke<ProfileFacets>("load_buddy_profile_facets");
      this.facets = normalizeFacets(facets);
      this.loaded = true;
    } catch (error) {
      console.warn("[buddy] プロファイルを読み込めませんでした:", error);
      this.facets = createEmptyFacets();
      this.loaded = true;
    }
  }

  getText(): string {
    return FACET_DEFINITIONS.map((definition) => {
      const content = this.facets[definition.key].trim();
      return content ? `## ${definition.heading}\n${content}` : null;
    })
      .filter((section): section is string => Boolean(section))
      .join("\n\n");
  }

  async maybeRunDailySummary(workContext?: WorkContextStore): Promise<void> {
    if (!this.loaded || this.summaryRunning) {
      return;
    }

    const today = formatDate(new Date());
    this.summaryRunning = true;
    try {
      const state = await this.host.invoke<ObservationState>("load_observation_state");
      const lastSummary = normalizeDate(state.lastDailySummary);
      if (lastSummary === today) {
        return;
      }

      const sinceMs = startOfDayMs(lastSummary ? nextDay(lastSummary) : yesterday(today));
      const rawEntries = await this.host.invoke<ChatMessage[]>("load_chat_since", {
        timestampMs: sinceMs,
      });
      const entries = (rawEntries ?? []).filter(
        (entry) => entry && (entry.role === "user" || entry.role === "buddy"),
      );
      const workDigest = await loadRecentWorkDigest(this.host, sinceMs, workContext);

      if (entries.length < MIN_ENTRIES_FOR_SUMMARY && workDigest.sessionCount === 0) {
        return;
      }

      const dialogueText = entries
        .map((entry) => `${entry.role === "user" ? "ユーザー" : "相棒"}: ${entry.text}`)
        .join("\n")
        .trim();

      const prompt = buildSummaryPrompt(dialogueText, workDigest.text, today);
      const summary = await this.host.invoke<string>("codex_summarize", { prompt });
      const sections = parseCategorizedSummary(summary);

      for (const definition of FACET_DEFINITIONS) {
        const content = sanitizeSection(sections[definition.key] ?? "");
        if (!content) {
          continue;
        }

        const updated = appendObservationBlock(this.facets[definition.key], today, content);
        await this.host.invoke("save_buddy_profile_facet", {
          facet: definition.name,
          content: updated,
        });
        this.facets[definition.key] = updated;
      }

      await this.host.invoke("save_observation_state", {
        state: {
          lastDailySummary: today,
          lastWeeklyReport: normalizeDate(state.lastWeeklyReport),
        },
      });
    } catch (error) {
      console.warn("[buddy] 日次サマリをスキップしました:", error);
    } finally {
      this.summaryRunning = false;
    }
  }
}

async function loadRecentWorkDigest(
  host: HostBridge,
  sinceMs: number,
  workContext?: WorkContextStore,
): Promise<{ text: string; sessionCount: number }> {
  try {
    const snapshot =
      workContext?.getSnapshot() ??
      (await host.invoke<WorkContextSnapshot>("load_work_context", {
        limit: WORK_CONTEXT_LIMIT,
      }));
    const sessions = (snapshot.sessions ?? []).filter(
      (session) => Number(session.lastActivityMs) >= sinceMs,
    );

    return {
      text: formatWorkDigest(sessions),
      sessionCount: sessions.length,
    };
  } catch (error) {
    console.warn("[buddy] 作業ストリームの読み取りをスキップしました:", error);
    return { text: "", sessionCount: 0 };
  }
}

function formatWorkDigest(sessions: WorkSessionSummary[]): string {
  return sessions
    .map((session, index) => {
      const project = session.projectPath?.trim() || "(プロジェクト不明)";
      const recent = previewText(session.recentText || session.title || "(内容なし)", 220);
      return [
        `- 作業${index + 1}`,
        `  エージェント: ${session.agent}`,
        `  プロジェクト: ${project}`,
        `  内容: ${recent}`,
      ].join("\n");
    })
    .join("\n\n");
}

function buildSummaryPrompt(dialogueText: string, workDigestText: string, today: string): string {
  return [
    `今日は ${today}。以下は過去約24時間の宮崎さんと相棒 buddy の対話ログ、およびClaude/Codexの実作業ストリームです。`,
    "この情報から、明日以降の会話で参照したい宮崎さんについての観察を抽出してください。",
    "",
    "必ず次の4見出しちょうどで分類し、この順番で1回ずつ出力してください。",
    "",
    "### 領域知識",
    "### 詰まり方・判断のクセ",
    "### 評価軸・好み",
    "### 進行中案件",
    "",
    "各見出しの下は日本語の箇条書き0〜4行。該当が無ければ「新情報なし」とだけ書いてください。",
    "前置き・補足・コードフェンスは禁止です。",
    "",
    "--- 対話ログ ---",
    dialogueText || "(新しい対話なし)",
    "",
    "--- 実作業ストリーム ---",
    workDigestText || "(新しい作業ストリームなし)",
  ].join("\n");
}

function parseCategorizedSummary(raw: string): Partial<Record<ProfileFacetKey, string>> {
  const result: Partial<Record<ProfileFacetKey, string>> = {};
  const headingMap = new Map(
    FACET_DEFINITIONS.map((definition) => [definition.heading, definition.key] as const),
  );
  let currentKey: ProfileFacetKey | null = null;

  for (const line of stripCodeFence(raw).split(/\r?\n/)) {
    const heading = line.trim().match(/^###\s*(.+?)\s*$/);
    if (heading) {
      currentKey = headingMap.get(heading[1]) ?? null;
      if (currentKey && result[currentKey] === undefined) {
        result[currentKey] = "";
      }
      continue;
    }

    if (!currentKey) {
      continue;
    }

    result[currentKey] = `${result[currentKey] ?? ""}${line}\n`;
  }

  return result;
}

function sanitizeSection(raw: string): string {
  const content = stripCodeFence(raw)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .join("\n")
    .trim();

  if (!content) {
    return "";
  }

  const meaningfulLines = content
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*・]\s*/, "").trim())
    .filter(Boolean);

  if (meaningfulLines.length > 0 && meaningfulLines.every((line) => line === "新情報なし")) {
    return "";
  }

  return content;
}

function appendObservationBlock(existing: string, date: string, content: string): string {
  const maxChars = getBuddyConfig().profile.maxChars;
  const base = existing.trimEnd();
  const block = `## ${date} の観察\n${content}`;
  const separator = base.length > 0 ? "\n\n" : "";
  const combined = `${base}${separator}${block}\n`;
  return trimOldestBlock(combined, maxChars);
}

function stripCodeFence(raw: string): string {
  return raw.trim().replace(/^```[a-zA-Z]*\n?/, "").replace(/\n?```$/, "");
}

function normalizeFacets(facets: Partial<ProfileFacets> | null | undefined): ProfileFacets {
  return {
    workDomain: facets?.workDomain ?? "",
    patterns: facets?.patterns ?? "",
    preferences: facets?.preferences ?? "",
    projects: facets?.projects ?? "",
  };
}

function createEmptyFacets(): ProfileFacets {
  return {
    workDomain: "",
    patterns: "",
    preferences: "",
    projects: "",
  };
}

function normalizeDate(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function previewText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 3)}...` : normalized;
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
  let trimmed = content;

  while (trimmed.length > maxChars) {
    const lines = trimmed.split("\n");
    const firstBlockStart = lines.findIndex((line) =>
      /^##\s+\d{4}-\d{2}-\d{2}\s+の観察/.test(line),
    );
    if (firstBlockStart === -1) {
      return trimmed.slice(-maxChars);
    }
    const nextBlockStart = lines.findIndex(
      (line, index) =>
        index > firstBlockStart && /^##\s+\d{4}-\d{2}-\d{2}\s+の観察/.test(line),
    );
    if (nextBlockStart === -1) {
      return trimmed.slice(-maxChars);
    }
    trimmed = [...lines.slice(0, firstBlockStart), ...lines.slice(nextBlockStart)].join("\n");
  }

  return trimmed;
}
