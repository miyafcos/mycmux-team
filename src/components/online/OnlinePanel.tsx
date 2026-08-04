import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, GripVertical, Inbox, Pin, RefreshCw, Trash2 } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import {
  cleanupOnlineSavepoints,
  joinSavepointFull,
  joinSavepointSummary,
  listOnlineSavepoints,
  listTrashedOnlineSavepoints,
  toggleSavepointPin,
} from "../../lib/ipc";
import { useWorkspaceLayoutStore } from "../../stores/workspaceLayoutStore";
import { useWorkspaceListStore } from "../../stores/workspaceListStore";
import { usePaneMetadataStore } from "../../stores/paneMetadataStore";
import { useOnlineSavepointStore } from "../../stores/onlineSavepointStore";
import { deriveEffectiveStatus } from "../../lib/notificationStatus";
import { focusController } from "../../lib/focusController";
import { onlineStrings } from "./onlineStrings";
import {
  collectOpenAgentSessions,
  collectOpenAgentIdentityKeys,
  deleteSavepoint,
  filterAndSortSavepoints,
  formatUpdatedAgo,
  isClosedSavepoint,
  isCurrentSavepoint,
  isFinalSavepoint,
  isTrashedSavepoint,
  isExpiringSoon,
  purgeSavepoint,
  projectNameFromCwd,
  restoreSavepoint,
  savepointAgentKind,
  savepointEntryIdentityKey,
  savepointIdentityKey,
  savepointSessionId,
  type OnlineSavepointEntry,
  type OpenAgentSession,
  type SavepointListView,
} from "./onlineSavepoints";
import { PublishProgress } from "./PublishProgress";
import { useSavepointDragSource } from "../../hooks/useSavepointDragSource";
import { buildSavepointHandoffLaunchEnv } from "../../lib/savepointHandoff";
import {
  chooseAndReceiveSavepointTransfer,
  SAVEPOINT_RECEIVED_EVENT,
  shareSavepointTransfer,
} from "../../lib/savepointTransfer";
import { useSavepointDragStore } from "../../stores/savepointDragStore";
import { useSavepointPublish } from "../../hooks/useSavepointPublish";

interface OnlinePanelProps {
  workspaceId: string;
  paneId: string;
}

const LOCAL_SESSIONS_COLLAPSED_STORAGE_KEY = "mycmux:onlinePanel:localSessionsCollapsed";

