import type { PtyMetadataSnapshot, SessionOutputSnapshot } from "../../lib/ipc";
import type { PaneMetadata } from "../../stores/paneMetadataStore";
import type { PaneTab, Workspace } from "../../types";
import { reconcileSplitColumnsForPanes } from "../../lib/layoutColumns";
import { aiProviderDef, type AiProviderId } from "../../lib/aiModels";
import { aiSettingsStrings } from "../settings/settingsStrings";
import {
  handleSocketCommand,
  processStatusReasonForTab,
  readPaneTail,
} from "./socketCommands";

export const TAB_SWEEP_IDLE_MS = 5 * 60 * 1000;
import { useDashboardViewStore } from "../../stores/dashboardViewStore";

export const TAB_SWEEP_TAIL_LINES = 8;
export const TAB_NAMING_TAIL_LINES = 14;
export const TAB_NAMING_LABEL_MAX = 20;
export const TAB_SWEEP_OPEN_EVENT = "mycmux:tab-sweep-open";
export const TAB_RESTORE_CLOSED_EVENT = "mycmux:restore-closed-tab";

/** Opens the only sweep surface, then waits for its dashboard-local listener. */
export function openTabSweepInDashboard(): void {
  if (typeof window === "undefined") return;
  useDashboardViewStore.getState().openView();
  window.setTimeout(() => window.dispatchEvent(new Event(TAB_SWEEP_OPEN_EVENT)), 0);
}

export type SweepCategory = "DEAD" | "LOCKED" | "CANDIDATE";
export type SweepLockReason =
  | "active"
  | "recent_output"
  | "queued_input"
  | "working"
  | "buffer_unavailable"
  | "not_at_prompt"
  | "unsupported_tab";
export type JudgeVerdict = "done_waiting" | "queued_input" | "working" | "unknown";

export interface SweepTab {
  id: string;
  sessionId: string;
  workspaceId: string;
  workspaceName: string;
  paneId: string;
  label?: string;
  cwd?: string;
  category: SweepCategory;
  lockReasons: SweepLockReason[];
  unnamed: boolean;
  tail: string[];
  processStatusReason: string | null;
  lastOutputAt: number | null;
}

export interface SweepReport {
  scannedAt: number;
  tabs: SweepTab[];
  dead: SweepTab[];
  locked: SweepTab[];
  candidates: SweepTab[];
  unnamed: SweepTab[];
}

export interface Verdict {
  id: string;
  verdict: JudgeVerdict;
  label?: string;
}

export interface SweepScanSource {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  metadata: Record<string, PaneMetadata>;
  processMetadata: PtyMetadataSnapshot;
  processMetadataAvailable: boolean;
  lastOutputBySession: SessionOutputSnapshot;
  isScreenObserved: (sessionId: string) => boolean;
  readTail: (sessionId: string, lines: number) => Promise<string[]>;
  now: number;
}

export interface SweepPlan {
  closeDeadTabIds?: string[];
  closeCandidateTabIds?: string[];
  manualCloseCandidateTabIds?: string[];
  verdicts?: Verdict[];
  renames?: Array<{ id: string; label: string; overwrite?: boolean }>;
}

export interface NamingTab {
  id: string;
  sessionId: string;
  label: string;
  labelSource?: PaneTab["labelSource"];
  cwd: string;
  agentKind: string;
  isPaneHead: boolean;
  tail: string[];
}

export interface NamingPaneGroup {
  paneId: string;
  column: number;
  tabs: NamingTab[];
}

export interface NamingProposal {
  id: string;
  label: string;
}

export interface NamingParseResult {
  proposals: NamingProposal[];
  valid: boolean;
}

export interface SweepApplyResult {
  closed: number;
  renamed: number;
  skipped: string[];
  errors: string[];
}

