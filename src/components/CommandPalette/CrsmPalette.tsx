import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import Fuse from "fuse.js";
import {
  crsmCreateHandoff,
  crsmListSessions,
  type CrsmSessionEntry,
} from "../../lib/ipc";
import {
  useUiStore,
  useWorkspaceLayoutStore,
} from "../../stores/workspaceStore";
import { useWorkspaceListStore } from "../../stores/workspaceListStore";
import { useSettingsStore } from "../../stores/settingsStore";

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

function nextTarget(kind: OpenTargetKind): OpenTargetKind {
  const index = OPEN_TARGETS.indexOf(kind);
  return OPEN_TARGETS[(index + 1) % OPEN_TARGETS.length];
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
let crsmSessionsRequest: Promise<CrsmSessionEntry[]> | null = null;

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

function fetchCrsmSessions(deep = false): Promise<CrsmSessionEntry[]> {
  if (!deep && cachedCrsmSessionsIsDeep && cachedCrsmSessions) {
    return Promise.resolve(cachedCrsmSessions);
  }
  if (!crsmSessionsRequest) {
    const limit = deep ? SESSION_FETCH_LIMIT_DEEP : SESSION_FETCH_LIMIT_INITIAL;
    crsmSessionsRequest = crsmListSessions(undefined, limit, false)
      .then((nextSessions) => {
        cachedCrsmSessions = nextSessions;
        cachedCrsmSessionsError = null;
        cachedCrsmSessionsIsDeep = deep;
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
        crsmSessionsRequest = null;
      });
  }
  return crsmSessionsRequest;
}

export function preloadCrsmSessions(): void {
  if (cachedCrsmSessions || crsmSessionsRequest || typeof window === "undefined") return;
  const start = () => {
    void fetchCrsmSessions().catch(() => undefined);
  };
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(start, { timeout: 2500 });
  } else {
    window.setTimeout(start, 900);
  }
}