// Default collapsed (only an explicit "0" from a prior session reopens it).
function readLocalSessionsCollapsed(): boolean {
  try {
    return window.localStorage.getItem(LOCAL_SESSIONS_COLLAPSED_STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

function SavepointTransferDropTarget() {
  const dragging = useSavepointDragStore((state) => state.item !== null);
  const active = useSavepointDragStore((state) => state.target?.mode === "export");
  if (!dragging) return null;

  return (
    <div
      data-savepoint-export-target="true"
      role="status"
      style={{
        ...styles.transferDropTarget,
        ...(active ? styles.transferDropTargetActive : {}),
      }}
    >
      <strong style={styles.transferDropTitle}>{onlineStrings.shareTransferDrop}</strong>
      <span style={styles.transferDropHint}>{onlineStrings.shareTransferDropHint}</span>
    </div>
  );
}

export default function OnlinePanel({ workspaceId, paneId }: OnlinePanelProps) {
  const [entries, setEntries] = useState<OnlineSavepointEntry[]>([]);
  const [view, setView] = useState<SavepointListView>("active");
  const [query, setQuery] = useState("");
  const [selectedBundle, setSelectedBundle] = useState<string | null>(null);
  const [armedDeleteBundle, setArmedDeleteBundle] = useState<string | null>(null);
  const [deletingBundle, setDeletingBundle] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joinNotice, setJoinNotice] = useState<string | null>(null);
  const [cwdNotice, setCwdNotice] = useState<string | null>(null);
  const [cleanupNotice, setCleanupNotice] = useState<string | null>(null);
  const [receivingTransfer, setReceivingTransfer] = useState(false);
  const [sharingBundle, setSharingBundle] = useState<string | null>(null);
  const {
    stateByIdentity: localPublishBySession,
    run: runSavepointPublish,
  } = useSavepointPublish({ mode: "keyed" });
  const [localSessionsCollapsed, setLocalSessionsCollapsed] = useState<boolean>(readLocalSessionsCollapsed);
  const loadGenerationRef = useRef(0);
  const { beginPointerDrag, shouldSuppressClick } = useSavepointDragSource();
  const addPaneToWorkspaceWithOptions = useWorkspaceLayoutStore(
    (state) => state.addPaneToWorkspaceWithOptions,
  );
  const setActivePaneTab = useWorkspaceLayoutStore((state) => state.setActivePaneTab);
  const workspaces = useWorkspaceListStore((state) => state.workspaces);
  const metadataBySession = usePaneMetadataStore((state) => state.metadata);
  const publishedSessionIds = useOnlineSavepointStore((state) => state.publishedSessionIds);
  const openAgentIdentityKeys = useMemo(
    () => collectOpenAgentIdentityKeys(workspaces, metadataBySession),
    [metadataBySession, workspaces],
  );
  const openAgentSessions = useMemo(
    () => collectOpenAgentSessions(workspaces, metadataBySession),
    [metadataBySession, workspaces],
  );
  const openAgentTerminalSessionIds = useMemo(
    () => openAgentSessions.map((session) => session.terminalSessionId),
    [openAgentSessions],
  );
  const openAgentSessionLastLogLines = usePaneMetadataStore(useShallow(
    (state) => localSessionsCollapsed
      ? []
      : openAgentTerminalSessionIds.map((sessionId) => state.lastLog[sessionId]),
  ));
  const lastPublishedBySessionId = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of entries) {
      if (!isTrashedSavepoint(entry)) map.set(savepointEntryIdentityKey(entry), entry.updated_at);
    }
    return map;
  }, [entries]);
  const localSessionStatusCounts = useMemo(() => {
    let working = 0;
    let waiting = 0;
    for (const session of openAgentSessions) {
      if (session.status === "dormant") continue;
      const status = deriveEffectiveStatus(metadataBySession[session.terminalSessionId]);
      if (status === "working") working += 1;
      else if (status === "waiting") waiting += 1;
    }
    return { working, waiting };
  }, [openAgentSessions, metadataBySession]);

  const toggleLocalSessionsCollapsed = useCallback(() => {
    setLocalSessionsCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(LOCAL_SESSIONS_COLLAPSED_STORAGE_KEY, next ? "1" : "0");
      } catch {
        // Private mode / quota errors: collapse state just won't persist.
      }
      return next;
    });
  }, []);

  const openLocalSession = useCallback((session: OpenAgentSession) => {
    if (session.status === "dormant" || !session.tabId) return;
    if (session.workspaceId && useWorkspaceListStore.getState().activeWorkspaceId !== session.workspaceId) {
      useWorkspaceListStore.getState().setActiveWorkspace(session.workspaceId);
    }
    if (session.workspaceId && session.paneId) {
      setActivePaneTab(session.workspaceId, session.paneId, session.tabId);
    }
    focusController.request("programmatic", { sessionId: session.terminalSessionId, focus: true });
  }, [setActivePaneTab]);

  const load = useCallback(async () => {
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    setError(null);
    try {
      try {
        const cleanup = await cleanupOnlineSavepoints();
        if (generation === loadGenerationRef.current && cleanup.deleted_count > 0) {
          setCleanupNotice(onlineStrings.cleanupDone);
        }
      } catch (cleanupError) {
        console.warn("[mycmux] failed to clean online savepoints", cleanupError);
      }
      const [activeResult, trashResult] = await Promise.allSettled([
        listOnlineSavepoints(),
        listTrashedOnlineSavepoints(),
      ]);
      if (generation !== loadGenerationRef.current) return;
      const activeEntries = activeResult.status === "fulfilled" ? activeResult.value : null;
      const trashedEntries = trashResult.status === "fulfilled" ? trashResult.value : null;
      setEntries((current) => [
        ...(activeEntries ?? current.filter((entry) => !isTrashedSavepoint(entry))),
        ...(trashedEntries ?? current.filter(isTrashedSavepoint)),
      ]);
      if (activeEntries) {
        useOnlineSavepointStore.getState().setFromEntries(activeEntries);
      } else if (activeResult.status === "rejected") {
        console.error("[mycmux] failed to load active online savepoints", activeResult.reason);
      }
      if (!trashedEntries && trashResult.status === "rejected") {
        console.error("[mycmux] failed to load trashed online savepoints", trashResult.reason);
      }
      if (!activeEntries || !trashedEntries) {
        setError(activeEntries ? onlineStrings.trashLoadError : onlineStrings.loadError);
      }
    } catch (loadError) {
      if (generation !== loadGenerationRef.current) return;
      console.error("[mycmux] failed to load online savepoints", loadError);
      setError(onlineStrings.loadError);
    } finally {
      if (generation === loadGenerationRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!cleanupNotice) return;
    const timeout = window.setTimeout(() => setCleanupNotice(null), 3000);
    return () => window.clearTimeout(timeout);
  }, [cleanupNotice]);

  useEffect(() => {
    if (!armedDeleteBundle) return;
    const timeout = window.setTimeout(() => setArmedDeleteBundle(null), 4000);
    return () => window.clearTimeout(timeout);
  }, [armedDeleteBundle]);

  useEffect(() => {
    void load();
    const onWorkspaceVisibility = (event: Event) => {
      const detail = (event as CustomEvent<{ activeWorkspaceId?: string | null }>).detail;
      if (detail?.activeWorkspaceId === workspaceId) void load();
    };
    const onDocumentVisibility = () => {
      if (document.visibilityState === "visible") void load();
    };
    const onSavepointPublished = () => {
      void load();
    };
    window.addEventListener("mycmux:workspace-visibility-change", onWorkspaceVisibility);
    window.addEventListener("mycmux:savepoint-published", onSavepointPublished);
    window.addEventListener(SAVEPOINT_RECEIVED_EVENT, onSavepointPublished);
    document.addEventListener("visibilitychange", onDocumentVisibility);
    return () => {
      window.removeEventListener("mycmux:workspace-visibility-change", onWorkspaceVisibility);
      window.removeEventListener("mycmux:savepoint-published", onSavepointPublished);
      window.removeEventListener(SAVEPOINT_RECEIVED_EVENT, onSavepointPublished);
      document.removeEventListener("visibilitychange", onDocumentVisibility);
    };
  }, [load, workspaceId]);

  const activeCount = useMemo(
    () => entries.filter((entry) => !isTrashedSavepoint(entry)).length,
    [entries],
  );
  const trashCount = entries.length - activeCount;
  const visibleEntries = useMemo(
    () => filterAndSortSavepoints(entries, query, view),
    [entries, query, view],
  );

  const publishLocalSession = useCallback(async (session: OpenAgentSession) => {
    const agentSessionId = session.agentSessionId;
    if (!agentSessionId) return;
    setError(null);
    const outcome = await runSavepointPublish({
      cwd: session.cwd,
      agentKind: session.agentKind,
      agentSessionId,
    });
    if (outcome.ok) {
      await load();
    } else {
      setError(onlineStrings.publishErrorPrefix + String(outcome.error));
    }
  }, [load, runSavepointPublish]);

  const handoffSummary = useCallback(async (
    entry: OnlineSavepointEntry,
    targetKind: "claude" | "codex",
  ) => {
    setError(null);
    setJoinNotice(null);
    setCwdNotice(null);
    try {
      const target = await joinSavepointSummary(entry.bundle_dir);
      if (target.cwd_missing) {
        setCwdNotice(onlineStrings.joinCwdMissing);
      }
      addPaneToWorkspaceWithOptions(workspaceId, paneId, "right", {
        agentId: "shell-starter",
        label: entry.summary_line,
        cwd: target.resolved_cwd,
        launchEnv: buildSavepointHandoffLaunchEnv(
          targetKind,
          savepointSessionId(entry),
          target.handoff_path,
          savepointAgentKind(entry),
        ),
      });
    } catch (joinError) {
      console.error("[mycmux] failed to join online savepoint", joinError);
      setError(onlineStrings.loadError);
    }
  }, [addPaneToWorkspaceWithOptions, paneId, workspaceId]);

  const joinFull = useCallback(async (entry: OnlineSavepointEntry) => {
    setError(null);
    setJoinNotice(onlineStrings.joinFullNotice);
    setCwdNotice(null);
    try {
      const target = await joinSavepointFull(entry.bundle_dir);
      if (target.cwd_missing) {
        setCwdNotice(onlineStrings.joinCwdMissing);
      }
      addPaneToWorkspaceWithOptions(workspaceId, paneId, "right", {
        agentId: target.agent_kind === "codex" ? "codex" : "claude-code",
        label: entry.summary_line,
        cwd: target.resolved_cwd,
        commandArgv: target.command_argv,
      });
    } catch (joinError) {
      console.error("[mycmux] failed to fully join online savepoint", joinError);
      setJoinNotice(null);
      setError(onlineStrings.loadError);
    }
  }, [addPaneToWorkspaceWithOptions, paneId, workspaceId]);

  const togglePin = useCallback(async (entry: OnlineSavepointEntry) => {
    setError(null);
    try {
      const result = await toggleSavepointPin(entry.bundle_dir);
      setEntries((current) => current.map((candidate) =>
        candidate.bundle_dir === entry.bundle_dir
          ? { ...candidate, pinned: result.pinned }
          : candidate,
      ));
    } catch (toggleError) {
      console.error("[mycmux] failed to toggle online savepoint pin", toggleError);
      setError(onlineStrings.loadError);
    }
  }, []);

  const moveEntryToTrash = useCallback(async (entry: OnlineSavepointEntry) => {
    setDeletingBundle(entry.bundle_dir);
    setError(null);
    try {
      await deleteSavepoint(entry.bundle_dir);
      setSelectedBundle((current) => current === entry.bundle_dir ? null : current);
      setCleanupNotice(onlineStrings.movedToTrash);
      await load();
    } catch (deleteError) {
      console.error("[mycmux] failed to move online savepoint to trash", deleteError);
      setError(onlineStrings.moveToTrashErrorPrefix + String(deleteError));
    } finally {
      setDeletingBundle(null);
    }
  }, [load]);

  const restoreEntry = useCallback(async (entry: OnlineSavepointEntry) => {
    if (!entry.trash_id) return;
    setDeletingBundle(entry.bundle_dir);
    setError(null);
    try {
      await restoreSavepoint(entry.bundle_dir, entry.trash_id);
      setSelectedBundle(null);
      setArmedDeleteBundle(null);
      setCleanupNotice(onlineStrings.restoreDone);
      await load();
    } catch (restoreError) {
      console.error("[mycmux] failed to restore online savepoint", restoreError);
      setError(onlineStrings.restoreErrorPrefix + String(restoreError));
    } finally {
      setDeletingBundle(null);
    }
  }, [load]);

  const purgeEntry = useCallback(async (entry: OnlineSavepointEntry) => {
    if (!entry.trash_id) return;
    if (armedDeleteBundle !== entry.bundle_dir) {
      setArmedDeleteBundle(entry.bundle_dir);
      return;
    }
    setArmedDeleteBundle(null);
    setDeletingBundle(entry.bundle_dir);
    setError(null);
    try {
      await purgeSavepoint(entry.bundle_dir, entry.trash_id);
      setSelectedBundle(null);
      setCleanupNotice(onlineStrings.deletePermanentlyDone);
      await load();
    } catch (deleteError) {
      console.error("[mycmux] failed to permanently delete online savepoint", deleteError);
      setError(onlineStrings.deletePermanentlyErrorPrefix + String(deleteError));
    } finally {
      setDeletingBundle(null);
    }
  }, [armedDeleteBundle, load]);

  const receiveTransfer = useCallback(async () => {
    setReceivingTransfer(true);
    setError(null);
    try {
      const result = await chooseAndReceiveSavepointTransfer();
      if (result) {
        setCleanupNotice(
          result.imported
            ? onlineStrings.transferReceived
            : onlineStrings.transferAlreadyReceived,
        );
      }
    } catch (receiveError) {
      console.error("[mycmux] failed to receive savepoint transfer", receiveError);
      setError(onlineStrings.transferReceiveErrorPrefix + String(receiveError));
    } finally {
      setReceivingTransfer(false);
    }
  }, []);

  const shareTransfer = useCallback(async (entry: OnlineSavepointEntry) => {
    setSharingBundle(entry.bundle_dir);
    setError(null);
    try {
      const result = await shareSavepointTransfer(entry.bundle_dir, entry.summary_line);
      if (result) setCleanupNotice(onlineStrings.transferSaved);
    } catch (shareError) {
      console.error("[mycmux] failed to share savepoint transfer", shareError);
      setError(onlineStrings.transferSaveErrorPrefix + String(shareError));
    } finally {
      setSharingBundle(null);
    }
  }, []);

  return (
    <div
      className="online-panel"
      data-savepoint-drop-cancel="true"
      data-savepoint-transfer-drop="true"
      style={styles.root}
    >
      <style>{onlinePanelHoverCss}</style>
      <div style={styles.toolbar}>
        <h2 className="online-panel-heading" style={styles.heading}>{onlineStrings.panelTitle}</h2>
        <div style={styles.toolbarActions}>
          <button
            type="button"
            className="online-toolbar-button"
            style={styles.receiveButton}
            onClick={() => void receiveTransfer()}
            disabled={receivingTransfer}
            title={onlineStrings.receiveTransferHint}
            aria-label={onlineStrings.receiveTransfer}
          >
            <Inbox className="online-toolbar-button-icon" size={14} strokeWidth={1.8} aria-hidden="true" />
            <span className="online-toolbar-button-label">{onlineStrings.receiveTransfer}</span>
          </button>
          <button
            type="button"
            className="online-toolbar-button"
            style={styles.refreshButton}
            onClick={() => void load()}
            disabled={loading}
            title={onlineStrings.refresh}
            aria-label={onlineStrings.refresh}
          >
            <RefreshCw className="online-toolbar-button-icon" size={14} strokeWidth={1.8} aria-hidden="true" />
            <span className="online-toolbar-button-label">{onlineStrings.refresh}</span>
          </button>
        </div>
      </div>
      <div style={styles.description}>
        {view === "active" ? onlineStrings.panelDescription : onlineStrings.trashDescription}
      </div>
      <div role="group" aria-label={onlineStrings.viewSwitcherLabel} style={styles.viewTabs}>
        <button
          type="button"
          className="online-view-button"
          aria-pressed={view === "active"}
          style={{ ...styles.viewButton, ...(view === "active" ? styles.viewButtonActive : {}) }}
          onClick={() => {
            setView("active");
            setSelectedBundle(null);
            setArmedDeleteBundle(null);
          }}
        >
          {onlineStrings.activeView(activeCount)}
        </button>
        <button
          type="button"
          className="online-view-button"
          aria-pressed={view === "trash"}
          style={{ ...styles.viewButton, ...(view === "trash" ? styles.viewButtonActive : {}) }}
          onClick={() => {
            setView("trash");
            setSelectedBundle(null);
            setArmedDeleteBundle(null);
          }}
        >
          {onlineStrings.trashView(trashCount)}
        </button>
      </div>
      {view === "active" && <div style={styles.dragHint}>{onlineStrings.dragHint}</div>}
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={onlineStrings.searchPlaceholder}
        aria-label={onlineStrings.searchPlaceholder}
        style={styles.search}
      />
      {error && <div style={styles.error}>{error}</div>}
      {joinNotice && <div style={styles.notice}>{joinNotice}</div>}
      {cwdNotice && <div style={styles.notice}>{cwdNotice}</div>}
      {cleanupNotice && <div style={styles.notice}>{cleanupNotice}</div>}
      <div className="online-savepoint-list" style={styles.list}>
        {!loading && visibleEntries.length === 0 && (
          <div style={styles.empty}>
            {view === "trash" ? onlineStrings.trashEmpty : onlineStrings.emptyList}
          </div>
        )}
        {visibleEntries.map((entry) => {
          const trashed = isTrashedSavepoint(entry);
          const expanded = selectedBundle === entry.bundle_dir;
          const finalRecord = isFinalSavepoint(entry);
          const closedRecord = isClosedSavepoint(entry);
          const projectName = projectNameFromCwd(entry.cwd);
          const ownerLabel = `${entry.author} · ${entry.machine}`;
          const detailsId = `online-savepoint-details-${(
            entry.trash_id ?? entry.checkpoint_id ?? savepointSessionId(entry)
          ).replace(/[^A-Za-z0-9_-]/g, "-")}`;
          const recordBadgeStyle = finalRecord
            ? styles.recordFinalBadge
            : (closedRecord ? styles.recordClosedBadge : styles.recordCurrentBadge);
          const recordBadgeLabel = finalRecord
            ? onlineStrings.recordFinalBadge
            : (closedRecord ? onlineStrings.recordClosedBadge : onlineStrings.recordCurrentBadge);
          const recordRailColor = finalRecord
            ? "var(--cmux-yellow)"
            : (closedRecord ? "var(--cmux-text-dim)" : "var(--cmux-accent)");
          return (
            <article
              key={entry.bundle_dir}
              className="online-sp-card"
              style={{
                ...styles.card,
                ...(trashed ? styles.trashCard : {}),
                ...(expanded ? styles.cardSelected : {}),
                borderLeftColor: recordRailColor,
              }}
              onPointerDown={trashed ? undefined : (event) => beginPointerDrag(event, {
                kind: "savepoint",
                sourceWorkspaceId: workspaceId,
                bundleDir: entry.bundle_dir,
                label: entry.summary_line,
                sourceSessionId: savepointSessionId(entry),
                sourceAgentKind: savepointAgentKind(entry),
                checkpointId: entry.checkpoint_id,
              })}
              onClick={(event) => {
                if (shouldSuppressClick()) {
                  event.preventDefault();
                  return;
                }
                setSelectedBundle(expanded ? null : entry.bundle_dir);
              }}
            >
              <div style={styles.cardTopLine}>
                {!trashed && (
                  <button
                     type="button"
                     className="online-drag-handle"
                     data-savepoint-drag-handle="true"
                     aria-label={onlineStrings.dragHandleLabel(entry.summary_line)}
                    title={onlineStrings.dragHandleLabel(entry.summary_line)}
                    style={styles.dragHandle}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (shouldSuppressClick()) {
                        event.preventDefault();
                        return;
                      }
                      setSelectedBundle(expanded ? null : entry.bundle_dir);
                    }}
                  >
                    <GripVertical size={14} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                )}
                <div style={styles.cardIdentity}>
                  <strong
                    className="online-sp-card-project"
                    style={styles.project}
                    title={projectName}
                  >
                    {projectName}
                  </strong>
                  <span
                    className="online-sp-card-owner"
                    style={styles.owner}
                    title={ownerLabel}
                  >
                    {entry.author}
                    <span className="online-sp-card-machine" style={styles.machine}> · {entry.machine}</span>
                  </span>
                </div>
                <span style={styles.updated}>
                  {trashed && entry.deleted_at
                    ? onlineStrings.deletedAgo(formatUpdatedAgo(entry.deleted_at))
                    : formatUpdatedAgo(entry.updated_at)}
                </span>
              </div>
              <div
                className="online-sp-card-summary"
                style={styles.summary}
                title={entry.summary_line}
              >
                {entry.summary_line}
              </div>
              <div style={styles.cardFooter}>
                <div className="online-sp-card-flags" style={styles.metaRow}>
                  <span style={recordBadgeStyle}>{recordBadgeLabel}</span>
                  {entry.received && (
                    <span style={styles.receivedBadge}>{onlineStrings.receivedBadge}</span>
                  )}
                  {entry.warnings_count > 0 && (
                    <span style={styles.warningBadge}>
                      {onlineStrings.warningBadge} {entry.warnings_count}
                    </span>
                  )}
                  {!trashed && isExpiringSoon(entry.expires_at) && (
                    <span className="online-sp-card-optional-flag" style={styles.warningBadge}>
                      {onlineStrings.expiresSoon}
                    </span>
                  )}
                  {!trashed && isCurrentSavepoint(entry) && openAgentIdentityKeys.has(savepointEntryIdentityKey(entry)) && (
                    <span className="online-sp-card-optional-flag" style={styles.openHereBadge}>
                      {onlineStrings.badgeOpenHere}
                    </span>
                  )}
                </div>
                <div style={styles.quickActions} onClick={(event) => event.stopPropagation()}>
                  {!trashed && (
                    <>
                      <button
                        type="button"
                        className="online-icon-button"
                        aria-label={entry.pinned ? onlineStrings.pinOff : onlineStrings.pinOn}
                        title={entry.pinned ? onlineStrings.pinOff : onlineStrings.pinOn}
                        style={{
                          ...styles.iconButton,
                          ...(entry.pinned ? styles.pinIconButtonActive : {}),
                        }}
                        disabled={deletingBundle === entry.bundle_dir}
                        onClick={(event) => {
                          event.stopPropagation();
                          void togglePin(entry);
                        }}
                      >
                        <Pin
                          size={13}
                          strokeWidth={1.8}
                          fill={entry.pinned ? "currentColor" : "none"}
                          aria-hidden="true"
                        />
                      </button>
                      <button
                        type="button"
                        className="online-icon-button online-icon-button--danger"
                        aria-label={onlineStrings.moveToTrash}
                        title={onlineStrings.moveToTrash}
                        style={{ ...styles.iconButton, ...styles.dangerIconButton }}
                        disabled={deletingBundle === entry.bundle_dir}
                        onClick={(event) => {
                          event.stopPropagation();
                          void moveEntryToTrash(entry);
                        }}
                      >
                        <Trash2 size={13} strokeWidth={1.8} aria-hidden="true" />
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="online-sp-card-disclosure"
                    data-dnd-ignore="true"
                    aria-expanded={expanded}
                    aria-controls={detailsId}
                    aria-label={expanded ? onlineStrings.collapseCardDetails : onlineStrings.expandCardDetails}
                    title={expanded ? onlineStrings.collapseCardDetails : onlineStrings.expandCardDetails}
                    style={styles.iconButton}
                    onClick={(event) => {
                      event.stopPropagation();
                      setSelectedBundle(expanded ? null : entry.bundle_dir);
                    }}
                  >
                    <ChevronDown size={14} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                </div>
              </div>
              {expanded && (
                <div
                  id={detailsId}
                  className="online-sp-card-details"
                  style={styles.expandedPanel}
                  onClick={(event) => event.stopPropagation()}
                >
                  <div style={styles.expandedMetaRow}>
                    <span style={styles.sessionId} title={savepointSessionId(entry)}>
                      {onlineStrings.sessionIdPrefix}{savepointSessionId(entry).slice(0, 8)}
                    </span>
                    <span style={styles.fileCount}>
                      {entry.files_written_count} {onlineStrings.filesSuffix}
                    </span>
                  </div>
                  {trashed ? (
                    <div style={styles.trashActions}>
                      <button
                        type="button"
                        className="online-action-button online-action-button--secondary"
                        style={styles.secondaryButton}
                        disabled={deletingBundle === entry.bundle_dir}
                        onClick={() => void restoreEntry(entry)}
                      >
                        {onlineStrings.restore}
                      </button>
                      <button
                        type="button"
                        className="online-action-button online-action-button--danger"
                        style={{
                          ...styles.deleteActionButton,
                          ...(armedDeleteBundle === entry.bundle_dir ? styles.deleteButtonArmed : {}),
                        }}
                        disabled={deletingBundle === entry.bundle_dir}
                        onClick={() => void purgeEntry(entry)}
                      >
                        {armedDeleteBundle === entry.bundle_dir
                          ? onlineStrings.deletePermanentlyConfirm
                          : onlineStrings.deletePermanently}
                      </button>
                    </div>
                  ) : (
                    <div style={styles.actions}>
                      <button
                        type="button"
                        className="online-action-button online-action-button--primary"
                        style={styles.primaryButton}
                        onClick={() => void handoffSummary(entry, "claude")}
                      >
                        {onlineStrings.joinSummary}
                      </button>
                      <button
                        type="button"
                        className="online-action-button online-action-button--secondary"
                        style={styles.secondaryButton}
                        onClick={() => void handoffSummary(entry, "codex")}
                      >
                        {onlineStrings.joinCodex}
                      </button>
                      <button
                        type="button"
                        className="online-action-button online-action-button--secondary"
                        style={styles.secondaryButton}
                        title={onlineStrings.joinFullNotice}
                        onClick={() => void joinFull(entry)}
                      >
                        {onlineStrings.joinFull}
                      </button>
                      <button
                        type="button"
                        className="online-action-button online-action-button--secondary"
                        style={styles.secondaryButton}
                        disabled={sharingBundle === entry.bundle_dir}
                        onClick={() => void shareTransfer(entry)}
                      >
                        {onlineStrings.shareTransfer}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
      {view === "active" && <section
        style={{
          ...styles.localFooter,
          ...(localSessionsCollapsed ? {} : styles.localFooterExpanded),
        }}
      >
        <button
          type="button"
          className="online-local-footer-header"
          aria-expanded={!localSessionsCollapsed}
          aria-label={onlineStrings.panelLocalSessionsToggleAriaLabel}
          style={styles.localFooterHeader}
          onClick={toggleLocalSessionsCollapsed}
        >
          <span style={styles.localFooterChevron}>{localSessionsCollapsed ? "▸" : "▾"}</span>
          <span style={styles.localFooterTitle}>{onlineStrings.panelLocalSessionsHeaderTitle}</span>
          {openAgentSessions.length > 0 && (
            <span style={styles.localSessionsCount}>{openAgentSessions.length}</span>
          )}
          {localSessionStatusCounts.working > 0 && (
            <span
              style={styles.localFooterStatusGroup}
              title={onlineStrings.panelLocalSessionsWorkingCountTitle(localSessionStatusCounts.working)}
            >
              <span style={styles.statusDotWorking} />
              {localSessionStatusCounts.working}
            </span>
          )}
          {localSessionStatusCounts.waiting > 0 && (
            <span
              style={styles.localFooterStatusGroup}
              title={onlineStrings.panelLocalSessionsWaitingCountTitle(localSessionStatusCounts.waiting)}
            >
              <span style={styles.statusDotWaiting} />
              {localSessionStatusCounts.waiting}
            </span>
          )}
        </button>
        {!localSessionsCollapsed && (
          <div style={styles.localFooterBody}>
            <span style={styles.localSessionsHint}>{onlineStrings.panelLocalSessionsHint}</span>
            {openAgentSessions.length === 0 ? (
              <div style={styles.localSessionsEmpty}>{onlineStrings.panelLocalSessionsEmpty}</div>
            ) : (
              <div style={styles.localSessionsList}>
                {openAgentSessions.map((session, sessionIndex) => {
                  const agentSessionId = session.agentSessionId;
                  const identity = agentSessionId
                    ? savepointIdentityKey(session.agentKind, agentSessionId)
                    : null;
                  const publishState = identity ? localPublishBySession[identity] : undefined;
                  const publishing = publishState?.publishing === true;
                  const published = identity ? publishedSessionIds[identity] === true : false;
                  const dormant = session.status === "dormant";
                  const agentStatus = dormant
                    ? "idle"
                    : deriveEffectiveStatus(metadataBySession[session.terminalSessionId]);
                  const lastPublishedAt = identity
                    ? lastPublishedBySessionId.get(identity)
                    : undefined;
                  const lastLogLine = openAgentSessionLastLogLines[sessionIndex];
                  const jumpable = !dormant && Boolean(session.tabId);
                  return (
                    <div
                      key={session.terminalSessionId}
                      className={jumpable ? "online-session-row online-session-row--clickable" : "online-session-row"}
                      style={{
                        ...styles.localSessionRow,
                        ...(published ? styles.localSessionRowPublished : {}),
                        ...(dormant ? styles.localSessionRowDormant : {}),
                        ...(jumpable ? styles.localSessionRowClickable : {}),
                      }}
                      title={jumpable
                        ? onlineStrings.panelLocalSessionsCardOpenHint
                        : (dormant ? onlineStrings.panelLocalSessionsCardOpenUnavailable : undefined)}
                      onClick={jumpable ? () => openLocalSession(session) : undefined}
                      role={jumpable ? "button" : undefined}
                      tabIndex={jumpable ? 0 : undefined}
                      onKeyDown={jumpable
                        ? (event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            openLocalSession(session);
                          }
                        }
                        : undefined}
                    >
                      <div style={styles.localSessionMain}>
                        <div style={styles.localSessionTitleLine}>
                          {agentStatus === "working" && (
                            <span title={onlineStrings.statusWorking} style={styles.statusDotWorking} />
                          )}
                          {agentStatus === "waiting" && (
                            <span title={onlineStrings.statusWaiting} style={styles.statusDotWaiting} />
                          )}
                          {agentStatus === "idle" && !dormant && (
                            <span title={onlineStrings.statusIdle} style={styles.statusDotIdle} />
                          )}
                          <strong style={styles.localSessionTitle} title={session.cwd}>
                            {session.title}
                          </strong>
                          {dormant && (
                            <span style={styles.dormantBadge} title={onlineStrings.badgeDormantHint}>
                              {onlineStrings.badgeDormant}
                            </span>
                          )}
                          <span style={lastPublishedAt ? styles.savedChipPublished : styles.savedChip}>
                            {lastPublishedAt
                              ? `${onlineStrings.lastPublishedPrefix}${formatUpdatedAgo(lastPublishedAt)}`
                              : onlineStrings.notPublishedYet}
                          </span>
                        </div>
                        <div style={styles.localSessionMetaLine}>
                          {session.workspaceName && (
                            <span title={onlineStrings.workspaceTitle} style={styles.metaItem}>
                              {session.workspaceName}
                            </span>
                          )}
                          <span title={session.cwd} style={styles.metaItem}>
                            {projectNameFromCwd(session.cwd)}
                          </span>
                          {session.gitBranch && (
                            <span title={onlineStrings.branchTitle} style={styles.metaItemMono}>
                              ⎇ {session.gitBranch}
                            </span>
                          )}
                          <span title={agentSessionId} style={styles.metaItemMono}>
                            {agentSessionId
                              ? `${onlineStrings.sessionIdPrefix}${agentSessionId.slice(0, 8)}`
                              : onlineStrings.panelSessionNoId}
                          </span>
                        </div>
                        {lastLogLine && (
                          <div style={styles.localSessionLogLine} title={lastLogLine}>
                            {lastLogLine}
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        className="online-local-publish-button"
                        style={{
                          ...styles.localPublishButton,
                          ...((!agentSessionId || publishing) ? styles.localPublishButtonDisabled : {}),
                        }}
                        disabled={!agentSessionId || publishing}
                        title={agentSessionId
                          ? (dormant ? onlineStrings.badgeDormantHint : undefined)
                          : onlineStrings.panelSessionNoId}
                        onClick={(event) => {
                          event.stopPropagation();
                          void publishLocalSession(session);
                        }}
                      >
                        {publishing
                          ? onlineStrings.publishInProgress
                          : (published ? onlineStrings.panelPublishButtonUpdate : onlineStrings.panelPublishButton)}
                      </button>
                      <div style={styles.localPublishProgress} onClick={(event) => event.stopPropagation()}>
                        <PublishProgress
                          publishing={publishing}
                          stage={publishState?.stage ?? null}
                          result={publishState?.result ?? null}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </section>}
      <SavepointTransferDropTarget />
    </div>
  );
}

// Hover micro-interactions need real CSS (:hover / reduced-motion); everything
// else stays in the inline style objects below.
const onlinePanelHoverCss = `
.online-panel {
  container-type: inline-size;
}
.online-toolbar-button-icon {
  display: none;
}
.online-savepoint-list {
  container-type: inline-size;
}
.online-session-row, .online-sp-card {
  transition: transform var(--cmux-motion-fast) var(--cmux-ease), border-color var(--cmux-motion-fast) var(--cmux-ease), box-shadow var(--cmux-motion-fast) var(--cmux-ease);
}
.online-session-row--clickable:hover {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--cmux-accent) 45%, var(--cmux-border));
  box-shadow: 0 3px 10px color-mix(in srgb, var(--cmux-accent) 12%, transparent);
}
.online-sp-card:hover {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--cmux-accent) 32%, var(--cmux-border));
  box-shadow: 0 4px 14px color-mix(in srgb, var(--cmux-text) 10%, transparent);
}
.online-sp-card-project,
.online-sp-card-owner {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.online-sp-card-summary {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.online-sp-card-flags {
  min-width: 0;
  overflow: hidden;
}
.online-sp-card-flags > span {
  flex-shrink: 0;
  white-space: nowrap;
}
.online-sp-card-disclosure svg {
  transition: transform var(--cmux-motion-fast) var(--cmux-ease);
}
.online-sp-card-disclosure[aria-expanded="true"] svg {
  transform: rotate(180deg);
}
.online-toolbar-button,
.online-view-button,
.online-local-footer-header,
.online-drag-handle,
.online-icon-button,
.online-sp-card-disclosure,
.online-action-button,
.online-local-publish-button {
  transition: transform var(--cmux-motion-fast) var(--cmux-ease), background var(--cmux-motion-fast) var(--cmux-ease), color var(--cmux-motion-fast) var(--cmux-ease), border-color var(--cmux-motion-fast) var(--cmux-ease), box-shadow var(--cmux-motion-fast) var(--cmux-ease);
}
.online-toolbar-button:hover:not(:disabled),
.online-action-button--primary:hover:not(:disabled),
.online-local-publish-button:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 3px 10px color-mix(in srgb, var(--cmux-accent) 18%, transparent);
}
.online-view-button:hover:not([aria-pressed="true"]),
.online-local-footer-header:hover,
.online-drag-handle:hover,
.online-icon-button:hover:not(:disabled),
.online-sp-card-disclosure:hover:not(:disabled),
.online-action-button--secondary:hover:not(:disabled) {
  background: var(--cmux-hover) !important;
  color: var(--cmux-text) !important;
}
.online-icon-button--danger:hover:not(:disabled),
.online-action-button--danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--cmux-red) 12%, transparent) !important;
  border-color: var(--cmux-red) !important;
}
.online-view-button:active:not(:disabled),
.online-icon-button:active:not(:disabled),
.online-action-button:active:not(:disabled),
.online-toolbar-button:active:not(:disabled),
.online-local-publish-button:active:not(:disabled) {
  transform: scale(0.97);
}
@container (max-width: 340px) {
  .online-panel-heading {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .online-toolbar-button {
    width: 30px;
    height: 30px;
    padding: 0 !important;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .online-toolbar-button-icon {
    display: block;
  }
  .online-toolbar-button-label {
    display: none;
  }
  .online-sp-card-summary {
    -webkit-line-clamp: 1;
  }
  .online-sp-card-machine,
  .online-sp-card-optional-flag {
    display: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .online-session-row,
  .online-sp-card,
  .online-toolbar-button,
  .online-view-button,
  .online-local-footer-header,
  .online-drag-handle,
  .online-icon-button,
  .online-action-button,
  .online-local-publish-button { transition: none; }
  .online-session-row--clickable:hover,
  .online-sp-card:hover,
  .online-toolbar-button:hover:not(:disabled),
  .online-action-button--primary:hover:not(:disabled),
  .online-local-publish-button:hover:not(:disabled) { transform: none; }
  .online-sp-card-disclosure svg { transition: none; }
}
`;

const styles: Record<string, React.CSSProperties> = {
  root: {
    position: "relative",
    height: "100%",
    display: "flex",
    flexDirection: "column",
    gap: 10,
    padding: 12,
    color: "var(--cmux-text)",
    background: "color-mix(in srgb, var(--cmux-bg) 88%, transparent)",
    overflow: "hidden",
  },
  toolbar: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 },
  toolbarActions: { display: "flex", alignItems: "center", gap: 6, flexShrink: 0 },
  heading: { minWidth: 0, margin: 0, fontSize: 18, fontWeight: 650 },
  description: { color: "var(--cmux-text-secondary)", fontSize: 11, lineHeight: 1.6 },
  viewTabs: {
    display: "inline-flex",
    alignSelf: "flex-start",
    padding: 3,
    gap: 3,
    border: "1px solid var(--cmux-border)",
    borderRadius: 9,
    background: "color-mix(in srgb, var(--cmux-surface) 76%, transparent)",
  },
  viewButton: {
    border: 0,
    borderRadius: 6,
    padding: "6px 11px",
    color: "var(--cmux-text-secondary)",
    background: "transparent",
    cursor: "pointer",
    fontSize: 11,
  },
  viewButtonActive: {
    color: "var(--cmux-text)",
    background: "var(--cmux-selected)",
    boxShadow: "0 1px 4px color-mix(in srgb, black 18%, transparent)",
  },
  dragHint: {
    padding: "7px 9px",
    borderLeft: "2px solid var(--cmux-accent)",
    color: "var(--cmux-text-secondary)",
    background: "color-mix(in srgb, var(--cmux-accent) 7%, transparent)",
    fontSize: 11,
    lineHeight: 1.55,
  },
  refreshButton: {
    border: "1px solid var(--cmux-border)",
    borderRadius: 7,
    padding: "6px 12px",
    color: "var(--cmux-text)",
    background: "var(--cmux-surface)",
    cursor: "pointer",
  },
  receiveButton: {
    border: "1px solid color-mix(in srgb, var(--cmux-accent) 55%, var(--cmux-border))",
    borderRadius: 7,
    padding: "6px 10px",
    color: "var(--cmux-accent)",
    background: "color-mix(in srgb, var(--cmux-accent) 8%, var(--cmux-surface))",
    cursor: "pointer",
    fontWeight: 650,
  },
  transferDropTarget: {
    position: "absolute",
    zIndex: 30,
    left: 12,
    right: 12,
    bottom: 12,
    minHeight: 68,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    boxSizing: "border-box",
    padding: "12px 16px",
    border: "2px dashed color-mix(in srgb, var(--cmux-accent) 62%, var(--cmux-border))",
    borderRadius: 10,
    color: "var(--cmux-text)",
    background: "color-mix(in srgb, var(--cmux-bg) 92%, var(--cmux-accent) 8%)",
    boxShadow: "0 10px 28px color-mix(in srgb, black 35%, transparent)",
  },
  transferDropTargetActive: {
    borderStyle: "solid",
    borderColor: "var(--cmux-accent)",
    background: "color-mix(in srgb, var(--cmux-bg) 78%, var(--cmux-accent) 22%)",
    boxShadow: "0 0 0 3px color-mix(in srgb, var(--cmux-accent) 20%, transparent), 0 12px 32px color-mix(in srgb, black 42%, transparent)",
  },
  transferDropTitle: { fontSize: 12.5, fontWeight: 750 },
  transferDropHint: { color: "var(--cmux-text-secondary)", fontSize: 11 },
  search: {
    width: "100%",
    boxSizing: "border-box",
    border: "1px solid var(--cmux-border)",
    borderRadius: 8,
    padding: "9px 11px",
    color: "var(--cmux-text)",
    background: "var(--cmux-surface)",
    outline: "none",
  },
  error: { color: "var(--cmux-red)", fontSize: 12 },
  notice: { color: "var(--cmux-yellow)", fontSize: 12 },
  list: { flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 },
  localFooter: {
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    marginTop: 2,
    borderTop: "1px solid var(--cmux-border)",
    overflow: "hidden",
  },
  localFooterExpanded: { maxHeight: "40%" },
  localFooterHeader: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    boxSizing: "border-box",
    minHeight: 32,
    padding: "8px 10px",
    border: "none",
    background: "transparent",
    color: "var(--cmux-text-secondary)",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 600,
    textAlign: "left",
  },
  localFooterChevron: { width: 10, flexShrink: 0, fontSize: 10, color: "var(--cmux-text-dim)" },
  localFooterTitle: { flexShrink: 0 },
  localFooterStatusGroup: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    color: "var(--cmux-text-dim)",
    fontSize: 10,
    fontVariantNumeric: "tabular-nums",
  },
  localFooterBody: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    gap: 8,
    padding: "0 13px 13px",
    overflowY: "auto",
  },
  localSessionsCount: {
    fontSize: 10,
    fontWeight: 700,
    padding: "1px 7px",
    borderRadius: 9,
    color: "var(--cmux-accent)",
    background: "color-mix(in srgb, var(--cmux-accent) 16%, transparent)",
    fontVariantNumeric: "tabular-nums",
  },
  localSessionsHint: { color: "var(--cmux-text-dim)", fontSize: 11, fontWeight: 400 },
  localSessionsEmpty: { padding: "12px 2px 3px", color: "var(--cmux-text-dim)", fontSize: 11 },
  localSessionsList: { display: "grid", gap: 8 },
  localSessionRow: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    columnGap: 10,
    rowGap: 2,
    alignItems: "center",
    padding: "9px 10px",
    border: "1px solid var(--cmux-border)",
    borderLeft: "3px solid color-mix(in srgb, var(--cmux-border) 70%, transparent)",
    borderRadius: 9,
    background: "var(--cmux-surface)",
  },
  localSessionRowPublished: {
    borderLeft: "3px solid var(--cmux-accent)",
  },
  localSessionRowDormant: {
    opacity: 0.72,
    background: "color-mix(in srgb, var(--cmux-surface) 60%, transparent)",
  },
  localSessionRowClickable: { cursor: "pointer" },
  localSessionMain: { display: "grid", gap: 4, minWidth: 0 },
  localSessionTitleLine: { display: "flex", alignItems: "center", gap: 7, minWidth: 0 },
  localSessionTitle: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12.5, fontWeight: 600 },
  localSessionMetaLine: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    columnGap: 10,
    rowGap: 3,
    color: "var(--cmux-text-dim)",
    fontSize: 11,
  },
  localSessionLogLine: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: "var(--cmux-text-dim)",
    fontFamily: "'JetBrains Mono', 'Geist Mono', monospace",
    fontSize: 11,
  },
  metaItem: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 220 },
  metaItemMono: {
    fontFamily: "'JetBrains Mono', 'Geist Mono', monospace",
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  savedChip: { marginLeft: "auto", flexShrink: 0, color: "var(--cmux-text-dim)", fontSize: 11, whiteSpace: "nowrap" },
  savedChipPublished: { marginLeft: "auto", flexShrink: 0, color: "var(--cmux-accent)", fontSize: 11, whiteSpace: "nowrap" },
  statusDotWorking: {
    width: 7,
    height: 7,
    borderRadius: "50%",
    background: "var(--status-working)",
    boxShadow: "0 0 0 3px color-mix(in srgb, var(--status-working) 15%, transparent)",
    flexShrink: 0,
  },
  statusDotWaiting: {
    width: 7,
    height: 7,
    borderRadius: 2,
    transform: "rotate(45deg)",
    background: "var(--status-waiting)",
    boxShadow: "0 0 0 3px color-mix(in srgb, var(--status-waiting) 15%, transparent)",
    flexShrink: 0,
  },
  statusDotIdle: {
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: "var(--cmux-text-dim)",
    opacity: 0.6,
    flexShrink: 0,
  },
  dormantBadge: {
    flexShrink: 0,
    padding: "1px 6px",
    borderRadius: 8,
    fontSize: 11,
    letterSpacing: "0.02em",
    color: "var(--cmux-text-dim)",
    border: "1px solid var(--cmux-border)",
  },
  localPublishButton: { border: 0, borderRadius: 7, padding: "6px 10px", color: "white", background: "var(--cmux-accent)", cursor: "pointer", fontSize: 11, whiteSpace: "nowrap" },
  localPublishButtonDisabled: { opacity: 0.55, cursor: "default" },
  localPublishProgress: { gridColumn: "1 / -1" },
  empty: { padding: 28, textAlign: "center", color: "var(--cmux-text-dim)" },
  card: {
    border: "1px solid var(--cmux-border)",
    borderLeftWidth: 3,
    borderRadius: 9,
    padding: "8px 9px",
    background: "var(--cmux-surface)",
    cursor: "pointer",
    contentVisibility: "auto",
    containIntrinsicSize: "0 84px",
  },
  cardSelected: { borderColor: "var(--cmux-accent)", boxShadow: "0 0 0 1px var(--cmux-accent)" },
  trashCard: { opacity: 0.92 },
  cardTopLine: { display: "flex", alignItems: "center", gap: 6, minWidth: 0 },
  dragHandle: {
    width: 26,
    height: 26,
    margin: "-2px 0 -2px -5px",
    padding: 0,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    border: "1px solid transparent",
    borderRadius: 5,
    color: "var(--cmux-text-dim)",
    background: "transparent",
    cursor: "grab",
    touchAction: "none",
  },
  cardIdentity: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 },
  project: { minWidth: 0, fontSize: 12.5, fontWeight: 650, lineHeight: 1.2 },
  owner: { minWidth: 0, color: "var(--cmux-text-dim)", fontSize: 11, lineHeight: 1.2 },
  machine: { color: "inherit", fontSize: "inherit" },
  updated: {
    flexShrink: 0,
    alignSelf: "flex-start",
    color: "var(--cmux-text-dim)",
    fontSize: 11,
    lineHeight: 1.2,
    whiteSpace: "nowrap",
    fontVariantNumeric: "tabular-nums",
  },
  summary: { marginTop: 5, fontSize: 11.5, lineHeight: 1.35, color: "var(--cmux-text-secondary)" },
  cardFooter: { display: "flex", alignItems: "center", gap: 6, minWidth: 0, marginTop: 6 },
  metaRow: { flex: 1, minWidth: 0, display: "flex", flexWrap: "nowrap", alignItems: "center", gap: 5, overflow: "hidden" },
  recordCurrentBadge: { flexShrink: 0, padding: "1px 5px", borderRadius: 9, fontSize: 11, color: "var(--cmux-accent)", border: "1px solid currentColor" },
  recordClosedBadge: { flexShrink: 0, padding: "1px 5px", borderRadius: 9, fontSize: 11, color: "var(--cmux-text-dim)", border: "1px solid currentColor" },
  recordFinalBadge: { flexShrink: 0, padding: "1px 5px", borderRadius: 9, fontSize: 11, color: "var(--cmux-yellow)", border: "1px solid currentColor", fontWeight: 600 },
  warningBadge: { flexShrink: 0, padding: "1px 5px", borderRadius: 9, fontSize: 11, color: "var(--cmux-yellow)", border: "1px solid currentColor" },
  receivedBadge: { flexShrink: 0, padding: "1px 5px", borderRadius: 9, fontSize: 11, color: "var(--cmux-accent)", border: "1px solid currentColor" },
  openHereBadge: {
    padding: "1px 5px",
    borderRadius: 9,
    fontSize: 11,
    color: "var(--cmux-accent)",
    border: "1px solid currentColor",
    boxShadow: "0 0 8px color-mix(in srgb, var(--cmux-accent) 30%, transparent)",
  },
  quickActions: { display: "flex", alignItems: "center", gap: 3, flexShrink: 0 },
  iconButton: {
    width: 24,
    height: 24,
    padding: 0,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    border: "1px solid var(--cmux-border)",
    borderRadius: 6,
    color: "var(--cmux-text-dim)",
    background: "transparent",
    cursor: "pointer",
  },
  pinIconButtonActive: { color: "var(--cmux-accent)", background: "color-mix(in srgb, var(--cmux-accent) 12%, transparent)" },
  dangerIconButton: { color: "var(--cmux-red)" },
  expandedPanel: { marginTop: 7, paddingTop: 7, borderTop: "1px solid var(--cmux-border)" },
  expandedMetaRow: { display: "flex", alignItems: "center", gap: 9, minWidth: 0, overflow: "hidden" },
  sessionId: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--cmux-text-dim)", fontSize: 11 },
  fileCount: { flexShrink: 0, color: "var(--cmux-text-dim)", fontSize: 11, whiteSpace: "nowrap" },
  deleteButtonArmed: { borderColor: "var(--cmux-red)", background: "color-mix(in srgb, var(--cmux-red) 12%, transparent)" },
  deleteActionButton: { minWidth: 0, border: "1px solid var(--cmux-red)", borderRadius: 7, padding: "6px 8px", color: "var(--cmux-red)", background: "transparent", cursor: "pointer", fontSize: 11, whiteSpace: "nowrap" },
  actions: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 7 },
  trashActions: { display: "grid", gridTemplateColumns: "minmax(68px, 0.7fr) minmax(0, 1.3fr)", gap: 6, marginTop: 7 },
  primaryButton: { minWidth: 0, border: 0, borderRadius: 7, padding: "6px 9px", color: "white", background: "var(--cmux-accent)", cursor: "pointer", fontSize: 11, whiteSpace: "nowrap" },
  secondaryButton: { minWidth: 0, border: "1px solid var(--cmux-border)", borderRadius: 7, padding: "6px 9px", color: "var(--cmux-text)", background: "transparent", cursor: "pointer", fontSize: 11, whiteSpace: "nowrap" },
};