export interface SweepApplyDependencies {
  scan: (id?: string) => Promise<SweepReport>;
  command: (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * One line of the sweep panel's single list. `selectable` is the only gate on
 * whether the row's checkbox can be ticked — LOCKED tabs are never closable,
 * everything else is, judged or not.
 */
export interface SweepRow {
  tab: SweepTab;
  kind: SweepCategory;
  selectable: boolean;
}

export interface JudgeParseResult {
  verdicts: Verdict[];
  valid: boolean;
}

export interface JudgeErrorPresentation {
  summary: string;
  raw: string;
}

const STATUS_LINE_PATTERNS: readonly RegExp[] = [
  /^[-─━═┄┅┈┉┊┋│┃┌┐└┘├┤┬┴┼╭╮╰╯┏┓┗┛┣┫┳┻╋\s]+$/u,
  /^[⏵▶▷»›*•\s]*(?:\? for shortcuts|esc to interrupt|bypass permissions on|shift\+tab to cycle mode)/i,
  /[|│]\s*CTX\s+.+[|│]\s*\$[^|│]+[|│].+[|│]\s*API\s+/i,
  /^5h\s+.+[|│]\s*7d\s+/i,
  /^CC\s+\S+\s+[|│]\s*sid\s+/i,
  /^Context\s+\d+%\s+used\s+·/i,
  /^(?:context left|tokens? left|auto-compact)/i,
];

function isTerminalTab(tab: PaneTab): boolean {
  return tab.type === undefined || tab.type === "terminal";
}

function isDeadReason(reason: string | null): boolean {
  return reason === "no_live_pty_session" || reason === "snapshot_unavailable";
}

export function isIgnoredPromptDecoration(line: string): boolean {
  const normalized = line.trim();
  return normalized.length === 0 || STATUS_LINE_PATTERNS.some((pattern) => pattern.test(normalized));
}

interface PromptMatch {
  input: string;
}

function matchPromptLine(line: string): PromptMatch | null {
  const claudeIndex = line.lastIndexOf("❯");
  if (claudeIndex >= 0) return { input: line.slice(claudeIndex + 1).trim() };
  const patterns = [
    /^\s*PS\s+[A-Za-z]:\\[^>\r\n]*>\s*(.*)$/i,
    /^\s*(?:[A-Za-z]:\\|\\\\)[^>\r\n]*>\s*(.*)$/,
    /^\s*(?:[\w.-]+@[\w.-]+(?::[^\r\n$#]{0,120})?|[~/.\\:\w-]{0,120})?[$#]\s*(.*)$/,
  ];
  for (const pattern of patterns) {
    const match = line.match(pattern);
    if (match) return { input: (match[1] ?? "").trim() };
  }
  return null;
}

function findLastPrompt(tail: readonly string[]): { index: number; match: PromptMatch } | null {
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const match = matchPromptLine(tail[index] ?? "");
    if (match) return { index, match };
  }
  return null;
}

export function hasQueuedInput(tail: readonly string[]): boolean {
  const prompt = findLastPrompt(tail);
  if (!prompt) return false;
  if (prompt.match.input.length > 0 && !isIgnoredPromptDecoration(prompt.match.input)) return true;
  return tail.slice(prompt.index + 1).some((nextLine) => !isIgnoredPromptDecoration(nextLine));
}

export function getQueuedInputPreview(tail: readonly string[]): string | undefined {
  const prompt = findLastPrompt(tail);
  if (!prompt || !hasQueuedInput(tail)) return undefined;
  if (prompt.match.input.length > 0 && !isIgnoredPromptDecoration(prompt.match.input)) {
    return prompt.match.input;
  }
  return tail
    .slice(prompt.index + 1)
    .map((line) => line.trim())
    .find((line) => !isIgnoredPromptDecoration(line));
}

export function hasIdlePrompt(tail: readonly string[]): boolean {
  return findLastPrompt(tail) !== null && !hasQueuedInput(tail);
}

export function lastMeaningfulTailLine(tail: readonly string[]): string {
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const line = (tail[index] ?? "").trim().replace(/\s+/g, " ");
    if (!line || isIgnoredPromptDecoration(line)) continue;
    const prompt = matchPromptLine(line);
    if (prompt && !prompt.input) continue;
    return line;
  }
  return "待機プロンプト";
}

export function formatLastOutputAge(lastOutputAt: number | null, now: number): string {
  if (lastOutputAt === null) return "最終出力時刻不明";
  const elapsedSeconds = Math.max(0, Math.floor((now - lastOutputAt) / 1000));
  if (elapsedSeconds < 60) return `最終出力から${elapsedSeconds}秒`;
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `最終出力から${elapsedMinutes}分`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `最終出力から${elapsedHours}時間`;
  return `最終出力から${Math.floor(elapsedHours / 24)}日`;
}

/**
 * The same elapsed value without the shared sentence stem, for surfaces that
 * only have room for the number (the minimap chip's meta row). Kept as its own
 * branch rather than a substring of formatLastOutputAge so rewording the
 * sentence can never silently blank the compact form.
 */
export function formatLastOutputAgeCompact(lastOutputAt: number | null, now: number): string | null {
  if (lastOutputAt === null) return null;
  const elapsedSeconds = Math.max(0, Math.floor((now - lastOutputAt) / 1000));
  if (elapsedSeconds < 60) return `${elapsedSeconds}秒`;
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}分`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}時間`;
  return `${Math.floor(elapsedHours / 24)}日`;
}

export function shortenCwdFromStart(cwd: string, maxLength = 56): string {
  const characters = Array.from(cwd);
  if (characters.length <= maxLength) return cwd;
  return `…${characters.slice(-(maxLength - 1)).join("")}`;
}

const SWEEP_ROW_ORDER: Record<SweepCategory, number> = { DEAD: 0, CANDIDATE: 1, LOCKED: 2 };

/**
 * Flatten a report into the panel's single ordered list: DEAD first (safe and
 * usually what the user came for), then CANDIDATE oldest-output-first, then the
 * LOCKED tabs that exist only to explain why they are not offered.
 */
export function buildSweepRows(report: SweepReport | null): SweepRow[] {
  if (!report) return [];
  const rows: SweepRow[] = report.tabs.map((tab) => ({
    tab,
    kind: tab.category,
    selectable: tab.category !== "LOCKED",
  }));
  return rows.sort((first, second) => {
    const byKind = SWEEP_ROW_ORDER[first.kind] - SWEEP_ROW_ORDER[second.kind];
    if (byKind !== 0) return byKind;
    if (first.kind !== "CANDIDATE") return 0;
    // Unknown last-output sorts as oldest; Array#sort is stable so ties keep scan order.
    return (first.tab.lastOutputAt ?? 0) - (second.tab.lastOutputAt ?? 0);
  });
}

/** DEAD rows start ticked, CANDIDATE rows start clear, LOCKED rows cannot be ticked. */
export function initialSweepSelection(rows: readonly SweepRow[]): Set<string> {
  return new Set(rows.filter((row) => row.kind === "DEAD").map((row) => row.tab.id));
}

/** Drop ids that no longer exist or stopped being selectable after a rescan. */
export function retainSweepSelection(
  selection: ReadonlySet<string>,
  rows: readonly SweepRow[],
): Set<string> {
  const selectable = new Set(rows.filter((row) => row.selectable).map((row) => row.tab.id));
  return new Set([...selection].filter((id) => selectable.has(id)));
}

/**
 * The AI judge proposes ticks; it never removes them and never gates closing.
 * done_waiting candidates get checked, every other choice the user made stands.
 */
export function applyVerdictSelection(
  selection: ReadonlySet<string>,
  rows: readonly SweepRow[],
  verdicts: readonly Verdict[],
): Set<string> {
  const doneIds = new Set(
    verdicts.filter((verdict) => verdict.verdict === "done_waiting").map((verdict) => verdict.id),
  );
  const next = retainSweepSelection(selection, rows);
  for (const row of rows) {
    if (row.kind === "CANDIDATE" && doneIds.has(row.tab.id)) next.add(row.tab.id);
  }
  return next;
}

export function toggleSweepSelection(
  selection: ReadonlySet<string>,
  id: string,
  checked: boolean,
): Set<string> {
  const next = new Set(selection);
  if (checked) next.add(id);
  else next.delete(id);
  return next;
}

/** Split ticked rows into the two applySweep close channels. */
export function splitSweepSelection(
  selection: ReadonlySet<string>,
  rows: readonly SweepRow[],
): { deadIds: string[]; candidateIds: string[] } {
  const deadIds: string[] = [];
  const candidateIds: string[] = [];
  for (const row of rows) {
    if (!row.selectable || !selection.has(row.tab.id)) continue;
    if (row.kind === "DEAD") deadIds.push(row.tab.id);
    else candidateIds.push(row.tab.id);
  }
  return { deadIds, candidateIds };
}

export function formatSweepCompletion(base: string, result: SweepApplyResult): string {
  const details: string[] = [];
  if (result.skipped.length > 0) details.push(`${result.skipped.length}件は状態が変わったため見送りました`);
  if (result.errors.length > 0) details.push(`${result.errors.length}件は処理できませんでした`);
  return details.length > 0 ? `${base}（${details.join("、")}）` : base;
}

/**
 * Footer note telling the user what actually gets sent, and to which AI. The
 * model is a user setting now, so this cannot be a fixed string.
 */
export function formatSweepAiNote(
  kind: "judge" | "naming",
  provider: AiProviderId,
  model: string,
  enabled: boolean,
): string {
  if (!enabled) return aiSettingsStrings.disabledReason;
  const target = `${aiProviderDef(provider).label} (${model})`;
  return kind === "judge"
    ? `各タブの画面末尾${TAB_SWEEP_TAIL_LINES}行と作業フォルダを ${target} に送って判定します（チェックの提案のみ）`
    : `名前のないタブの画面末尾${TAB_NAMING_TAIL_LINES}行・作業フォルダ・ペイン構成を ${target} に送って名前を付けます（自動で適用・元に戻せます）`;
}

export function formatJudgeError(error: unknown, provider: AiProviderId): JudgeErrorPresentation {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : null;
  const code = typeof record?.code === "string" ? record.code : "";
  const raw = typeof record?.detail === "string"
    ? record.detail
    : error instanceof Error ? error.message : String(error);
  const normalized = `${code} ${raw}`.toLowerCase();
  if (code === "ai_disabled" || normalized.includes("ai_disabled")) {
    return { summary: `${aiSettingsStrings.disabledReason}。`, raw };
  }
  if (code === "timeout" || normalized.includes("timed out")) {
    return { summary: "判定が時間切れになりました。もう一度実行してください。", raw };
  }
  if (code === "cli_not_found" || normalized.includes("not found") || normalized.includes("os error 2")) {
    const def = aiProviderDef(provider);
    return {
      summary: `判定に使うツールが見つかりません。${def.label} (${def.cli}) のインストールを確認してください。`,
      raw,
    };
  }
  if (code === "cli_failed" || normalized.includes("exited with")) {
    return { summary: "判定ツールがエラー終了しました。詳細を確認して再実行してください。", raw };
  }
  if (code === "cancelled" || normalized.includes("cancel")) {
    return { summary: "判定を中止しました。必要なら再実行してください。", raw };
  }
  return { summary: "判定に失敗しました。詳細を確認して再実行してください。", raw };
}

export async function readTail(sessionId: string, lines: number): Promise<string[]> {
  return readPaneTail(sessionId, lines);
}

async function loadDefaultSource(now = Date.now()): Promise<SweepScanSource> {
  const [stores, ipc, terminalCache] = await Promise.all([
    import("../../stores/workspaceStore"),
    import("../../lib/ipc"),
    import("../terminal/terminalCache"),
  ]);
  let processMetadata: PtyMetadataSnapshot = {};
  let processMetadataAvailable = true;
  try {
    processMetadata = await ipc.getPtyMetadataSnapshot();
  } catch {
    processMetadataAvailable = false;
  }
  let lastOutputBySession: SessionOutputSnapshot = {};
  try {
    lastOutputBySession = await ipc.getSessionOutputSnapshot();
  } catch {
    // Absence of an activity timestamp does not make a live tab recent.
  }
  const workspaceState = stores.useWorkspaceListStore.getState();
  return {
    workspaces: workspaceState.workspaces,
    activeWorkspaceId: workspaceState.activeWorkspaceId,
    activeSessionId: stores.useUiStore.getState().activePaneId,
    metadata: stores.usePaneMetadataStore.getState().metadata,
    processMetadata,
    processMetadataAvailable,
    lastOutputBySession,
    isScreenObserved: (sessionId) => terminalCache.liveTerms.has(sessionId),
    readTail,
    now,
  };
}

export async function scanTabs(
  providedSource?: SweepScanSource,
  requestedTabIds?: ReadonlySet<string>,
): Promise<SweepReport> {
  const source = providedSource ?? await loadDefaultSource();
  const tabs: SweepTab[] = [];

  for (const workspace of source.workspaces) {
    for (const pane of workspace.panes) {
      const displayedTabId = pane.tabs.some((tab) => tab.id === pane.activeTabId)
        ? pane.activeTabId
        : pane.tabs[0]?.id;
      for (const tab of pane.tabs) {
        if (requestedTabIds && !requestedTabIds.has(tab.id)) continue;
        const processStatusReason = processStatusReasonForTab(
          tab.type,
          source.processMetadata[tab.sessionId],
          source.processMetadataAvailable,
        );
        const base = {
          id: tab.id,
          sessionId: tab.sessionId,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          paneId: pane.id,
          label: tab.label,
          cwd: tab.cwd ?? pane.cwd,
          unnamed: !tab.label?.trim(),
          processStatusReason,
          lastOutputAt: source.lastOutputBySession[tab.sessionId] ?? null,
        };

        if (isTerminalTab(tab) && isDeadReason(processStatusReason)) {
          tabs.push({
            ...base,
            category: "DEAD",
            lockReasons: [],
            unnamed: false,
            tail: [],
          });
          continue;
        }

        const lockReasons: SweepLockReason[] = [];
        const screenObserved = source.isScreenObserved(tab.sessionId);
        const displayed = workspace.id === source.activeWorkspaceId && tab.id === displayedTabId;
        if (displayed || screenObserved || source.activeSessionId === tab.sessionId) {
          lockReasons.push("active");
        }
        const lastOutputAt = base.lastOutputAt;
        if (lastOutputAt !== null && source.now - lastOutputAt <= TAB_SWEEP_IDLE_MS) {
          lockReasons.push("recent_output");
        }
        const metadata = source.metadata[tab.sessionId];
        if (metadata?.agentStatus === "working" && screenObserved) {
          lockReasons.push("working");
        }

        let tail: string[] = [];
        if (!isTerminalTab(tab)) {
          lockReasons.push("unsupported_tab");
        } else {
          try {
            tail = await source.readTail(tab.sessionId, TAB_SWEEP_TAIL_LINES);
            if (hasQueuedInput(tail)) {
              lockReasons.push("queued_input");
            } else if (!hasIdlePrompt(tail)) {
              lockReasons.push("not_at_prompt");
            }
          } catch {
            lockReasons.push("buffer_unavailable");
          }
        }
        tabs.push({
          ...base,
          category: lockReasons.length > 0 ? "LOCKED" : "CANDIDATE",
          lockReasons,
          tail,
        });
      }
    }
  }

  return {
    scannedAt: source.now,
    tabs,
    dead: tabs.filter((tab) => tab.category === "DEAD"),
    locked: tabs.filter((tab) => tab.category === "LOCKED"),
    candidates: tabs.filter((tab) => tab.category === "CANDIDATE"),
    unnamed: tabs.filter((tab) => tab.category !== "DEAD" && tab.unnamed),
  };
}

/**
 * Collect every live terminal in the visible workspace, including tabs the
 * sweep safety classifier would lock. Naming is a read-only proposal step, so
 * it intentionally does not inherit the close-path eligibility rules.
 */
export async function scanNamingContext(): Promise<NamingPaneGroup[]> {
  const source = await loadDefaultSource();
  const workspace = source.workspaces.find((item) => item.id === source.activeWorkspaceId);
  if (!workspace) return [];

  const paneById = new Map(workspace.panes.map((pane) => [pane.id, pane]));
  const columns = reconcileSplitColumnsForPanes(
    workspace.splitColumns,
    workspace.panes.map((pane) => pane.id),
  );
  const groups: NamingPaneGroup[] = [];

  for (const [columnIndex, paneIds] of columns.entries()) {
    for (const paneId of paneIds) {
      const pane = paneById.get(paneId);
      if (!pane) continue;
      const displayedTabId = pane.tabs.some((tab) => tab.id === pane.activeTabId)
        ? pane.activeTabId
        : pane.tabs[0]?.id;
      const tabs: NamingTab[] = [];
      for (const tab of pane.tabs) {
        if (!isTerminalTab(tab)) continue;
        const reason = processStatusReasonForTab(
          tab.type,
          source.processMetadata[tab.sessionId],
          source.processMetadataAvailable,
        );
        if (isDeadReason(reason)) continue;
        let tail: string[] = [];
        try {
          tail = await source.readTail(tab.sessionId, TAB_NAMING_TAIL_LINES);
        } catch {
          // A missing buffer must not hide a still-live tab from the naming model.
        }
        const metadata = source.metadata[tab.sessionId];
        tabs.push({
          id: tab.id,
          sessionId: tab.sessionId,
          label: tab.label ?? "",
          labelSource: tab.labelSource,
          cwd: tab.cwd ?? pane.cwd ?? metadata?.cwd ?? "",
          agentKind: tab.agentKind ?? pane.agentKind ?? metadata?.agentKind ?? "",
          isPaneHead: tab.id === displayedTabId,
          tail,
        });
      }
      if (tabs.length > 0) groups.push({ paneId, column: columnIndex + 1, tabs });
    }
  }
  return groups;
}

export function buildJudgePrompt(candidates: readonly SweepTab[], unnamed: readonly SweepTab[]): string {
  const uniqueTabs = new Map<string, SweepTab>();
  for (const tab of [...candidates, ...unnamed]) uniqueTabs.set(tab.id, tab);
  const payload = [...uniqueTabs.values()].map((tab) => ({
    id: tab.id,
    label: tab.label ?? "",
    cwd: tab.cwd ?? "",
    tail: tab.tail.slice(-TAB_SWEEP_TAIL_LINES),
  }));
  return [
    "次のタブを判定してください。",
    "verdict は done_waiting（完了してプロンプト待機）、queued_input（未送信指示あり）、working（作業継続中）、unknown のいずれかです。",
    "label が空のタブには cwd と tail から12文字以内の日本語ラベル案を付けてください（日本語基本。mycmux などの固有名詞はアルファベット可、一般語は日本語で）。",
    "出力は JSON 配列のみ。前後の説明文やコードフェンスは禁止です。",
    '[{"id":"...","verdict":"done_waiting|queued_input|working|unknown","label":"..."}]',
    JSON.stringify(payload),
  ].join("\n");
}

export function buildNamingPrompt(groups: readonly NamingPaneGroup[]): string {
  const payload = groups.map((group) => ({
    ...group,
    tabs: group.tabs.map((tab) => ({ ...tab, tail: tab.tail.slice(-TAB_NAMING_TAIL_LINES) })),
  }));
  return [
    "次のワークスペース内の全タブに体系的な名前を提案してください。",
    "ラベルは日本語を基本にしてください。mycmux のようなプロジェクト名・製品名・ツール名の固有名詞はアルファベットのままで構いません。一般語のアルファベット（fix / build / review など）は日本語に置き換えてください。",
    "フォルダ名やコマンド名をそのまま写さず、作業内容を短い日本語に要約してください。短いほど良く、目安は12文字までです。",
    "ペイン見出し（isPaneHead が true）は「領域 内容」の形にし、全角20文字以内にしてください。",
    "同じ領域に属する別ペインは先頭語（領域）を共有してください。",
    "従属タブ（isPaneHead が false）は「↳実行者 対象」の形にしてください。実行者は tail と作業フォルダから codex / claude / 合成 などを判断してください。",
    "記号 + ＋ ' ` \" < > は使わないでください。",
    "出力は JSON 配列のみです。コードフェンスや説明文は禁止です。形式は [{\"id\":\"...\",\"label\":\"...\"}] です。",
    "全タブに対して必ず1件ずつ返してください。",
    JSON.stringify(payload),
  ].join("\n");
}

export function normalizeSuggestedLabel(value: unknown, maxLength = 12): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/[+＋'`"<>]/gu, "").trim();
  if (!trimmed) return undefined;
  return [...trimmed].slice(0, maxLength).join("");
}

export function parseNamingOutput(raw: string, allowedIds: Iterable<string>): NamingParseResult {
  const knownIds = [...new Set(allowedIds)];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return { proposals: [], valid: false };
  }
  if (!Array.isArray(parsed)) return { proposals: [], valid: false };

  const allowed = new Set(knownIds);
  const proposals = new Map<string, NamingProposal>();
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") return { proposals: [], valid: false };
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || !record.id.trim()) return { proposals: [], valid: false };
    const id = record.id.trim();
    if (!allowed.has(id) || proposals.has(id)) continue;
    const label = normalizeSuggestedLabel(record.label, TAB_NAMING_LABEL_MAX);
    if (!label) return { proposals: [], valid: false };
    proposals.set(id, { id, label });
  }
  return {
    proposals: [...proposals.values()],
    valid: knownIds.every((id) => proposals.has(id)),
  };
}

