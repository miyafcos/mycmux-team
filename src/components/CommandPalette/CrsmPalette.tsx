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

interface CrsmPaletteProps {
  open: boolean;
  onClose: () => void;
}

type TargetKind = CrsmSessionEntry["kind"];
type OpenTargetKind = TargetKind;
type SessionFilterKind = "all" | TargetKind;

const OPEN_TARGETS: OpenTargetKind[] = ["claude", "codex", "claude-codex"];
const SESSION_FETCH_LIMIT = 300;
const MAX_LISTED_SESSIONS = 180;
const ITEM_HEIGHT = 56;
const LIST_OVERSCAN = 6;
const LIST_VIEWPORT_FALLBACK = 420;
const HANDOFF_TIMEOUT_MS = 9000;
const SESSION_FILTERS: Array<[SessionFilterKind, string]> = [
  ["all", "すべて"],
  ["claude", "Claude Code"],
  ["codex", "Codex"],
  ["claude-codex", "Hybrid"],
];

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

let cachedCrsmSessions: CrsmSessionEntry[] | null = null;
let cachedCrsmSessionsError: string | null = null;
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

function fetchCrsmSessions(): Promise<CrsmSessionEntry[]> {
  if (!crsmSessionsRequest) {
    crsmSessionsRequest = crsmListSessions(undefined, SESSION_FETCH_LIMIT, false)
      .then((nextSessions) => {
        cachedCrsmSessions = nextSessions;
        cachedCrsmSessionsError = null;
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
  const listRef = useRef<HTMLDivElement | null>(null);
  const requestIdRef = useRef(0);
  const activeWorkspace = useWorkspaceListStore((s) => s.getActiveWorkspace());
  const activePaneId = useUiStore((s) => s.activePaneId);
  const addPaneToWorkspaceWithOptions = useWorkspaceLayoutStore((s) => s.addPaneToWorkspaceWithOptions);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSelectedIndex(0);
    setScrollTop(0);
    setTargetPinned(false);
    setSessionFilter("all");
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

  const filteredByAgent = useMemo(() => {
    if (sessionFilter === "all") return sessions;
    return sessions.filter((session) => session.kind === sessionFilter);
  }, [sessionFilter, sessions]);

  const filtered = useMemo(() => {
    if (!query.trim()) return filteredByAgent;
    const fuse = new Fuse(filteredByAgent, {
      keys: ["label", "preview", "cwd", "id", "kind"],
      threshold: 0.35,
      ignoreLocation: true,
    });
    return fuse.search(query).map((item) => item.item);
  }, [filteredByAgent, query]);

  const listed = useMemo(() => filtered.slice(0, MAX_LISTED_SESSIONS), [filtered]);
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
          {SESSION_FILTERS.map(([kind, label]) => (
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
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {error ? <div style={styles.error}>{error}</div> : null}
        <div
          ref={listRef}
          style={styles.list}
          onScroll={(event) => {
            setScrollTop(event.currentTarget.scrollTop);
            setListViewportHeight(event.currentTarget.clientHeight || LIST_VIEWPORT_FALLBACK);
          }}
        >
          <div style={{ ...styles.virtualTrack, height: listed.length * ITEM_HEIGHT }}>
          {virtualSessions.map((session, offset) => {
            const index = virtualStart + offset;
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
              <span style={styles.kind}>{agentBadge(session.kind)}</span>
              <span style={styles.itemMain}>
                <span style={styles.label}>{session.label}</span>
                <span style={styles.meta}>{session.cwd}</span>
              </span>
            </button>
            );
          })}
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
    width: "min(940px, calc(100vw - 32px))",
    maxHeight: "78vh",
    background: "var(--color-bg, #111)",
    color: "var(--color-fg, #eee)",
    border: "1px solid rgba(255,255,255,0.18)",
    borderRadius: 8,
    boxShadow: "0 24px 70px rgba(0,0,0,0.45)",
    overflow: "hidden",
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
  list: {
    maxHeight: "calc(78vh - 165px)",
    overflowY: "auto",
    padding: 6,
  },
  virtualTrack: {
    position: "relative",
    minHeight: "100%",
  },
  item: {
    width: "100%",
    height: ITEM_HEIGHT - 4,
    position: "absolute",
    left: 0,
    right: 0,
    boxSizing: "border-box",
    display: "flex",
    gap: 10,
    alignItems: "center",
    padding: "10px 12px",
    border: 0,
    borderRadius: 6,
    background: "transparent",
    color: "inherit",
    textAlign: "left",
  },
  itemActive: {
    width: "100%",
    height: ITEM_HEIGHT - 4,
    position: "absolute",
    left: 0,
    right: 0,
    boxSizing: "border-box",
    display: "flex",
    gap: 10,
    alignItems: "center",
    padding: "10px 12px",
    border: 0,
    borderRadius: 6,
    background: "rgba(255,255,255,0.14)",
    color: "inherit",
    textAlign: "left",
  },
  kind: {
    width: 58,
    opacity: 0.7,
    fontSize: 12,
  },
  itemMain: {
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: 3,
  },
  label: {
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  meta: {
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    opacity: 0.58,
    fontSize: 12,
  },
  error: {
    padding: "10px 12px",
    color: "#ffb4ab",
  },
};
