/**
 * Frontend surface for the AI session log analytics module (F1 data layer).
 *
 * Everything that talks to the twelve `ailog_*` Tauri commands lives here:
 * the TypeScript mirrors of the Rust structs (which serialise as camelCase),
 * the invoke wrappers, the Japanese label tables, and the shared number
 * formatters. Components never call `invoke` themselves.
 *
 * Cost caveat, repeated because it is easy to lose: every amount is "what this
 * would have cost on metered pricing", not a bill. The backend ships the exact
 * wording in `costNote`, which the UI prints verbatim rather than paraphrasing.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ---------------------------------------------------------------------------
// Query inputs
// ---------------------------------------------------------------------------

export interface AilogRange {
  from?: number | null;
  to?: number | null;
  preset?: string | null;
}

export interface AilogFilters {
  kinds: string[];
  models: string[];
  projects: string[];
  branches: string[];
  efforts: string[];
  origins: string[];
  includeSidechain: boolean;
  minCost?: number | null;
  query?: string | null;
}

export function emptyFilters(): AilogFilters {
  return {
    kinds: [],
    models: [],
    projects: [],
    branches: [],
    efforts: [],
    origins: [],
    includeSidechain: false,
    minCost: null,
    query: null,
  };
}

// ---------------------------------------------------------------------------
// Report shapes (mirrors of src-tauri/src/ailog/query.rs)
// ---------------------------------------------------------------------------

export interface RangeOut {
  from: number;
  to: number;
  label: string;
}

export interface Totals {
  sessions: number;
  turns: number;
  userMessages: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  costUsd: number;
  wallMs: number;
  activeMs: number;
  projects: number;
  models: number;
}

export interface ComparePrevious {
  sessionsPct: number;
  costPct: number;
  tokensPct: number;
  reworkPct: number;
}

export interface EffortRow {
  effort: string;
  turns: number;
  costUsd: number;
  input: number;
  output: number;
  avgTurnMs: number;
}

export interface ModelRow {
  model: string;
  family: string;
  sessions: number;
  turns: number;
  userMessages: number;
  costUsd: number;
  ingestCostUsd: number;
  generateCostUsd: number;
  sharePct: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  cacheHitRate: number;
  outputDensity: number;
  durationMs: number;
  avgTurnMs: number;
  avgRework: number;
  toolErrorRate: number;
  abandonedRate: number;
  firstUsedAt: number;
  lastUsedAt: number;
  byEffort: EffortRow[];
  priced: boolean;
}

export interface ProjectRow {
  projectLabel: string;
  sessions: number;
  costUsd: number;
  sharePct: number;
  topTitle: string | null;
}

export interface TitleRow {
  title: string;
  kind: string;
  sessionId: string;
  costUsd: number;
  turns: number;
  reworkScore: number;
}

export interface ReworkSummary {
  avgScore: number;
  toolErrorRate: number;
  correctionHits: number;
  churnFiles: number;
  abandonedSessions: number;
}

export interface IndexFreshness {
  lastIndexedAt: number;
  staleFiles: number;
}

export interface Overview {
  range: RangeOut;
  totals: Totals;
  comparePrevious: ComparePrevious;
  topModels: ModelRow[];
  mixedModelSessions: number;
  topProjects: ProjectRow[];
  topTitles: TitleRow[];
  rework: ReworkSummary;
  cacheHitRate: number;
  priceSource: string;
  unpricedModels: string[];
  indexFreshness: IndexFreshness;
  costNote: string;
}

export interface SeriesGroup {
  group: string;
  turns: number;
  sessions: number;
  input: number;
  output: number;
  cacheRead: number;
  costUsd: number;
}

export interface SeriesBucket {
  bucket: number;
  turns: number;
  sessions: number;
  costUsd: number;
  groups: SeriesGroup[];
}

export interface SeriesReport {
  range: RangeOut;
  bucket: string;
  groupBy: string;
  buckets: SeriesBucket[];
  priceSource: string;
  unpricedModels: string[];
  costNote: string;
}

export interface BreakdownRow {
  key: string;
  sessions: number;
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  sharePct: number;
  cacheHitRate: number;
  avgRework: number;
}

export interface BreakdownReport {
  range: RangeOut;
  dimension: string;
  rows: BreakdownRow[];
  overlapping: boolean;
  priceSource: string;
  unpricedModels: string[];
  costNote: string;
}

export interface ModelSeriesEntry {
  model: string;
  costUsd: number;
  tokens: number;
  sessions: number;
}

export interface ModelSeriesBucket {
  bucket: number;
  perModel: ModelSeriesEntry[];
}

export interface Handoff {
  from: string;
  to: string;
  count: number;
}

export interface TagModelEntry {
  model: string;
  sessions: number;
  turns: number;
  costUsd: number;
  ingestCost: number;
  generateCost: number;
  avgRework: number;
}

export interface WorkTagRow {
  workTag: string;
  perModel: TagModelEntry[];
}

export interface ModelsReport {
  range: RangeOut;
  granularity: string;
  rows: ModelRow[];
  series: ModelSeriesBucket[];
  mixedSessions: number;
  handoffs: Handoff[];
  byWorkTag: WorkTagRow[];
  overlapping: boolean;
  totalSessions: number;
  priceSource: string;
  unpricedModels: string[];
  costNote: string;
}

export interface SessionRow {
  kind: string;
  sessionId: string;
  title: string | null;
  projectLabel: string | null;
  gitBranch: string | null;
  origin: string | null;
  primaryModel: string | null;
  modelCount: number;
  isSidechain: boolean;
  workTags: string[];
  startedAt: number | null;
  endedAt: number | null;
  wallMs: number | null;
  activeMs: number | null;
  turnCount: number;
  userMsgCount: number;
  compactCount: number;
  costUsd: number;
  reworkScore: number;
  goalSummary: string | null;
  goalCluster: string | null;
}

export interface SessionsReport {
  range: RangeOut;
  rows: SessionRow[];
  total: number;
  priceSource: string;
  costNote: string;
}

export interface IngestSide {
  tokens: number;
  costUsd: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface GenerateSide {
  tokens: number;
  costUsd: number;
  output: number;
  reasoning: number;
}

export interface IoChars {
  read: number;
  exec: number;
  write: number;
  fetch: number;
  prompt: number;
  other: number;
  estimation: string;
}

export interface IoFiles {
  readFiles: number;
  writtenFiles: number;
}

export interface SessionCostBreakdown {
  ingest: IngestSide;
  generate: GenerateSide;
  ingestRatio: number;
  cacheHitRate: number;
  ioChars: IoChars;
  ioFiles: IoFiles;
  note: string;
}

export interface TurnDetail {
  seq: number;
  requestId: string | null;
  ts: number;
  model: string | null;
  modelFamily: string | null;
  effort: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  durationMs: number | null;
  toolCalls: number;
  toolErrors: number;
  costUsd: number;
}

export interface ToolSummary {
  name: string;
  calls: number;
  errors: number;
}

export interface ReworkDetail {
  toolErrorCount: number;
  toolCallCount: number;
  toolErrorRate: number;
  correctionHits: number;
  maxFileEdits: number;
  churnFiles: number;
  retryBash: number;
  abandoned: boolean;
  score: number;
  scoreNote: string;
}

export interface SummaryRow {
  createdAt: number;
  modelUsed: string | null;
  findings: string | null;
  reworkNote: string | null;
  costNote: string | null;
}

export interface SessionDetail {
  session: SessionRow;
  cwd: string | null;
  aiTitle: string | null;
  firstPrompt: string | null;
  goalKey: string | null;
  agentNames: string[];
  cliVersion: string | null;
  planType: string | null;
  turns: TurnDetail[];
  tools: ToolSummary[];
  rework: ReworkDetail;
  costBreakdown: SessionCostBreakdown;
  summary: SummaryRow | null;
  priceSource: string;
  unpricedModels: string[];
  costNote: string;
}

export interface IndexStatus {
  running: boolean;
  filesDone: number;
  filesTotal: number;
  sessions: number;
  lastFinishedAt: number;
  lastError: string | null;
}

export interface IndexProgress {
  phase: string;
  filesDone: number;
  filesTotal: number;
  sessions: number;
  bytesDone: number;
  bytesTotal: number;
  elapsedMs: number;
}

export interface IndexStartResult {
  started: boolean;
  alreadyRunning: boolean;
}

export interface SummarizeStatus {
  running: boolean;
  sessionsDone: number;
  sessionsTotal: number;
  sessionsRemaining: number;
  lastFinishedAt: number;
  lastError: string | null;
}

export interface SummarizeProgress {
  phase: string;
  sessionsDone: number;
  sessionsTotal: number;
  sessionsRemaining: number;
  elapsedMs: number;
}

export interface SummarizeStartResult {
  started: boolean;
  alreadyRunning: boolean;
}

export interface SummarizeCancelResult {
  cancelled: boolean;
}

export interface IndexCancelResult {
  cancelled: boolean;
}

export const AILOG_INDEX_PROGRESS_EVENT = "ailog://index-progress";
export const AILOG_SUMMARIZE_PROGRESS_EVENT = "ailog://summarize-progress";

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export async function ailogIndexStart(full = false): Promise<IndexStartResult> {
  return invoke<IndexStartResult>("ailog_index_start", { args: { full } });
}

export async function ailogIndexCancel(): Promise<IndexCancelResult> {
  return invoke<IndexCancelResult>("ailog_index_cancel");
}

export async function ailogIndexStatus(): Promise<IndexStatus> {
  return invoke<IndexStatus>("ailog_index_status");
}

export async function ailogSummarizeStart(batchSize?: number): Promise<SummarizeStartResult> {
  return invoke<SummarizeStartResult>("ailog_summarize_start", { batchSize });
}

export async function ailogSummarizeCancel(): Promise<SummarizeCancelResult> {
  return invoke<SummarizeCancelResult>("ailog_summarize_cancel");
}

export async function ailogSummarizeStatus(): Promise<SummarizeStatus> {
  return invoke<SummarizeStatus>("ailog_summarize_status");
}

export async function ailogOverview(
  range: AilogRange,
  filters: AilogFilters,
): Promise<Overview> {
  return invoke<Overview>("ailog_overview", { range, filters });
}

export async function ailogSeries(
  range: AilogRange,
  filters: AilogFilters,
  options: { bucket?: string; groupBy?: string } = {},
): Promise<SeriesReport> {
  return invoke<SeriesReport>("ailog_series", { range, filters, options });
}

export async function ailogBreakdown(
  range: AilogRange,
  filters: AilogFilters,
  dimension: string,
): Promise<BreakdownReport> {
  return invoke<BreakdownReport>("ailog_breakdown", {
    range,
    filters,
    options: { dimension },
  });
}

export async function ailogSessions(
  range: AilogRange,
  filters: AilogFilters,
  options: { sort?: string; limit?: number; offset?: number } = {},
): Promise<SessionsReport> {
  return invoke<SessionsReport>("ailog_sessions", { range, filters, options });
}

export async function ailogSessionDetail(
  kind: string,
  sessionId: string,
): Promise<SessionDetail> {
  return invoke<SessionDetail>("ailog_session_detail", {
    args: { kind, sessionId },
  });
}

export async function ailogModels(
  range: AilogRange,
  filters: AilogFilters,
  options: { granularity?: string; bucket?: string } = {},
): Promise<ModelsReport> {
  return invoke<ModelsReport>("ailog_models", { range, filters, options });
}

export async function listenIndexProgress(
  handler: (progress: IndexProgress) => void,
): Promise<UnlistenFn> {
  return listen<IndexProgress>(AILOG_INDEX_PROGRESS_EVENT, (event) =>
    handler(event.payload),
  );
}

export async function listenSummarizeProgress(
  handler: (progress: SummarizeProgress) => void,
): Promise<UnlistenFn> {
  return listen<SummarizeProgress>(AILOG_SUMMARIZE_PROGRESS_EVENT, (event) =>
    handler(event.payload),
  );
}

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

export type RangePreset = "7d" | "30d" | "90d" | "ytd" | "all" | "custom";

export const RANGE_PRESETS: { id: RangePreset; label: string }[] = [
  { id: "7d", label: "7日" },
  { id: "30d", label: "30日" },
  { id: "90d", label: "90日" },
  { id: "ytd", label: "今年" },
  { id: "all", label: "全期間" },
  { id: "custom", label: "カスタム" },
];

export function rangePresetLabel(preset: RangePreset): string {
  return RANGE_PRESETS.find((entry) => entry.id === preset)?.label ?? preset;
}

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` -> UTC midnight, or null when the string is not a real date. */
export function parseDayInput(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const ms = Date.UTC(year, month - 1, day);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) {
    return null;
  }
  return ms;
}