function isJudgeVerdict(value: unknown): value is JudgeVerdict {
  return value === "done_waiting"
    || value === "queued_input"
    || value === "working"
    || value === "unknown";
}

export function parseJudgeOutput(raw: string, allowedIds?: Iterable<string>): Verdict[] {
  const knownIds = allowedIds ? [...new Set(allowedIds)] : null;
  const fallback = () => knownIds?.map((id) => ({ id, verdict: "unknown" as const })) ?? [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return fallback();
  }
  if (!Array.isArray(parsed)) return fallback();

  const allowed = knownIds ? new Set(knownIds) : null;
  const verdicts = new Map<string, Verdict>();
  const duplicateIds = new Set<string>();
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || !record.id.trim()) continue;
    const id = record.id.trim();
    if (allowed && !allowed.has(id)) continue;
    if (verdicts.has(id)) {
      duplicateIds.add(id);
      continue;
    }
    verdicts.set(id, {
      id,
      verdict: isJudgeVerdict(record.verdict) ? record.verdict : "unknown",
      ...(normalizeSuggestedLabel(record.label) ? { label: normalizeSuggestedLabel(record.label) } : {}),
    });
  }
  for (const id of duplicateIds) verdicts.set(id, { id, verdict: "unknown" });
  if (!knownIds) return [...verdicts.values()];
  return knownIds.map((id) => verdicts.get(id) ?? { id, verdict: "unknown" });
}

