import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import Fuse from "fuse.js";
import {
  crsmCreateHandoff,
  crsmListSessions,
  type CrsmSessionEntry,
} from "../../lib/ipc";
import {
  usePaneMetadataStore,
  useUiStore,
  useWorkspaceLayoutStore,
} from "../../stores/workspaceStore";
import { useWorkspaceListStore } from "../../stores/workspaceListStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { OVERLAY_EXIT_MS, useDeferredUnmount } from "../../hooks/useDeferredUnmount";
import { DocumentIcon, PencilIcon, TaskIcon } from "../icons/ChromeIcons";
import "./CrsmPalette.css";

interface CrsmPaletteProps {
  open: boolean;
  onClose: () => void;
}

type TargetKind = CrsmSessionEntry["kind"];
type OpenTargetKind = TargetKind;
type SessionFilterKind = "all" | TargetKind;

const OPEN_TARGETS: OpenTargetKind[] = ["claude", "codex", "claude-codex"];
const SESSION_FETCH_LIMIT_INITIAL = 1000;
const SESSION_FETCH_LIMIT_DEEP = 10000;
const MAX_LISTED_SESSIONS_INITIAL = 1000;
const MAX_LISTED_SESSIONS_DEEP = 10000;
const ITEM_HEIGHT = 48;
const LOAD_MORE_HEIGHT = 38;
const TOP_CWD_CHIPS = 8;
const SESSION_AUTO_REFRESH_COOLDOWN_MS = 10_000;
const DIRECT_RESUME_FAST_CACHE_MS = 60_000;
const STR_LOADING_SESSIONS = "\u5c65\u6b74\u3092\u8aad\u307f\u8fbc\u307f\u4e2d\u2026";
const STR_DEEP_SEARCH_CTA = "\u904e\u53bb\u5206\u3082\u8aad\u307f\u8fbc\u3093\u3067\u691c\u7d22";

export type CrsmEscapeAction = "clear-query" | "close";
export type CrsmPageJumpKey = "PageUp" | "PageDown" | "Home" | "End";

export function resolveCrsmEscapeAction(query: string): CrsmEscapeAction {
  return query.length > 0 ? "clear-query" : "close";
}

export function pageJumpIndex(
  currentIndex: number,
  key: CrsmPageJumpKey,
  itemCount: number,
  viewportHeight: number,
  itemHeight = ITEM_HEIGHT,
): number {
  const lastIndex = Math.max(itemCount - 1, 0);
  if (key === "Home") return 0;
  if (key === "End") return lastIndex;
  const pageSize = Math.max(1, Math.floor(viewportHeight / itemHeight));
  const nextIndex = currentIndex + (key === "PageDown" ? pageSize : -pageSize);
  return Math.min(Math.max(nextIndex, 0), lastIndex);
}

export function sortSessionsByLastActivity<
  T extends { last_activity: string | null | undefined },
>(sessions: readonly T[]): T[] {
  return [...sessions].sort((a, b) => {
    const ta = Date.parse(a.last_activity ?? "") || 0;
    const tb = Date.parse(b.last_activity ?? "") || 0;
    return tb - ta;
  });
}

function highlightedLabel(
  labelValue: string | null,
  ranges: readonly (readonly [number, number])[] | undefined,
): ReactNode {
  const label = labelValue ?? "";
  if (!ranges?.length) return label;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) {
      parts.push(<span key={`plain-${cursor}`}>{label.slice(cursor, start)}</span>);
    }
    parts.push(
      <span key={`match-${start}`} className="cmux-match">
        {label.slice(start, end + 1)}
      </span>,
    );
    cursor = end + 1;
  }
  if (cursor < label.length) {
    parts.push(<span key={`plain-${cursor}`}>{label.slice(cursor)}</span>);
  }
  return <>{parts}</>;
}

const SOURCE_LABELS: Record<string, string> = {
  "claude-live": "live",
  "claude-index": "archive",
  "codex-jsonl": "codex",
  "claude-codex-jsonl": "hybrid",
};

function sourceShort(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

interface PreviewTurn {
  role: "user" | "assistant" | "other";
  text: string;
}

function splitPreviewTurns(preview: string): PreviewTurn[] {
  if (!preview) return [];
  const parts = preview.split(/\n(?=(?:user|assistant): )/);
  const out: PreviewTurn[] = [];
  for (const raw of parts) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(user|assistant): ([\s\S]*)$/);
    if (m) {
      out.push({ role: m[1] as "user" | "assistant", text: m[2].trim() });
    } else {
      out.push({ role: "other", text: trimmed });
    }
  }
  return out;
}

const KIND_COLORS: Record<TargetKind, { fg: string; bg: string }> = {
  "claude": { fg: "#f0a878", bg: "rgba(255, 138, 61, 0.10)" },
  "codex": { fg: "#8ab8e8", bg: "rgba(94, 158, 255, 0.10)" },
  "claude-codex": { fg: "#7dcc97", bg: "rgba(74, 222, 128, 0.10)" },
};
const LIST_OVERSCAN = 6;
const LIST_VIEWPORT_FALLBACK = 420;
const HANDOFF_TIMEOUT_MS = 9000;
const SESSION_VALIDATE_LIMIT = 50;
const SESSION_VALIDATE_TIMEOUT_MS = 6000;
const SESSION_FILTER_LABELS: Record<SessionFilterKind, string> = {
  "all": "すべて",
  "claude": "Claude Code",
  "codex": "Codex",
  "claude-codex": "Hybrid",
};

function defaultTargetFor(kind: TargetKind | undefined): OpenTargetKind {
  return kind ?? "claude";
}

function agentTitle(kind: OpenTargetKind): string {
  if (kind === "claude") return "Claude Code";
  if (kind === "codex") return "Codex";
  return "Claude Codex Hybrid";
}

function agentBadge(kind: TargetKind): string {
  if (kind === "claude") return "Claude";
  if (kind === "codex") return "Codex";
  return "Hybrid";
}

function agentSubtitle(session: CrsmSessionEntry | undefined, target: OpenTargetKind): string {
  if (!session) return `${agentBadge(target)}で開く`;
  if (session.kind === target) return `${agentBadge(target)}履歴を復帰`;
  return `${agentBadge(session.kind)}履歴を引き継ぎ`;
}

function targetSummary(session: CrsmSessionEntry | undefined, target: OpenTargetKind): string {
  if (!session) return "";
  if (session.kind === target) return `${agentTitle(target)}でそのまま復帰`;
  return `${agentTitle(target)}へ引き継ぎ`;
}