export default function CrsmPalette({ open, onClose }: CrsmPaletteProps) {
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
  const listRef = useRef<HTMLDivElement | null>(null);
  const requestIdRef = useRef(0);
  const activeWorkspace = useWorkspaceListStore((s) => s.getActiveWorkspace());
  const activePaneId = useUiStore((s) => s.activePaneId);
  const addPaneToWorkspaceWithOptions = useWorkspaceLayoutStore((s) => s.addPaneToWorkspaceWithOptions);

  // Per-kind visibility from Settings (right-side gear menu). When the
  // user disables a kind, that kind disappears from both the session
  // list and the filter chips.
  const showClaude = useSettingsStore((s) => s.crsmShowClaude);
  const showCodex = useSettingsStore((s) => s.crsmShowCodex);
  const showClaudeCodex = useSettingsStore((s) => s.crsmShowClaudeCodex);
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

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSelectedIndex(0);
    setScrollTop(0);
    setTargetPinned(false);
    setSessionFilter("all");
    setCwdFilters([]);
    setShowAllCwds(false);
    if (listRef.current) {
      listRef.current.scrollTop = 0;
    }
    if (cachedCrsmSessions) {
      setSessions(cachedCrsmSessions);
    }
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    fetchCrsmSessions()
      .then((nextSessions) => {
        if (requestIdRef.current !== requestId) return;
        setSessions(nextSessions);
        setError(cachedCrsmSessionsError ? `CRSM cache fallback: ${cachedCrsmSessionsError}` : null);
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

  const filteredByAgent = useMemo(() => {
    const visible = sessions.filter((session) => enabledKinds.has(session.kind));
    if (sessionFilter === "all") return visible;
    return visible.filter((session) => session.kind === sessionFilter);
  }, [sessionFilter, sessions, enabledKinds]);

  const cwdCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of filteredByAgent) {
      map.set(s.cwd, (map.get(s.cwd) ?? 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [filteredByAgent]);

  const filteredByCwd = useMemo(() => {
    if (cwdFilters.length === 0) return filteredByAgent;
    const set = new Set(cwdFilters);
    return filteredByAgent.filter((s) => set.has(s.cwd));
  }, [filteredByAgent, cwdFilters]);

  const filtered = useMemo(() => {
    if (!query.trim()) return filteredByCwd;
    const fuse = new Fuse(filteredByCwd, {
      keys: ["label", "preview", "cwd", "id", "kind"],
      threshold: 0.35,
      ignoreLocation: true,
    });
    return fuse.search(query).map((item) => item.item);
  }, [filteredByCwd, query]);

  function toggleCwd(cwd: string) {
    setCwdFilters((prev) => (prev.includes(cwd) ? prev.filter((c) => c !== cwd) : [...prev, cwd]));
    setSelectedIndex(0);
    setScrollTop(0);
    if (listRef.current) listRef.current.scrollTop = 0;
  }

  const sorted = useMemo(() => {
    if (query.trim()) return filtered;
    return [...filtered].sort((a, b) => {
      const ta = Date.parse(a.last_activity) || 0;
      const tb = Date.parse(b.last_activity) || 0;
      return tb - ta;
    });
  }, [filtered, query]);

  const maxListed = deepLoaded ? MAX_LISTED_SESSIONS_DEEP : MAX_LISTED_SESSIONS_INITIAL;
  const listed = useMemo(() => sorted.slice(0, maxListed), [sorted, maxListed]);
  const loadMoreVisible = !deepLoaded && !query.trim();

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
    setSelectedIndex((value) => Math.min(value, Math.max(listed.length - 1, 0)));
  }, [listed.length]);

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
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
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
      if (event.key === "Tab") {
        event.preventDefault();
        setTargetPinned(true);
        setTargetKind(nextTarget);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        void openSelected();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [listed.length, open, onClose, selected, targetKind]);

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

      if (selected.kind === targetKind) {
        launchEnv.MYCMUX_RESUME = targetKind;
        launchEnv.MYCMUX_SESSION_ID = selected.id;
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
        label: selected.label,
        cwd: selected.cwd,
        agentKind: selected.kind === targetKind ? targetKind : undefined,
        agentSessionId,
        launchEnv,
      });
      onClose();
    } catch (err) {
      setError(String(err));
    }
  }

  if (!open) return null;

  return (
    <div style={styles.backdrop} onMouseDown={onClose}>
      <div style={styles.panel} onMouseDown={(event) => event.stopPropagation()}>
        <input
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
          {OPEN_TARGETS.map((kind) => (
            <button
              key={kind}
              type="button"
              style={targetKind === kind ? styles.targetButtonActive : styles.targetButton}
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
              style={sessionFilter === kind ? styles.filterButtonActive : styles.filterButton}
              onClick={() => {
                setSessionFilter(kind);
                setSelectedIndex(0);
                setScrollTop(0);
                if (listRef.current) {
                  listRef.current.scrollTop = 0;
                }
                setTargetPinned(false);
                setCwdFilters([]);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {cwdCounts.length > 0 ? (
          <div style={styles.cwdRow}>
            <span style={styles.cwdLabel}>CWD</span>
            {(showAllCwds ? cwdCounts : cwdCounts.slice(0, TOP_CWD_CHIPS)).map(([cwd, count]) => {
              const active = cwdFilters.includes(cwd);
              return (
                <button
                  key={cwd}
                  type="button"
                  title={cwd}
                  style={active ? styles.cwdChipActive : styles.cwdChip}
                  onClick={() => toggleCwd(cwd)}
                >
                  {shortenCwd(cwd)}
                  <span style={styles.cwdCount}>{count}</span>
                </button>
              );
            })}
            {cwdCounts.length > TOP_CWD_CHIPS ? (
              <button
                type="button"
                style={styles.cwdMoreToggle}
                onClick={() => setShowAllCwds((v) => !v)}
              >
                {showAllCwds ? "閉じる ▴" : `他 ${cwdCounts.length - TOP_CWD_CHIPS} 件 ▾`}
              </button>
            ) : null}
            {cwdFilters.length > 0 ? (
              <button type="button" style={styles.cwdClear} onClick={() => setCwdFilters([])}>
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
          <div style={{ ...styles.virtualTrack, height: listed.length * ITEM_HEIGHT + (loadMoreVisible ? LOAD_MORE_HEIGHT : 0) }}>
          {virtualSessions.map((session, offset) => {
            const index = virtualStart + offset;
            const kindColor = KIND_COLORS[session.kind];
            return (
            <button
              key={`${session.kind}:${session.id}`}
              type="button"
              style={{
                ...(index === selectedIndex ? styles.itemActive : styles.item),
                top: index * ITEM_HEIGHT,
              }}
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
                  <span style={styles.label} title={session.label}>{session.label}</span>
                  <span style={styles.itemTimeSingle} title={formatStamp(session.last_activity)}>
                    {formatRelative(session.last_activity)}
                  </span>
                </span>
                <span style={styles.itemRow2}>
                  <span style={styles.itemRow2Cwd} title={session.cwd}>{shortenCwd(session.cwd)}</span>
                  <span style={styles.itemRow2Sep}>·</span>
                  <span style={styles.itemRow2Source}>{sourceShort(session.source)}</span>
                  {(session.files_modified?.length ?? 0) > 0 ? (
                    <span style={styles.itemRow2Tag}>✏ {session.files_modified.length}</span>
                  ) : null}
                  {(session.incomplete_tasks?.length ?? 0) > 0 ? (
                    <span style={styles.itemRow2Tag}>☐ {session.incomplete_tasks.length}</span>
                  ) : null}
                  {session.summary_file ? <span style={styles.itemRow2Tag}>📄</span> : null}
                </span>
              </span>
            </button>
            );
          })}
          {loadMoreVisible ? (
            <button
              type="button"
              style={{ ...styles.loadMore, top: listed.length * ITEM_HEIGHT }}
              onClick={() => void loadMore()}
              disabled={loadingMore}
            >
              {loadingMore
                ? "読み込み中..."
                : `さらに過去のセッションを読み込む (現在 ${listed.length} 件 → 全件)`}
            </button>
          ) : null}
          </div>
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
                            ✏ 変更ファイル <span style={styles.detailSectionCount}>{filesMod.length}</span>
                          </div>
                          <div style={styles.detailListWrap}>
                            {filesMod.map((f) => (
                              <div key={f} style={styles.detailListItem} title={f}>
                                {f}
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      {incTasks.length > 0 ? (
                        <div style={styles.detailSection}>
                          <div style={styles.detailSectionTitle}>
                            ☐ 未完了 <span style={styles.detailSectionCount}>{incTasks.length}</span>
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
                          <div style={styles.detailSectionTitle}>📄 要約: {selected.summary_file}</div>
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
    background: "rgba(0, 0, 0, 0.42)",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "center",
    paddingTop: "9vh",
  },
  panel: {
    width: "min(1200px, calc(100vw - 32px))",
    maxHeight: "82vh",
    background: "var(--color-bg, #111)",
    color: "var(--color-fg, #eee)",
    border: "1px solid rgba(255,255,255,0.18)",
    borderRadius: 8,
    boxShadow: "0 24px 70px rgba(0,0,0,0.45)",
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
    borderBottom: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(255,255,255,0.06)",
    color: "inherit",
    fontSize: 16,
  },
  targetRow: {
    display: "flex",
    gap: 8,
    alignItems: "center",
    padding: "10px 12px",
    borderBottom: "1px solid rgba(255,255,255,0.1)",
  },
  targetButton: {
    minWidth: 165,
    display: "flex",
    flexDirection: "column",
    gap: 2,
    padding: "8px 10px",
    borderRadius: 7,
    border: "1px solid rgba(255,255,255,0.18)",
    background: "transparent",
    color: "inherit",
    textAlign: "left",
  },
  targetButtonActive: {
    minWidth: 165,
    display: "flex",
    flexDirection: "column",
    gap: 2,
    padding: "8px 10px",
    borderRadius: 7,
    border: "1px solid rgba(255,255,255,0.28)",
    background: "rgba(255,255,255,0.14)",
    color: "inherit",
    textAlign: "left",
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
    borderBottom: "1px solid rgba(255,255,255,0.1)",
  },
  filterButton: {
    padding: "5px 9px",
    borderRadius: 6,
    border: "1px solid rgba(255,255,255,0.16)",
    background: "transparent",
    color: "inherit",
    fontSize: 12,
  },
  filterButtonActive: {
    padding: "5px 9px",
    borderRadius: 6,
    border: "1px solid rgba(255,255,255,0.28)",
    background: "rgba(255,255,255,0.13)",
    color: "inherit",
    fontSize: 12,
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
    borderRight: "1px solid rgba(255,255,255,0.10)",
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
    fontSize: 11,
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
    fontSize: 10,
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
  },
  detailSourceLabel: {
    padding: "0 5px",
    borderRadius: 3,
    background: "rgba(255,255,255,0.06)",
    fontSize: 10,
    opacity: 0.85,
    flexShrink: 0,
  },
  detailSourcePath: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
    fontSize: 10,
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
    borderLeft: "3px solid rgba(127, 184, 255, 0.6)",
    background: "rgba(127, 184, 255, 0.05)",
    borderRadius: "0 4px 4px 0",
    userSelect: "text",
  },
  previewTurnAssistant: {
    padding: "5px 9px",
    borderLeft: "3px solid rgba(125, 204, 151, 0.6)",
    background: "rgba(125, 204, 151, 0.05)",
    borderRadius: "0 4px 4px 0",
    userSelect: "text",
  },
  previewTurnOther: {
    padding: "5px 9px",
    borderLeft: "3px solid rgba(180, 180, 180, 0.4)",
    background: "rgba(255, 255, 255, 0.03)",
    borderRadius: "0 4px 4px 0",
    userSelect: "text",
  },
  previewRoleUser: {
    fontSize: 9,
    fontWeight: 600,
    letterSpacing: "0.08em",
    color: "rgba(127, 184, 255, 0.85)",
    marginBottom: 3,
  },
  previewRoleAssistant: {
    fontSize: 9,
    fontWeight: 600,
    letterSpacing: "0.08em",
    color: "rgba(125, 204, 151, 0.85)",
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
    fontSize: 10,
    fontWeight: 600,
    opacity: 0.7,
    letterSpacing: "0.03em",
  },
  detailSectionCount: {
    marginLeft: 3,
    opacity: 0.5,
  },
  detailListWrap: {
    display: "flex",
    flexDirection: "column",
    paddingLeft: 12,
    fontSize: 11,
    fontFamily: "ui-monospace, monospace",
    lineHeight: 1.4,
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
    borderBottom: "1px solid rgba(255,255,255,0.10)",
  },
  cwdLabel: {
    fontSize: 10,
    opacity: 0.55,
    letterSpacing: "0.06em",
    marginRight: 2,
  },
  cwdChip: {
    padding: "3px 8px",
    borderRadius: 11,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "transparent",
    color: "inherit",
    fontSize: 11,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
  },
  cwdChipActive: {
    padding: "3px 8px",
    borderRadius: 11,
    border: "1px solid rgba(120, 200, 255, 0.5)",
    background: "rgba(120, 200, 255, 0.14)",
    color: "inherit",
    fontSize: 11,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
  },
  cwdCount: {
    opacity: 0.5,
    fontSize: 10,
    fontVariantNumeric: "tabular-nums",
  },
  cwdMoreToggle: {
    padding: "3px 6px",
    borderRadius: 4,
    border: "0",
    background: "transparent",
    color: "inherit",
    opacity: 0.6,
    fontSize: 11,
    cursor: "pointer",
  },
  cwdClear: {
    padding: "3px 8px",
    borderRadius: 4,
    border: "0",
    background: "rgba(255,180,180,0.10)",
    color: "#ffc4b8",
    fontSize: 11,
    cursor: "pointer",
    marginLeft: "auto",
  },
  virtualTrack: {
    position: "relative",
    minHeight: "100%",
  },
  item: {
    width: "100%",
    height: ITEM_HEIGHT - 2,
    position: "absolute",
    left: 0,
    right: 0,
    boxSizing: "border-box",
    display: "flex",
    gap: 8,
    alignItems: "center",
    padding: "4px 10px",
    border: 0,
    borderRadius: 4,
    background: "transparent",
    color: "inherit",
    textAlign: "left",
    fontSize: 12,
  },
  itemActive: {
    width: "100%",
    height: ITEM_HEIGHT - 2,
    position: "absolute",
    left: 0,
    right: 0,
    boxSizing: "border-box",
    display: "flex",
    gap: 8,
    alignItems: "center",
    padding: "4px 10px",
    border: 0,
    borderRadius: 4,
    background: "rgba(255,255,255,0.14)",
    color: "inherit",
    textAlign: "left",
    fontSize: 12,
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
    fontSize: 10,
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
  },
  itemRow2Sep: {
    opacity: 0.4,
  },
  itemRow2Source: {
    flexShrink: 0,
  },
  itemRow2Tag: {
    flexShrink: 0,
    padding: "0 4px",
    borderRadius: 3,
    background: "rgba(255,255,255,0.06)",
    fontSize: 9,
  },
  itemTimeSingle: {
    fontSize: 11,
    opacity: 0.65,
    minWidth: 56,
    whiteSpace: "nowrap",
    textAlign: "right",
    flexShrink: 0,
  },
  loadMore: {
    position: "absolute",
    left: 0,
    right: 0,
    height: LOAD_MORE_HEIGHT - 6,
    margin: "3px 0",
    boxSizing: "border-box",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    border: "1px dashed rgba(255,255,255,0.22)",
    borderRadius: 6,
    background: "rgba(255,255,255,0.04)",
    color: "inherit",
    fontSize: 12,
    cursor: "pointer",
  },
  error: {
    padding: "10px 12px",
    color: "#ffb4ab",
  },
};