export function parseJudgeOutputResult(raw: string, allowedIds: Iterable<string>): JudgeParseResult {
  const knownIds = [...new Set(allowedIds)];
  const verdicts = parseJudgeOutput(raw, knownIds);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return { verdicts, valid: false };
  }
  if (!Array.isArray(parsed)) return { verdicts, valid: false };
  const allowed = new Set(knownIds);
  const seen = new Set<string>();
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") return { verdicts, valid: false };
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || !allowed.has(record.id.trim())) return { verdicts, valid: false };
    const id = record.id.trim();
    if (seen.has(id) || !isJudgeVerdict(record.verdict)) return { verdicts, valid: false };
    seen.add(id);
  }
  return { verdicts, valid: knownIds.every((id) => seen.has(id)) };
}

const defaultApplyDependencies: SweepApplyDependencies = {
  scan: (id) => scanTabs(undefined, id ? new Set([id]) : undefined),
  command: (cmd, args) => handleSocketCommand(cmd, args),
};

export async function applySweep(
  plan: SweepPlan,
  dependencies: SweepApplyDependencies = defaultApplyDependencies,
): Promise<SweepApplyResult> {
  const result: SweepApplyResult = { closed: 0, renamed: 0, skipped: [], errors: [] };
  const verdictById = new Map((plan.verdicts ?? []).map((verdict) => [verdict.id, verdict]));

  const currentTab = async (id: string) => {
    const report = await dependencies.scan(id);
    return report.tabs.find((tab) => tab.id === id);
  };
  const sameCloseSafetyState = (first: SweepTab, second: SweepTab): boolean => (
    first.id === second.id
    && first.sessionId === second.sessionId
    && first.category === second.category
    && first.lastOutputAt === second.lastOutputAt
    && first.processStatusReason === second.processStatusReason
    && JSON.stringify(first.tail) === JSON.stringify(second.tail)
  );
  const close = async (id: string, requiredCategory: "DEAD" | "CANDIDATE") => {
    const current = await currentTab(id);
    if (!current || current.category !== requiredCategory) {
      result.skipped.push(id);
      return;
    }
    const verified = await currentTab(id);
    if (!verified
      || verified.category !== requiredCategory
      || !sameCloseSafetyState(current, verified)) {
      result.skipped.push(id);
      return;
    }
    try {
      await dependencies.command("pane.close_tab", { sessionId: verified.sessionId });
      result.closed += 1;
    } catch (error) {
      result.errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  for (const id of plan.closeDeadTabIds ?? []) await close(id, "DEAD");
  for (const id of plan.manualCloseCandidateTabIds ?? []) await close(id, "CANDIDATE");
  for (const id of plan.closeCandidateTabIds ?? []) {
    if (verdictById.get(id)?.verdict !== "done_waiting") {
      result.skipped.push(id);
      continue;
    }
    await close(id, "CANDIDATE");
  }
  for (const rename of plan.renames ?? []) {
    const current = await currentTab(rename.id);
    // An overwrite is also the undo path. Unlike an AI proposal, it may need
    // to restore an originally blank label.
    const label = rename.overwrite === true && rename.label.trim().length === 0
      ? ""
      : normalizeSuggestedLabel(rename.label, rename.overwrite === true ? TAB_NAMING_LABEL_MAX : 12);
    if (!current || current.category === "DEAD" || (!rename.overwrite && !current.unnamed) || label === undefined) {
      result.skipped.push(rename.id);
      continue;
    }
    try {
      await dependencies.command("pane.rename_tab", { sessionId: current.sessionId, label });
      result.renamed += 1;
    } catch (error) {
      result.errors.push(`${rename.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}