function shortenCwd(cwd: string): string {
  if (!cwd) return "";
  const homeWin = "C:\\Users\\miyaz";
  const homePosix = "/c/Users/miyaz";
  let path = cwd;
  if (path === homeWin || path === homePosix) return "~";
  if (path.startsWith(homeWin + "\\")) {
    path = path.slice(homeWin.length + 1);
  } else if (path.startsWith(homePosix + "/")) {
    path = path.slice(homePosix.length + 1);
  } else {
    const seg = path.split(/[\\/]/);
    return seg[seg.length - 1] || cwd;
  }
  const parts = path.split(/[\\/]/);
  if (parts.length <= 2) return parts.join("/");
  return ".../" + parts.slice(-2).join("/");
}

function normalizeCwdKey(cwd: string | null | undefined): string {
  if (!cwd) return "";
  let path = cwd.trim().replace(/\\/g, "/");
  const gitBashDrive = path.match(/^\/([a-zA-Z])\/(.*)$/);
  if (gitBashDrive) {
    path = `${gitBashDrive[1]}:/${gitBashDrive[2]}`;
  }
  path = path.replace(/\/+/g, "/").replace(/\/$/, "");
  return path.toLowerCase();
}

function formatDuration(startIso: string | null | undefined, endIso: string): string {
  if (!startIso) return "";
  const s = Date.parse(startIso);
  const e = Date.parse(endIso);
  if (Number.isNaN(s) || Number.isNaN(e)) return "";
  const ms = Math.max(0, e - s);
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  if (days > 0) return `${days}d${hours}h${mins}m`;
  if (hours > 0) return `${hours}h${mins}m`;
  if (mins > 0) return `${mins}m`;
  return `${totalSec}s`;
}

function shortenPath(p: string, maxLen = 60): string {
  if (!p) return "";
  if (p.length <= maxLen) return p;
  return "..." + p.slice(p.length - (maxLen - 3));
}

function formatStamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const sameDay = sameYear && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (sameDay) return `${hh}:${mm}`;
  if (sameYear) return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const ms = Date.now() - t;
  if (ms < 0) return "now";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}時間前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day}日前`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month}ヶ月前`;
  const year = Math.floor(day / 365);
  return `${year}年前`;
}

let cachedCrsmSessions: CrsmSessionEntry[] | null = null;
let cachedCrsmSessionsError: string | null = null;
let cachedCrsmSessionsIsDeep = false;
let cachedCrsmSessionsFetchedAt = 0;
let cachedCrsmSessionsRefreshedAt = 0;
const crsmSessionsRequests = new Map<string, Promise<CrsmSessionEntry[]>>();

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

function crsmRequestKey(deep: boolean, refresh: boolean): string {
  return `${refresh ? "refresh" : "cache"}:${deep ? "deep" : "initial"}`;
}

function storeCrsmSessions(nextSessions: CrsmSessionEntry[], deep: boolean, refresh: boolean): void {
  cachedCrsmSessions = nextSessions;
  cachedCrsmSessionsError = null;
  cachedCrsmSessionsIsDeep = deep;
  cachedCrsmSessionsFetchedAt = Date.now();
  if (refresh) {
    cachedCrsmSessionsRefreshedAt = cachedCrsmSessionsFetchedAt;
  }
}

function upsertCrsmSession(
  sessions: CrsmSessionEntry[],
  nextSession: CrsmSessionEntry,
): CrsmSessionEntry[] {
  const index = sessions.findIndex((session) =>
    session.kind === nextSession.kind && session.id === nextSession.id,
  );
  if (index === -1) return [nextSession, ...sessions];
  const nextSessions = [...sessions];
  nextSessions[index] = nextSession;
  return nextSessions;
}

function exactCrsmSessionMatch(
  sessions: CrsmSessionEntry[],
  target: CrsmSessionEntry,
): CrsmSessionEntry | undefined {
  return sessions.find((session) => session.kind === target.kind && session.id === target.id);
}

function directResumeUnavailableMessage(session: CrsmSessionEntry): string | null {
  if (session.kind === "claude" && !session.transcript_path) {
    return "この Claude 履歴は要約だけで、直接 Resume できる実体ファイルがありません。別の履歴を選ぶか、別エージェントへの引き継ぎを使ってください。";
  }
  return null;
}

function isSummaryOnlyClaudeSession(session: CrsmSessionEntry): boolean {
  return session.kind === "claude" && !session.transcript_path && Boolean(session.summary_file);
}

function sessionKey(session: CrsmSessionEntry | undefined): string | null {
  return session ? `${session.kind}:${session.id}` : null;
}

function canFastDirectResume(session: CrsmSessionEntry): boolean {
  return Boolean(
    session.transcript_path
      && cachedCrsmSessionsFetchedAt > 0
      && Date.now() - cachedCrsmSessionsFetchedAt <= DIRECT_RESUME_FAST_CACHE_MS,
  );
}

async function resolveDirectResumeSession(selected: CrsmSessionEntry): Promise<CrsmSessionEntry> {
  const selectedUnavailable = directResumeUnavailableMessage(selected);
  if (selectedUnavailable) {
    throw new Error(selectedUnavailable);
  }

  let exact: CrsmSessionEntry | undefined;
  try {
    const refreshed = await withTimeout(
      crsmListSessions(selected.id, SESSION_VALIDATE_LIMIT, false),
      SESSION_VALIDATE_TIMEOUT_MS,
      "CRSM session lookup",
    );
    exact = exactCrsmSessionMatch(refreshed, selected);
    if (!exact) {
      cachedCrsmSessionsError = "CRSM session lookup did not return the selected session";
      return selected;
    }
  } catch (error) {
    cachedCrsmSessionsError = error instanceof Error ? error.message : String(error);
    return selected;
  }

  const exactUnavailable = directResumeUnavailableMessage(exact);
  if (exactUnavailable) {
    throw new Error(exactUnavailable);
  }

  cachedCrsmSessions = cachedCrsmSessions ? upsertCrsmSession(cachedCrsmSessions, exact) : cachedCrsmSessions;
  return exact;
}

