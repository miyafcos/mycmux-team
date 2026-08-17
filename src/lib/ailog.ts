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
import { aiSettingsStrings } from "../components/settings/settingsStrings";

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
  modelClass: ModelPriceClass;
}

export type ModelPriceClass = "priced" | "local" | "internal" | "flat" | "unknown";

export interface PriceClassCoverage {
  models: string[];
  tokens: number;
}

export interface PriceCoverage {
  priced: PriceClassCoverage;
  local: PriceClassCoverage;
  internal: PriceClassCoverage;
  flat: PriceClassCoverage;
  unknown: PriceClassCoverage;
  coveredTokenRatio: number;
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

export interface ExcludedInternal {
  sessions: number;
  costUsd: number;
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
  excludedInternal: ExcludedInternal;
  cacheHitRate: number;
  priceSource: string;
  priceCoverage: PriceCoverage;
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
  /**
   * 5m and 1h cache writes combined. Reasoning tokens are deliberately absent:
   * both providers already count them inside `output`, so a total that added
   * them would double-count.
   */
  cacheWrite: number;
  costUsd: number;
}

/** The one UI choice used by both the daily series and model breakdown. */
export type AilogGranularity = "provider" | "family" | "raw";
export type SeriesGroupBy = "provider" | "model" | "model_raw" | "project" | "kind" | "effort";
export type PivotAxis = SeriesGroupBy | "origin";
export type UsageBucket = "day" | "week" | "month";

/**
 * Dashboard / models still speak provider|family|raw. A usage-only axis
 * (project, kind, effort) is sent as family so those commands stay valid.
 */
export function granularityFromSeriesAxis(axis: SeriesGroupBy): AilogGranularity {
  if (axis === "provider") return "provider";
  if (axis === "model_raw") return "raw";
  return "family";
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
  groupBy: SeriesGroupBy;
  buckets: SeriesBucket[];
  priceSource: string;
  priceCoverage: PriceCoverage;
  costNote: string;
}

// ---------------------------------------------------------------------------
// Usage rhythm (ailog_usage_rhythm)
// ---------------------------------------------------------------------------

export interface RhythmTotals {
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** input + output + cacheRead + cacheWrite. */
  total: number;
  /** input + output. What was actually sent and generated fresh. */
  io: number;
  costUsd: number;
}

export interface RhythmDay {
  /** Start of the local day, as a UTC epoch-millisecond timestamp. */
  day: number;
  turns: number;
  io: number;
  total: number;
  costUsd: number;
}

/** Hour-of-day (0-23) or weekday (0 = Sunday). Always the full cycle. */
export interface RhythmSlot {
  slot: number;
  turns: number;
  io: number;
  total: number;
}

export interface StreakInfo {
  /** Consecutive active days ending at `currentThroughDay` — not necessarily today. */
  current: number;
  currentThroughDay: number | null;
  longest: number;
  longestEndDay: number | null;
}

export interface UsageRhythmReport {
  range: RangeOut;
  /** Minutes east of UTC used to cut days; matches `DAY_OFFSET_MIN`. */
  dayOffsetMinutes: number;
  totals: RhythmTotals;
  days: RhythmDay[];
  byHour: RhythmSlot[];
  byWeekday: RhythmSlot[];
  activeDays: number;
  /** Calendar days between the first and last active day, inclusive. */
  spanDays: number;
  firstDay: number | null;
  lastDay: number | null;
  streak: StreakInfo;
  busiestTotal: RhythmDay | null;
  busiestIo: RhythmDay | null;
  indexFreshness: IndexFreshness;
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
  priceCoverage: PriceCoverage;
  costNote: string;
}

export interface PivotRow {
  key: string;
  total: SeriesGroup;
  cells: SeriesGroup[];
}

export interface PivotReport {
  range: RangeOut;
  rowBy: PivotAxis;
  colBy: PivotAxis;
  cols: string[];
  rows: PivotRow[];
  colTotals: SeriesGroup[];
  grandTotal: SeriesGroup;
  priceSource: string;
  priceCoverage: PriceCoverage;
  costNote: string;
}

export interface EfficiencyRow {
  key: string;
  sessions: number;
  turns: number;
  avgSessionCost: number;
  avgRework: number;
  cacheHitRate: number;
  outputDensity: number;
  abandonedRate: number;
}

export interface QuantileRow {
  quantile: string;
  minTurns: number;
  maxTurns: number;
  sessions: number;
  avgCost: number;
  avgRework: number;
}

export interface EfficiencyReport {
  range: RangeOut;
  byModel: EfficiencyRow[];
  byEffort: EfficiencyRow[];
  bySubagent: EfficiencyRow[];
  byCompaction: EfficiencyRow[];
  turnQuantiles: QuantileRow[];
  priceSource: string;
  priceCoverage: PriceCoverage;
  interpretationNote: string;
  costNote: string;
}

export interface PriceEntry {
  model: string;
  inputPerMtok: number;
  outputPerMtok: number;
  cacheReadPerMtok: number;
  cacheWrite5mPerMtok: number;
  cacheWrite1hPerMtok: number;
  source: string;
  updatedAt: number;
}

export interface SetPriceResult {
  model: string;
  repricedSessions: number;
}

export interface RuleCheckSession {
  kind: string;
  sessionId: string;
  title: string | null;
  projectLabel: string | null;
  costUsd: number;
  maxContextTokens: number;
  compactCount: number;
}

export interface RuleCheckFinding {
  count: number;
  sessions: RuleCheckSession[];
}

export interface RuleCheckReport {
  range: RangeOut;
  largeContext: RuleCheckFinding;
  compacted: RuleCheckFinding;
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
  granularity: AilogGranularity;
  rows: ModelRow[];
  series: ModelSeriesBucket[];
  mixedSessions: number;
  handoffs: Handoff[];
  byWorkTag: WorkTagRow[];
  overlapping: boolean;
  totalSessions: number;
  priceSource: string;
  priceCoverage: PriceCoverage;
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

export interface TranscriptMessage {
  role: string;
  text: string;
  toolName: string | null;
  toolTarget: string | null;
}

export interface TranscriptReport {
  messages: TranscriptMessage[];
  truncated: boolean;
  omittedCount: number;
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
  outcome: string | null;
  confidence: string | null;
  reworkCategory: string | null;
  promptVersion: number | null;
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
  priceCoverage: PriceCoverage;
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
  elapsedMs: number;
  estimatedInputChars: number;
  inputTokens: number;
  outputTokens: number;
}

export type DigestConfidence = "high" | "medium" | "low";

export interface DigestContent {
  headline: string;
  wins: string[];
  biggestRework: { exists: boolean; text: string };
  valueNote: string;
  suggestion: string;
  confidence: DigestConfidence;
}

export interface DigestOutcomes {
  done: number;
  partial: number;
  abandoned: number;
  unclear: number;
}

export interface DigestMetrics {
  sessions: number;
  costUsd: number;
  turns: number;
  averageRework: number;
  outcomes: DigestOutcomes;
  previousSessions: number;
  previousCostUsd: number;
  previousTurns: number;
  costPct: number;
}

export interface DigestRecord {
  date: string;
  createdAt: number;
  promptVersion: number;
  modelUsed: string | null;
  content: DigestContent;
}

export interface DigestReport {
  date: string;
  digest: DigestRecord | null;
  metrics: DigestMetrics;
  reason: string | null;
  parseError: string | null;
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
  targetCount: number;
  estimatedInputChars: number;
}

export interface SummarizeCancelResult {
  cancelled: boolean;
}

export interface DashboardReport {
  overview: Overview;
  series: SeriesReport;
  models: ModelsReport;
  projects: BreakdownReport;
  sessions: SessionsReport;
}

export type FindingKind = "cause" | "constraint" | "gotcha" | "decision" | "verified";

export interface FindingRow {
  text: string;
  kind: FindingKind;
  sessionId: string;
  sessionKind: string;
  date: number;
  goalSummary: string | null;
  projectLabel: string | null;
  costUsd: number;
  repeatCount: number;
}

export interface FindingsReport {
  rows: FindingRow[];
  total: number;
}

export interface ToolRankingRow {
  name: string;
  target: string | null;
  executions: number;
  failures: number;
  failureRate: number;
}

export interface FileRankingRow {
  path: string;
  editCount: number;
  sessionCount: number;
}

export interface ReworkRankingsReport {
  failedCommands: ToolRankingRow[];
  rewrittenFiles: FileRankingRow[];
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

export type SummaryRangePreset = "7d" | "30d" | "all";

export const SUMMARY_RANGE_PRESETS: { id: SummaryRangePreset; label: string }[] = [
  { id: "7d", label: "直近7日" },
  { id: "30d", label: "直近30日" },
  { id: "all", label: "全部" },
];

export async function ailogSummarizeStart(batchSize?: number, force = false, range: AilogRange = { preset: "7d" }): Promise<SummarizeStartResult> {
  return invoke<SummarizeStartResult>("ailog_summarize_start", { batchSize, force, range });
}

export async function ailogSummarizeCancel(): Promise<SummarizeCancelResult> {
  return invoke<SummarizeCancelResult>("ailog_summarize_cancel");
}

export async function ailogSummarizeStatus(range: AilogRange = { preset: "7d" }): Promise<SummarizeStatus> {
  return invoke<SummarizeStatus>("ailog_summarize_status", { range });
}

export async function ailogDigestGet(date: string): Promise<DigestReport> {
  return invoke<DigestReport>("ailog_digest_get", { date });
}

export async function ailogDigestGenerate(date: string, force = false): Promise<DigestReport> {
  return invoke<DigestReport>("ailog_digest_generate", { date, force });
}

export async function ailogDashboard(
  range: AilogRange,
  filters: AilogFilters,
  granularity: AilogGranularity,
): Promise<DashboardReport> {
  return invoke<DashboardReport>("ailog_dashboard", {
    range,
    filters,
    args: { granularity },
  });
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
  options: { bucket?: string; groupBy?: SeriesGroupBy } = {},
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

export async function ailogPivot(
  range: AilogRange,
  filters: AilogFilters,
  options: { rowBy: PivotAxis; colBy: PivotAxis },
): Promise<PivotReport> {
  return invoke<PivotReport>("ailog_pivot", { range, filters, options });
}

export async function ailogEfficiency(
  range: AilogRange,
  filters: AilogFilters,
): Promise<EfficiencyReport> {
  return invoke<EfficiencyReport>("ailog_efficiency", { range, filters });
}

export async function ailogRuleCheck(
  range: AilogRange,
  filters: AilogFilters,
): Promise<RuleCheckReport> {
  return invoke<RuleCheckReport>("ailog_rule_check", { range, filters });
}

export async function ailogGetPrices(): Promise<PriceEntry[]> {
  return invoke<PriceEntry[]>("ailog_get_prices");
}

export async function ailogSetPrice(entry: PriceEntry): Promise<SetPriceResult> {
  return invoke<SetPriceResult>("ailog_set_price", { entry });
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

export async function ailogSessionTranscript(kind: string, sessionId: string): Promise<TranscriptReport> {
  return invoke<TranscriptReport>("ailog_session_transcript", { args: { kind, sessionId } });
}

export async function ailogSessionSummarize(kind: string, sessionId: string): Promise<void> {
  return invoke<void>("ailog_session_summarize", { args: { kind, sessionId } });
}

export async function ailogModels(
  range: AilogRange,
  filters: AilogFilters,
  options: { granularity?: AilogGranularity; bucket?: string } = {},
): Promise<ModelsReport> {
  return invoke<ModelsReport>("ailog_models", { range, filters, options });
}

export async function ailogFindings(
  range: AilogRange,
  filters: AilogFilters,
  options: { kind?: FindingKind | null; query?: string; limit?: number; offset?: number } = {},
): Promise<FindingsReport> {
  return invoke<FindingsReport>("ailog_findings", { range, filters, ...options });
}

export async function ailogReworkRankings(
  range: AilogRange,
  filters: AilogFilters,
): Promise<ReworkRankingsReport> {
  return invoke<ReworkRankingsReport>("ailog_rework_rankings", { range, filters });
}

export async function ailogUsageRhythm(
  range: AilogRange,
  filters: AilogFilters,
): Promise<UsageRhythmReport> {
  return invoke<UsageRhythmReport>("ailog_usage_rhythm", { range, filters });
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

/**
 * Minutes east of UTC used to cut day buckets. Must match
 * `DAY_BOUNDARY_OFFSET_MIN` in `src-tauri/src/ailog/query.rs`: the backend
 * snaps buckets to local midnight, so formatting them in UTC would show every
 * bucket a day early.
 */
export const DAY_OFFSET_MIN = 540;
const DAY_OFFSET_MS = DAY_OFFSET_MIN * 60_000;

/** `YYYY-MM-DD` -> local midnight, or null when the string is not a real date. */
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
  return ms - DAY_OFFSET_MS;
}

/** Local midnight -> `YYYY-MM-DD` (the value shape `<input type="date">` wants). */
export function toDayInput(ms: number): string {
  return formatDayBucket(ms);
}

/** `YYYY-MM-DD` for today (or `offsetDays` away), in the bucketing timezone. */
export function dayOffsetInput(offsetDays = 0, now = Date.now()): string {
  return formatDayBucket(now + offsetDays * DAY_MS);
}

/** Shift a `YYYY-MM-DD` string by whole days, staying in the bucket timezone. */
export function shiftDayInput(value: string, offsetDays: number): string {
  const parsed = parseDayInput(value);
  if (parsed === null) return value;
  return formatDayBucket(parsed + offsetDays * DAY_MS);
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

/**
 * Render a day bucket. Buckets arrive snapped to local midnight (see
 * `DAY_OFFSET_MIN`), so the offset is added back before reading the calendar
 * fields off the UTC side of the Date.
 */
export function formatDayBucket(ms: number): string {
  const date = new Date(ms + DAY_OFFSET_MS);
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${date.getUTCDate()}`.padStart(2, "0");
  return `${date.getUTCFullYear()}-${month}-${day}`;
}

/**
 * Chart-axis label for a bucket start. Date inputs keep `formatDayBucket`
 * (`YYYY-MM-DD`); this one is the shorter unit-aware form.
 */
export function formatBucketLabel(ms: number, bucket: UsageBucket): string {
  const date = new Date(ms + DAY_OFFSET_MS);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  if (bucket === "month") return `${year}-${`${month}`.padStart(2, "0")}`;
  const md = `${month}/${day}`;
  return bucket === "week" ? `${md}週` : md;
}

/** Weekday of a day bucket, 0 = Sunday, in the bucketing timezone. */
export function dayBucketWeekday(ms: number): number {
  return new Date(ms + DAY_OFFSET_MS).getUTCDay();
}

/** Month index (0-11) of a day bucket, in the bucketing timezone. */
export function dayBucketMonth(ms: number): number {
  return new Date(ms + DAY_OFFSET_MS).getUTCMonth();
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

/** `1分30秒` / `45秒` / `2時間5分` */
export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(safe(ms) / 1000));
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hours > 0) return `${hours}時間${mins}分`;
  if (mins > 0) return `${mins}分${secs}秒`;
  return `${secs}秒`;
}

/** `128MB` / `1.2GB` */
export function formatBytes(bytes: number): string {
  const value = Math.max(0, safe(bytes));
  if (value >= 1_073_741_824) return `${(value / 1_073_741_824).toFixed(1)}GB`;
  if (value >= 1_048_576) return `${(value / 1_048_576).toFixed(0)}MB`;
  if (value >= 1_024) return `${(value / 1_024).toFixed(0)}KB`;
  return `${Math.round(value)}B`;
}

export function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  // The summarise/digest commands reject with this marker rather than a
  // Japanese sentence, so the backend stays free of UI copy.
  if (raw.trim() === "ai_disabled") return aiSettingsStrings.disabledReason;
  return raw;
}