/** UTC midnight -> `YYYY-MM-DD` (the value shape `<input type="date">` wants). */
export function toDayInput(ms: number): string {
  const date = new Date(ms);
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${date.getUTCDate()}`.padStart(2, "0");
  return `${date.getUTCFullYear()}-${month}-${day}`;
}

/**
 * Turn a preset (plus the two custom date inputs) into the backend `Range`.
 *
 * Returns null only for a custom range whose inputs are not yet two valid
 * dates: the caller keeps showing the previous range instead of silently
 * querying something else. Reversed dates are swapped rather than rejected.
 * Both ends are inclusive — `to` lands on the last millisecond of its day, so
 * picking the same date twice means "that one day".
 */
export function buildRange(
  preset: RangePreset,
  customFrom?: string,
  customTo?: string,
): AilogRange | null {
  if (preset !== "custom") {
    return { preset };
  }
  const from = customFrom ? parseDayInput(customFrom) : null;
  const to = customTo ? parseDayInput(customTo) : null;
  if (from === null || to === null) return null;
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  return { from: start, to: end + DAY_MS - 1 };
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export interface WorkTagLabel {
  /** Japanese display name. English tag ids never reach the screen. */
  label: string;
  /** Why the indexer applied the tag; shown in the tooltip. */
  hint: string;
}

export const WORK_TAG_LABELS: Record<string, WorkTagLabel> = {
  explore: { label: "コード探索", hint: "Read/Grep/Glob が過半" },
  implement: { label: "実装", hint: "Edit/Write が 2 割以上" },
  verify: { label: "検証実行", hint: "cargo/npm/pytest 等を 5 回以上" },
  debug: { label: "デバッグ", hint: "ツール失敗率が高く再実行が多い" },
  orchestrate: { label: "委譲・並列", hint: "サブエージェントを使った" },
  research: { label: "外部調査", hint: "WebFetch/WebSearch/MCP を 3 回以上" },
  converse: { label: "相談・計画", hint: "ツールをほとんど使わず対話中心" },
  longhaul: { label: "長丁場", hint: "100 ターン超 または コンパクト発生" },
};

/** Unknown tags fall through untranslated rather than being dropped. */
export function workTagLabel(tag: string): string {
  return WORK_TAG_LABELS[tag]?.label ?? tag;
}

export function workTagHint(tag: string): string {
  return WORK_TAG_LABELS[tag]?.hint ?? "判定条件は未登録（新しい作業種別）";
}

/** Claude's placeholder model name; excluded by default, never silently. */
export const SYNTHETIC_MODEL = "<synthetic>";

export const KIND_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
};

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function safe(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/** `$1,470.24` — the canonical money format. */
export function formatUsd(value: number): string {
  return `$${safe(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** `$1,470` — same number, no cents, for chart labels where space is tight. */
export function formatUsdShort(value: number): string {
  return `$${Math.round(safe(value)).toLocaleString("en-US")}`;
}

export function formatCount(value: number): string {
  return Math.round(safe(value)).toLocaleString("en-US");
}

/** `12.3M tok` */
export function formatTokens(value: number): string {
  const tokens = safe(value);
  const abs = Math.abs(tokens);
  if (abs >= 1_000_000_000) return `${(tokens / 1_000_000_000).toFixed(1)}B tok`;
  if (abs >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M tok`;
  if (abs >= 1_000) return `${(tokens / 1_000).toFixed(1)}k tok`;
  return `${Math.round(tokens).toLocaleString("en-US")} tok`;
}

/** Takes a 0..1 ratio. `97.8%` */
export function formatRatio(value: number): string {
  return `${(safe(value) * 100).toFixed(1)}%`;
}

/** Takes an already-percent number (the backend's `sharePct`). `97.8%` */
export function formatPct(value: number): string {
  return `${safe(value).toFixed(1)}%`;
}

/** `32.2時間` */
export function formatHours(ms: number): string {
  return `${(safe(ms) / 3_600_000).toFixed(1)}時間`;
}

export function formatScore(value: number): string {
  return safe(value).toFixed(2);
}

export function formatDelta(pct: number): string {
  const value = safe(pct);
  if (Math.abs(value) < 0.05) return "±0.0%";
  const arrow = value > 0 ? "▲" : "▼";
  return `${arrow}${Math.abs(value).toFixed(1)}%`;
}

export function deltaDirection(pct: number): "up" | "down" | "flat" {
  const value = safe(pct);
  if (Math.abs(value) < 0.05) return "flat";
  return value > 0 ? "up" : "down";
}

/** Day buckets are UTC midnights, so they are rendered in UTC too. */
export function formatUtcDay(ms: number): string {
  const date = new Date(ms);
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${date.getUTCDate()}`.padStart(2, "0");
  return `${date.getUTCFullYear()}-${month}-${day}`;
}

export function formatLocalDateTime(ms: number | null | undefined): string {
  if (!ms) return "—";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "—";
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hour = `${date.getHours()}`.padStart(2, "0");
  const minute = `${date.getMinutes()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day} ${hour}:${minute}`;
}

export function formatAgo(ms: number, now = Date.now()): string {
  if (!ms) return "未実行";
  const diff = Math.max(0, now - ms);
  if (diff < 60_000) return "たった今";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}時間前`;
  return `${Math.floor(diff / 86_400_000)}日前`;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}