function fetchCrsmSessions(deep = false, refresh = false): Promise<CrsmSessionEntry[]> {
  if (!refresh && !deep && cachedCrsmSessionsIsDeep && cachedCrsmSessions) {
    return Promise.resolve(cachedCrsmSessions);
  }
  const key = crsmRequestKey(deep, refresh);
  let request = crsmSessionsRequests.get(key);
  if (!request) {
    const limit = deep ? SESSION_FETCH_LIMIT_DEEP : SESSION_FETCH_LIMIT_INITIAL;
    request = crsmListSessions(undefined, limit, refresh)
      .then((nextSessions) => {
        storeCrsmSessions(nextSessions, deep, refresh);
        return nextSessions;
      })
      .catch((error) => {
        if (cachedCrsmSessions) {
          cachedCrsmSessionsError = String(error);
          return cachedCrsmSessions;
        }
        throw error;
      })
      .finally(() => {
        crsmSessionsRequests.delete(key);
      });
    crsmSessionsRequests.set(key, request);
  }
  return request;
}

export function autoRefreshCrsmSessions(deep = false): Promise<CrsmSessionEntry[]> {
  const elapsed = Date.now() - cachedCrsmSessionsRefreshedAt;
  if (cachedCrsmSessions && elapsed < SESSION_AUTO_REFRESH_COOLDOWN_MS) {
    return Promise.resolve(cachedCrsmSessions);
  }
  return fetchCrsmSessions(deep, true);
}

export function preloadCrsmSessions(): void {
  if (cachedCrsmSessions || crsmSessionsRequests.size > 0 || typeof window === "undefined") return;
  const start = () => {
    void fetchCrsmSessions()
      .then(() => autoRefreshCrsmSessions().catch(() => undefined))
      .catch(() => undefined);
  };
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(start, { timeout: 2500 });
  } else {
    window.setTimeout(start, 900);
  }
}

export default function CrsmPalette({ open, onClose }: CrsmPaletteProps) {
  const { mounted, closing } = useDeferredUnmount(open, OVERLAY_EXIT_MS);
  const [sessions, setSessions] = useState<CrsmSessionEntry[]>([]);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [targetKind, setTargetKind] = useState<OpenTargetKind>("claude");
  const [targetPinned, setTargetPinned] = useState(false);
  const [sessionFilter, setSessionFilter] = useState<SessionFilterKind>("all");
  const [error, setError] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [listViewportHeight, setListViewportHeight] = useState(LIST_VIEWPORT_FALLBACK);
  const [deepLoaded, setDeepLoaded] = useState<boolean>(cachedCrsmSessionsIsDeep);
  const [loadingMore, setLoadingMore] = useState(false);
  const [cwdFilters, setCwdFilters] = useState<string[]>([]);
  const [showAllCwds, setShowAllCwds] = useState(false);
  const [summaryOnlyConfirmKey, setSummaryOnlyConfirmKey] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const requestIdRef = useRef(0);
  const selectedKeyRef = useRef<string | null>(null);
  const pendingSelectionKeyRef = useRef<string | null>(null);
  const cwdFilterTouchedRef = useRef(false);
  const cwdFilterAutoAppliedRef = useRef(false);
  const activeWorkspace = useWorkspaceListStore((s) => s.getActiveWorkspace());
  const activePaneId = useUiStore((s) => s.activePaneId);
  const activePaneMetadataCwd = usePaneMetadataStore((s) =>
    activePaneId ? s.metadata[activePaneId]?.cwd : undefined,
  );
  const addPaneToWorkspaceWithOptions = useWorkspaceLayoutStore((s) => s.addPaneToWorkspaceWithOptions);

  // Per-kind visibility from Settings (right-side gear menu). When the
  // user disables a kind, that kind disappears from both the session
  // list and the filter chips.
  const showClaude = useSettingsStore((s) => s.crsmShowClaude);
  const showCodex = useSettingsStore((s) => s.crsmShowCodex);
  const showClaudeCodex = useSettingsStore((s) => s.crsmShowClaudeCodex);
  const hideSessionsWithoutUserMessages = useSettingsStore(
    (s) => s.hideSessionsWithoutUserMessages,
  );
  const enabledKinds = useMemo(() => {
    const set = new Set<TargetKind>();
    if (showClaude) set.add("claude");
    if (showCodex) set.add("codex");
    if (showClaudeCodex) set.add("claude-codex");
    return set;
  }, [showClaude, showCodex, showClaudeCodex]);
  const sessionFilters = useMemo<Array<[SessionFilterKind, string]>>(() => {
    const filters: Array<[SessionFilterKind, string]> = [["all", SESSION_FILTER_LABELS.all]];
    for (const kind of OPEN_TARGETS) {
      if (enabledKinds.has(kind)) {
        filters.push([kind, SESSION_FILTER_LABELS[kind]]);
      }
    }
    return filters;
  }, [enabledKinds]);
  // The 引き継ぎ先 (handoff target) row in the palette must mirror the
  // Settings toggles too — kinds the user disabled there should not be
  // an option to hand off into.
  const enabledTargets = useMemo<OpenTargetKind[]>(
    () => OPEN_TARGETS.filter((kind) => enabledKinds.has(kind)),
    [enabledKinds],
  );

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSelectedIndex(0);
    setScrollTop(0);
    setTargetPinned(false);
    setSessionFilter("all");
    setCwdFilters([]);
    setShowAllCwds(false);
    setSummaryOnlyConfirmKey(null);
    selectedKeyRef.current = null;
    pendingSelectionKeyRef.current = null;
    cwdFilterTouchedRef.current = false;
    cwdFilterAutoAppliedRef.current = false;
    if (listRef.current) {
      listRef.current.scrollTop = 0;
    }
    if (cachedCrsmSessions) {
      setSessions(cachedCrsmSessions);
      setDeepLoaded(cachedCrsmSessionsIsDeep);
    }
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const applySessions = (nextSessions: CrsmSessionEntry[]) => {
      pendingSelectionKeyRef.current = selectedKeyRef.current;
      setSessions(nextSessions);
      setDeepLoaded(cachedCrsmSessionsIsDeep);
      setError(cachedCrsmSessionsError ? `CRSM cache fallback: ${cachedCrsmSessionsError}` : null);
    };
    fetchCrsmSessions()
      .then((nextSessions) => {
        if (requestIdRef.current !== requestId) return undefined;
        applySessions(nextSessions);
        return autoRefreshCrsmSessions(cachedCrsmSessionsIsDeep);
      })
      .then((nextSessions) => {
        if (!nextSessions || requestIdRef.current !== requestId) return;
        applySessions(nextSessions);
      })
      .catch((err) => {
        if (requestIdRef.current !== requestId) return;
        setError(String(err));
      });
    return () => {
      requestIdRef.current += 1;
    };
  }, [open]);

  // If the active filter chip points at a kind the user has just disabled
  // in Settings, fall back to "all" so the palette is never stuck on an
  // empty filter the user can no longer clear.
  useEffect(() => {
    if (sessionFilter !== "all" && !enabledKinds.has(sessionFilter)) {
      setSessionFilter("all");
    }
  }, [enabledKinds, sessionFilter]);

  // Same idea for the 引き継ぎ先 selection: if the currently-pinned
  // target kind is no longer enabled in Settings, snap to the first
  // remaining enabled target so the user is never stuck pointing at a
  // hidden option.
  useEffect(() => {
    if (enabledTargets.length === 0) return;
    if (!enabledTargets.includes(targetKind)) {
      setTargetKind(enabledTargets[0]);
    }
  }, [enabledTargets, targetKind]);

  const activePaneCwd = useMemo(() => {
    if (!activeWorkspace) return activePaneMetadataCwd;
    const pane = activeWorkspace.panes.find((candidate) =>
      candidate.sessionId === activePaneId || candidate.tabs.some((tab) => tab.sessionId === activePaneId),
    );
    const activeTab = pane?.tabs.find((tab) => tab.id === pane.activeTabId)
      ?? pane?.tabs.find((tab) => tab.sessionId === activePaneId)
      ?? pane?.tabs[0];
    return activePaneMetadataCwd ?? activeTab?.cwd ?? pane?.cwd;
  }, [activePaneId, activePaneMetadataCwd, activeWorkspace]);

  const filteredByAgent = useMemo(() => {
    const visible = sessions.filter((session) => enabledKinds.has(session.kind));
    if (sessionFilter === "all") return visible;
    return visible.filter((session) => session.kind === sessionFilter);
  }, [sessionFilter, sessions, enabledKinds]);

  const filteredByUserMsg = useMemo(() => {
    if (!hideSessionsWithoutUserMessages) return filteredByAgent;
    return filteredByAgent.filter((s) => s.has_user_messages !== false);
  }, [filteredByAgent, hideSessionsWithoutUserMessages]);

  const cwdCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of filteredByUserMsg) {
      map.set(s.cwd, (map.get(s.cwd) ?? 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [filteredByUserMsg]);

  const cwdCountsForDisplay = useMemo(() => {
    const activeKey = normalizeCwdKey(activePaneCwd);
    if (!activeKey) return cwdCounts;
    const activeIndex = cwdCounts.findIndex(([cwd]) => normalizeCwdKey(cwd) === activeKey);
    if (activeIndex <= 0) return cwdCounts;
    const next = [...cwdCounts];
    const [active] = next.splice(activeIndex, 1);
    return [active, ...next];
  }, [activePaneCwd, cwdCounts]);

  useEffect(() => {
    if (!open || cwdFilterTouchedRef.current || cwdFilterAutoAppliedRef.current) return;
    if (cwdFilters.length > 0) return;
    const activeKey = normalizeCwdKey(activePaneCwd);
    if (!activeKey) return;
    const match = cwdCounts.find(([cwd]) => normalizeCwdKey(cwd) === activeKey);
    if (!match) return;
    cwdFilterAutoAppliedRef.current = true;
    setCwdFilters([match[0]]);
    setSelectedIndex(0);
    setScrollTop(0);
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [activePaneCwd, cwdCounts, cwdFilters.length, open]);

  const filteredByCwd = useMemo(() => {
    if (cwdFilters.length === 0) return filteredByUserMsg;
    const set = new Set(cwdFilters);
    return filteredByUserMsg.filter((s) => set.has(s.cwd));
  }, [filteredByUserMsg, cwdFilters]);

  const fuse = useMemo(() => new Fuse(filteredByCwd, {
      keys: ["label", "preview", "cwd", "id", "kind"],
      threshold: 0.35,
      ignoreLocation: true,
      includeMatches: true,
    }), [filteredByCwd]);

  const searchResults = useMemo(
    () => query.trim() ? fuse.search(query) : [],
    [fuse, query],
  );
  const filtered = useMemo(
    () => query.trim() ? searchResults.map((result) => result.item) : filteredByCwd,
    [filteredByCwd, query, searchResults],
  );
  const labelMatchRanges = useMemo(() => {
    const result = new Map<string | null, readonly (readonly [number, number])[]>();
    for (const searchResult of searchResults) {
      const labelMatch = searchResult.matches?.find((match) => match.key === "label");
      if (labelMatch) {
        result.set(sessionKey(searchResult.item), labelMatch.indices);
      }
    }
    return result;
  }, [searchResults]);

  function toggleCwd(cwd: string) {
    cwdFilterTouchedRef.current = true;
    setCwdFilters((prev) => (prev.includes(cwd) ? prev.filter((c) => c !== cwd) : [...prev, cwd]));
    setSelectedIndex(0);
    setScrollTop(0);
    if (listRef.current) listRef.current.scrollTop = 0;
  }

  // Search acts as a filter only — the list stays in last_activity order
  // even while a query is active (Fuse relevance order is discarded).
  const sorted = useMemo(() => sortSessionsByLastActivity(filtered), [filtered]);

  const maxListed = deepLoaded ? MAX_LISTED_SESSIONS_DEEP : MAX_LISTED_SESSIONS_INITIAL;
  const listed = useMemo(() => sorted.slice(0, maxListed), [sorted, maxListed]);
  const loadMoreVisible = !deepLoaded;

  async function loadMore() {
    if (loadingMore || deepLoaded) return;
    setLoadingMore(true);
    try {
      const all = await fetchCrsmSessions(true);
      setSessions(all);
      setDeepLoaded(true);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoadingMore(false);
    }
  }
  const selected = listed[selectedIndex];
  const visibleCount = Math.ceil(listViewportHeight / ITEM_HEIGHT) + LIST_OVERSCAN * 2;
  const virtualStart = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - LIST_OVERSCAN);
  const virtualEnd = Math.min(listed.length, virtualStart + visibleCount);
  const virtualSessions = listed.slice(virtualStart, virtualEnd);

  useEffect(() => {
    const pendingKey = pendingSelectionKeyRef.current;
    if (pendingKey) {
      pendingSelectionKeyRef.current = null;
      const index = listed.findIndex((session) => sessionKey(session) === pendingKey);
      setSelectedIndex(index >= 0 ? index : 0);
      return;
    }
    setSelectedIndex((value) => Math.min(value, Math.max(listed.length - 1, 0)));
  }, [listed]);

  useEffect(() => {
    if (pendingSelectionKeyRef.current) return;
    selectedKeyRef.current = sessionKey(selected);
  }, [selected]);

  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (!list) return;
    setListViewportHeight(list.clientHeight || LIST_VIEWPORT_FALLBACK);
  }, [listed.length, open]);

  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (!list) return;
    const itemTop = selectedIndex * ITEM_HEIGHT;
    const itemBottom = itemTop + ITEM_HEIGHT;
    if (itemTop < list.scrollTop) {
      list.scrollTop = itemTop;
      setScrollTop(itemTop);
    } else if (itemBottom > list.scrollTop + list.clientHeight) {
      const nextTop = itemBottom - list.clientHeight;
      list.scrollTop = nextTop;
      setScrollTop(nextTop);
    }
  }, [open, selectedIndex]);

  useEffect(() => {
    if (!targetPinned) {
      setTargetKind(defaultTargetFor(selected?.kind));
    }
  }, [selected?.kind, targetPinned]);

  useEffect(() => {
    if (summaryOnlyConfirmKey && sessionKey(selected) !== summaryOnlyConfirmKey) {
      setSummaryOnlyConfirmKey(null);
    }
  }, [selected, summaryOnlyConfirmKey]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (resolveCrsmEscapeAction(query) === "clear-query") {
          setQuery("");
          setSelectedIndex(0);
          setScrollTop(0);
          if (listRef.current) listRef.current.scrollTop = 0;
          setTargetPinned(false);
        } else {
          onClose();
        }
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((value) => Math.min(value + 1, Math.max(listed.length - 1, 0)));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((value) => Math.max(value - 1, 0));
        return;
      }
      if (
        event.key === "PageUp"
        || event.key === "PageDown"
        || event.key === "Home"
        || event.key === "End"
      ) {
        event.preventDefault();
        const key = event.key as CrsmPageJumpKey;
        setSelectedIndex((value) => pageJumpIndex(
          value,
          key,
          listed.length,
          listViewportHeight,
        ));
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        setTargetPinned(true);
        setTargetKind((curr) => {
          if (enabledTargets.length === 0) return curr;
          const idx = enabledTargets.indexOf(curr);
          if (idx === -1) return enabledTargets[0];
          return enabledTargets[(idx + 1) % enabledTargets.length];
        });
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        void openSelected();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [enabledTargets, listViewportHeight, listed.length, open, onClose, query, selected, targetKind]);

  useEffect(() => {
    if (open && !closing) inputRef.current?.focus();
  }, [closing, open]);

  async function openSelected(): Promise<void> {
    if (!selected || !activeWorkspace) return;
    const anchorPane = activeWorkspace.panes.find((pane) => pane.sessionId === activePaneId)
      ?? activeWorkspace.panes[0];
    if (!anchorPane) return;
    setError(null);

    try {
      const launchEnv: Record<string, string> = {
        MYCMUX_AGENT_KIND: targetKind,
      };
      let agentSessionId: string | undefined = selected.id;
      let launchSession = selected;
      const selectedKey = sessionKey(selected);

      if (selected.kind === targetKind) {
        if (isSummaryOnlyClaudeSession(selected)) {
          if (summaryOnlyConfirmKey !== selectedKey) {
            setSummaryOnlyConfirmKey(selectedKey);
            setError("要約から新セッションとして再開します — もう一度 Enter で実行");
            return;
          }
          const result = await withTimeout(
            crsmCreateHandoff(selected.id, selected.kind, targetKind, 20),
            HANDOFF_TIMEOUT_MS,
            "CRSM handoff",
          );
          launchEnv.MYCMUX_HANDOFF = targetKind;
          launchEnv.MYCMUX_HANDOFF_FROM = selected.kind;
          launchEnv.MYCMUX_HANDOFF_PROMPT_FILE = result.path;
          launchEnv.MYCMUX_HANDOFF_FROM_SESSION = selected.id;
          agentSessionId = undefined;
        } else {
          const exact = canFastDirectResume(selected)
            ? selected
            : await resolveDirectResumeSession(selected);
          launchSession = exact;
          if (exact !== selected) {
            setSessions((prev) => upsertCrsmSession(prev, exact));
          }
          launchEnv.MYCMUX_RESUME = targetKind;
          launchEnv.MYCMUX_SESSION_ID = exact.id;
          agentSessionId = exact.id;
        }
      } else {
        const result = await withTimeout(
          crsmCreateHandoff(selected.id, selected.kind, targetKind, 20),
          HANDOFF_TIMEOUT_MS,
          "CRSM handoff",
        );
        launchEnv.MYCMUX_HANDOFF = targetKind;
        launchEnv.MYCMUX_HANDOFF_FROM = selected.kind;
        launchEnv.MYCMUX_HANDOFF_PROMPT_FILE = result.path;
        launchEnv.MYCMUX_HANDOFF_FROM_SESSION = selected.id;
        agentSessionId = undefined;
      }

      addPaneToWorkspaceWithOptions(activeWorkspace.id, anchorPane.id, "right", {
        agentId: "shell-starter",
        label: launchSession.label,
        cwd: launchSession.cwd,
        agentKind: launchSession.kind === targetKind ? targetKind : undefined,
        agentSessionId,
        launchEnv,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (!mounted) return null;

  return (
    <div
      className={`cmux-overlay-backdrop${closing ? " is-closing" : ""}`}
      style={styles.backdrop}
      onMouseDown={onClose}
      inert={closing ? true : undefined}
      aria-hidden={closing ? true : undefined}
    >
      <div className={`cmux-overlay-panel${closing ? " is-closing" : ""}`} style={styles.panel} onMouseDown={(event) => event.stopPropagation()}>
        <input
          ref={inputRef}
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelectedIndex(0);
            setScrollTop(0);
            if (listRef.current) {
              listRef.current.scrollTop = 0;
            }
            setTargetPinned(false);
          }}
          placeholder="履歴を検索"
          style={styles.input}
        />
        <div style={styles.targetRow}>
          {enabledTargets.map((kind) => (
            <button
              key={kind}
              type="button"
              className={`cmux-crsm-target-button${targetKind === kind ? " is-active" : ""}`}
              onClick={() => {
                setTargetPinned(true);
                setTargetKind(kind);
              }}
            >
              <span style={styles.targetTitle}>{agentTitle(kind)}</span>
              <span style={styles.targetSubtitle}>{agentSubtitle(selected, kind)}</span>
            </button>
          ))}
          <span style={styles.targetText}>{targetSummary(selected, targetKind)}</span>
        </div>
        <div style={styles.filterRow}>
          {sessionFilters.map(([kind, label]) => (
            <button
              key={kind}
              type="button"
              className={`cmux-crsm-filter-button${sessionFilter === kind ? " is-active" : ""}`}
              onClick={() => {
                setSessionFilter(kind);
                setSelectedIndex(0);
                setScrollTop(0);
                if (listRef.current) {
                  listRef.current.scrollTop = 0;
                }
                setTargetPinned(false);
                cwdFilterTouchedRef.current = true;
                setCwdFilters([]);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {cwdCountsForDisplay.length > 0 ? (
          <div style={styles.cwdRow}>
            <span style={styles.cwdLabel}>CWD</span>
            {(showAllCwds ? cwdCountsForDisplay : cwdCountsForDisplay.slice(0, TOP_CWD_CHIPS)).map(([cwd, count]) => {
              const active = cwdFilters.includes(cwd);
              return (
                <button
                  key={cwd}
                  type="button"
                  title={cwd}
                  className={`cmux-crsm-cwd-chip${active ? " is-active" : ""}`}
                  onClick={() => toggleCwd(cwd)}
                >
                  {shortenCwd(cwd)}
                  <span style={styles.cwdCount}>{count}</span>
                </button>
              );
            })}
            {cwdCountsForDisplay.length > TOP_CWD_CHIPS ? (
              <button
                type="button"
                className="cmux-crsm-cwd-action"
                onClick={() => setShowAllCwds((v) => !v)}
              >
                {showAllCwds ? "閉じる ▴" : `他 ${cwdCountsForDisplay.length - TOP_CWD_CHIPS} 件 ▾`}
              </button>
            ) : null}
            {cwdFilters.length > 0 ? (
              <button
                type="button"
                className="cmux-crsm-cwd-action cmux-crsm-cwd-action--clear"
                onClick={() => {
                  cwdFilterTouchedRef.current = true;
                  setCwdFilters([]);
                }}
              >
                クリア
              </button>
            ) : null}
          </div>
        ) : null}
        {error ? <div style={styles.error}>{error}</div> : null}
        <div style={styles.mainArea}>
        <div
          ref={listRef}
          style={styles.list}
          onScroll={(event) => {
            setScrollTop(event.currentTarget.scrollTop);
            setListViewportHeight(event.currentTarget.clientHeight || LIST_VIEWPORT_FALLBACK);
          }}
        >
          {sessions.length === 0 && !error ? (
            <div className="cmux-crsm-loading">
              <span className="cmux-spinner" aria-hidden="true" />
              {STR_LOADING_SESSIONS}
            </div>
          ) : (
          <div style={{ ...styles.virtualTrack, height: listed.length * ITEM_HEIGHT + (loadMoreVisible ? LOAD_MORE_HEIGHT : 0) }}>
          {virtualSessions.map((session, offset) => {
            const index = virtualStart + offset;
            const kindColor = KIND_COLORS[session.kind];
            return (
            <button
              key={`${session.kind}:${session.id}`}
              type="button"
              className={`cmux-crsm-item${index === selectedIndex ? " is-active" : ""}`}
              style={{ top: index * ITEM_HEIGHT, height: ITEM_HEIGHT - 2 }}
              onMouseMove={() => {
                if (selectedIndex !== index) {
                  setSelectedIndex(index);
                }
              }}
              onClick={() => void openSelected()}
            >
              <span
                style={{
                  ...styles.kind,
                  color: kindColor.fg,
                  background: kindColor.bg,
                }}
              >
                {agentBadge(session.kind)}
              </span>
              <span style={styles.itemBody}>
                <span style={styles.itemRow1}>
                  <span style={styles.label} title={session.label}>
                    {highlightedLabel(session.label, labelMatchRanges.get(sessionKey(session)))}
                  </span>
                  <span style={styles.itemTimeSingle} title={formatStamp(session.last_activity)}>
                    {formatRelative(session.last_activity)}
                  </span>
                </span>
                <span style={styles.itemRow2}>
                  <span style={styles.itemRow2Cwd} title={session.cwd}>{shortenCwd(session.cwd)}</span>
                  <span style={styles.itemRow2Sep}>·</span>
                  <span style={styles.itemRow2Source}>{sourceShort(session.source)}</span>
                  {(session.files_modified?.length ?? 0) > 0 ? (
                    <span style={styles.itemRow2Tag} aria-label={`Modified files: ${session.files_modified.length}`}>
                      <PencilIcon />
                      <span style={styles.metadataCount}>{session.files_modified.length}</span>
                    </span>
                  ) : null}
                  {(session.incomplete_tasks?.length ?? 0) > 0 ? (
                    <span style={styles.itemRow2Tag} aria-label={`Incomplete tasks: ${session.incomplete_tasks.length}`}>
                      <TaskIcon />
                      <span style={styles.metadataCount}>{session.incomplete_tasks.length}</span>
                    </span>
                  ) : null}
                  {isSummaryOnlyClaudeSession(session) ? (
                    <span style={styles.itemRow2Tag}>要約のみ</span>
                  ) : null}
                  {session.summary_file ? <span style={styles.itemRow2Tag} aria-label="Summary available"><DocumentIcon /></span> : null}
                </span>
              </span>
            </button>
            );
          })}
          {loadMoreVisible ? (
            <button
              type="button"
              className="cmux-crsm-load-more"
              style={{ top: listed.length * ITEM_HEIGHT, height: LOAD_MORE_HEIGHT - 6 }}
              onClick={() => void loadMore()}
              disabled={loadingMore}
            >
              {loadingMore
                ? <><span className="cmux-spinner" aria-hidden="true" />読み込み中...</>
                : query.trim()
                  ? `${STR_DEEP_SEARCH_CTA} (現在 ${listed.length} 件)`
                  : `さらに過去のセッションを読み込む (現在 ${listed.length} 件 → 全件)`}
            </button>
          ) : null}
          </div>
          )}
        </div>
        <div style={styles.detail}>
          {selected ? (
            (() => {
              const dColor = KIND_COLORS[selected.kind];
              const dur = formatDuration(selected.started_at, selected.last_activity);
              const filesMod = selected.files_modified ?? [];
              const incTasks = selected.incomplete_tasks ?? [];
              const hasMeta = filesMod.length > 0 || incTasks.length > 0 || !!selected.summary_file;
              return (
                <>
                  <div style={styles.detailTopBar}>
                    <span
                      style={{
                        ...styles.kind,
                        color: dColor.fg,
                        background: dColor.bg,
                      }}
                    >
                      {agentBadge(selected.kind)}
                    </span>
                    <span style={styles.detailTitle}>{agentTitle(selected.kind)}</span>
                    <span style={styles.detailTopBarSep}>·</span>
                    <span style={styles.detailTopBarTime}>
                      {formatStamp(selected.started_at ?? selected.last_activity)}
                      <span style={styles.detailMetaSep}>→</span>
                      {formatStamp(selected.last_activity)}
                      {dur ? <span style={styles.detailDuration}>({dur})</span> : null}
                    </span>
                  </div>
                  <div style={styles.detailLocation}>
                    <span style={styles.detailCwd} title={selected.cwd}>
                      {selected.cwd}
                    </span>
                    <span style={styles.detailSourceLabel}>{selected.source}</span>
                  </div>
                  <div style={styles.detailPreview}>
                    {(() => {
                      const turns = splitPreviewTurns(selected.preview);
                      if (turns.length === 0) {
                        return <span style={styles.detailPreviewEmpty}>(プレビューなし)</span>;
                      }
                      return turns.map((turn, idx) => {
                        const turnStyle =
                          turn.role === "user"
                            ? styles.previewTurnUser
                            : turn.role === "assistant"
                            ? styles.previewTurnAssistant
                            : styles.previewTurnOther;
                        const labelText =
                          turn.role === "user"
                            ? "USER"
                            : turn.role === "assistant"
                            ? "ASSISTANT"
                            : "—";
                        const labelStyle =
                          turn.role === "user"
                            ? styles.previewRoleUser
                            : turn.role === "assistant"
                            ? styles.previewRoleAssistant
                            : styles.previewRoleOther;
                        return (
                          <div key={idx} style={turnStyle}>
                            <div style={labelStyle}>{labelText}</div>
                            <div style={styles.previewText}>{turn.text}</div>
                          </div>
                        );
                      });
                    })()}
                  </div>
                  {hasMeta ? (
                    <div style={styles.detailMetaBlock}>
                      {filesMod.length > 0 ? (
                        <div style={styles.detailSection}>
                          <div style={styles.detailSectionTitle}>
                            <PencilIcon />
                            変更ファイル <span style={styles.detailSectionCount}>{filesMod.length}</span>
                          </div>
                          <div style={styles.detailListWrap}>
                            {filesMod.map((f) => (
                              <div key={f} style={{ ...styles.detailListItem, ...styles.detailFilePath }} title={f}>
                                {f}
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      {incTasks.length > 0 ? (
                        <div style={styles.detailSection}>
                          <div style={styles.detailSectionTitle}>
                            <TaskIcon />
                            未完了 <span style={styles.detailSectionCount}>{incTasks.length}</span>
                          </div>
                          <div style={styles.detailListWrap}>
                            {incTasks.map((t) => (
                              <div key={t} style={styles.detailListItem} title={t}>
                                {t}
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      {selected.summary_file ? (
                        <div style={styles.detailSection}>
                          <div style={styles.detailSectionTitle}>
                            <DocumentIcon />
                            要約: <span style={styles.detailSummaryPath}>{selected.summary_file}</span>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {selected.source_path ? (
                    <div style={styles.detailSourcePath} title={selected.source_path}>
                      {shortenPath(selected.source_path, 90)}
                    </div>
                  ) : null}
                </>
              );
            })()
          ) : (
            <div style={styles.detailEmpty}>セッションを選択してください</div>
          )}
        </div>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 1000,
    background: "var(--cmux-backdrop)",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "center",
    paddingTop: "9vh",
  },
  panel: {
    width: "min(1200px, calc(100vw - 32px))",
    maxHeight: "82vh",
    background: "var(--cmux-popover)",
    color: "var(--cmux-text)",
    border: "1px solid var(--cmux-border)",
    borderRadius: "var(--cmux-radius-lg)",
    boxShadow: "var(--cmux-shadow-palette)",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  },
  input: {
    width: "100%",
    boxSizing: "border-box",
    padding: "14px 16px",
    border: 0,
    outline: 0,
    borderBottom: "1px solid var(--cmux-border-hairline)",
    background: "color-mix(in srgb, var(--cmux-text) 6%, transparent)",
    color: "var(--cmux-text)",
    fontSize: 16,
  },
  targetRow: {
    display: "flex",
    gap: 8,
    alignItems: "center",
    padding: "10px 12px",
    borderBottom: "1px solid var(--cmux-border-hairline)",
  },
  targetTitle: {
    fontSize: 13,
    fontWeight: 650,
    lineHeight: 1.15,
  },
  targetSubtitle: {
    fontSize: 11,
    lineHeight: 1.2,
    opacity: 0.66,
    whiteSpace: "nowrap",
  },
  targetText: {
    opacity: 0.72,
    fontSize: 13,
    marginLeft: 2,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  filterRow: {
    display: "flex",
    gap: 6,
    alignItems: "center",
    padding: "8px 12px",
    borderBottom: "1px solid var(--cmux-border-hairline)",
  },
  mainArea: {
    display: "flex",
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
  },
  list: {
    flex: "0 0 480px",
    overflowY: "auto",
    padding: 6,
    borderRight: "1px solid var(--cmux-border-hairline)",
  },
  detail: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
    padding: "8px 12px",
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  detailTopBar: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
    fontSize: 12,
    flexShrink: 0,
  },
  detailTitle: {
    fontWeight: 600,
  },
  detailTopBarSep: {
    opacity: 0.3,
  },
  detailTopBarTime: {
    display: "inline-flex",
    alignItems: "baseline",
    gap: 3,
    fontSize: "var(--cmux-font-size-xs)",
    fontFamily: "var(--cmux-font-mono)",
    fontVariantNumeric: "tabular-nums",
    opacity: 0.78,
  },
  detailMetaSep: {
    opacity: 0.4,
    margin: "0 3px",
  },
  detailDuration: {
    marginLeft: 4,
    opacity: 0.55,
    fontSize: "var(--cmux-font-size-xs)",
  },
  detailLocation: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 11,
    opacity: 0.7,
    flexWrap: "wrap",
    flexShrink: 0,
  },
  detailCwd: {
    wordBreak: "break-all",
    userSelect: "text",
    flex: 1,
    minWidth: 0,
    fontSize: "var(--cmux-font-size-xs)",
    fontFamily: "var(--cmux-font-mono)",
  },
  detailSourceLabel: {
    padding: "0 5px",
    borderRadius: 3,
    background: "color-mix(in srgb, var(--cmux-text) 6%, transparent)",
    fontSize: "var(--cmux-font-size-xs)",
    fontFamily: "var(--cmux-font-mono)",
    opacity: 0.85,
    flexShrink: 0,
  },
  detailSourcePath: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
    fontSize: "var(--cmux-font-size-xs)",
    fontFamily: "var(--cmux-font-mono)",
    opacity: 0.42,
    userSelect: "text",
    flexShrink: 0,
  },
  detailPreview: {
    flex: 1,
    minHeight: 80,
    margin: 0,
    padding: "4px 2px",
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  detailPreviewEmpty: {
    opacity: 0.4,
    fontSize: 12,
    padding: "8px 10px",
  },
  previewTurnUser: {
    padding: "5px 9px",
    borderLeft: "3px solid color-mix(in srgb, var(--status-working) 60%, transparent)",
    background: "color-mix(in srgb, var(--status-working) 5%, transparent)",
    borderRadius: "0 4px 4px 0",
    userSelect: "text",
  },
  previewTurnAssistant: {
    padding: "5px 9px",
    borderLeft: "3px solid color-mix(in srgb, var(--status-done) 60%, transparent)",
    background: "color-mix(in srgb, var(--status-done) 5%, transparent)",
    borderRadius: "0 4px 4px 0",
    userSelect: "text",
  },
  previewTurnOther: {
    padding: "5px 9px",
    borderLeft: "3px solid color-mix(in srgb, var(--cmux-text) 18%, transparent)",
    background: "color-mix(in srgb, var(--cmux-text) 3%, transparent)",
    borderRadius: "0 4px 4px 0",
    userSelect: "text",
  },
  previewRoleUser: {
    fontSize: 9,
    fontWeight: 600,
    letterSpacing: "0.08em",
    color: "color-mix(in srgb, var(--status-working) 85%, var(--cmux-text))",
    marginBottom: 3,
  },
  previewRoleAssistant: {
    fontSize: 9,
    fontWeight: 600,
    letterSpacing: "0.08em",
    color: "color-mix(in srgb, var(--status-done) 85%, var(--cmux-text))",
    marginBottom: 3,
  },
  previewRoleOther: {
    fontSize: 9,
    fontWeight: 600,
    letterSpacing: "0.08em",
    opacity: 0.5,
    marginBottom: 3,
  },
  previewText: {
    fontSize: 12,
    lineHeight: 1.5,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    opacity: 0.92,
  },
  detailMetaBlock: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    flexShrink: 0,
    maxHeight: "38%",
    overflowY: "auto",
  },
  detailSection: {
    display: "flex",
    flexDirection: "column",
    gap: 1,
  },
  detailSectionTitle: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    fontSize: 11,
    fontWeight: 600,
    opacity: 0.7,
    letterSpacing: "0.03em",
  },
  detailSectionCount: {
    marginLeft: 3,
    opacity: 0.5,
    fontSize: "var(--cmux-font-size-xs)",
    fontFamily: "var(--cmux-font-mono)",
  },
  detailSummaryPath: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "var(--cmux-font-size-xs)",
    fontFamily: "var(--cmux-font-mono)",
  },
  detailListWrap: {
    display: "flex",
    flexDirection: "column",
    paddingLeft: 12,
    fontSize: "var(--cmux-font-size-xs)",
    lineHeight: 1.4,
  },
  detailFilePath: {
    fontFamily: "var(--cmux-font-mono)",
  },
  detailListItem: {
    opacity: 0.78,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    userSelect: "text",
  },
  detailEmpty: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    opacity: 0.4,
    fontSize: 13,
  },
  cwdRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
    alignItems: "center",
    padding: "6px 12px",
    borderBottom: "1px solid var(--cmux-border-hairline)",
  },
  cwdLabel: {
    fontSize: 10,
    opacity: 0.55,
    letterSpacing: "0.06em",
    marginRight: 2,
  },
  cwdCount: {
    opacity: 0.5,
    fontSize: "var(--cmux-font-size-xs)",
    fontFamily: "var(--cmux-font-mono)",
    fontVariantNumeric: "tabular-nums",
  },
  virtualTrack: {
    position: "relative",
    minHeight: "100%",
  },
  kind: {
    minWidth: 52,
    padding: "1px 6px",
    borderRadius: 3,
    fontSize: 10,
    fontWeight: 500,
    letterSpacing: "0.02em",
    textAlign: "center",
    flexShrink: 0,
  },
  itemBody: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: 2,
  },
  itemRow1: {
    display: "flex",
    alignItems: "baseline",
    gap: 8,
    minWidth: 0,
  },
  itemRow2: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 11,
    opacity: 0.55,
    lineHeight: 1.2,
    minWidth: 0,
  },
  label: {
    flex: 1,
    minWidth: 0,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  itemRow2Cwd: {
    minWidth: 0,
    maxWidth: 200,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    fontSize: "var(--cmux-font-size-xs)",
    fontFamily: "var(--cmux-font-mono)",
  },
  itemRow2Sep: {
    opacity: 0.4,
  },
  itemRow2Source: {
    flexShrink: 0,
    fontSize: "var(--cmux-font-size-xs)",
    fontFamily: "var(--cmux-font-mono)",
  },
  itemRow2Tag: {
    display: "inline-flex",
    alignItems: "center",
    gap: 3,
    flexShrink: 0,
    padding: "0 4px",
    borderRadius: 3,
    background: "color-mix(in srgb, var(--cmux-text) 6%, transparent)",
    fontSize: "var(--cmux-font-size-xs)",
  },
  metadataCount: {
    fontFamily: "var(--cmux-font-mono)",
    fontVariantNumeric: "tabular-nums",
  },
  itemTimeSingle: {
    fontSize: "var(--cmux-font-size-xs)",
    fontFamily: "var(--cmux-font-mono)",
    opacity: 0.65,
    minWidth: 56,
    whiteSpace: "nowrap",
    textAlign: "right",
    flexShrink: 0,
  },
  error: {
    padding: "10px 12px",
    color: "var(--cmux-red)",
  },
};
