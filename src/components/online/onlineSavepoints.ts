import { invoke } from "@tauri-apps/api/core";
import type { PublishSavepointResult } from "../../lib/ipc";
import { useOnlineSavepointStore } from "../../stores/onlineSavepointStore";
import { useToastStore } from "../../stores/toastStore";
import { onlineStrings } from "./onlineStrings";

export interface OnlineSavepointEntry {
  bundle_dir: string;
  author: string;
  machine: string;
  summary_line: string;
  cwd: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
  pinned: boolean;
  warnings_count: number;
  agent_kind?: SavepointAgentKind;
  agent_session_id?: string | null;
  claude_session_id?: string | null;
  files_written_count: number;
  handoff_path: string;
  record_kind?: "current" | "final";
  lifecycle_status?: "active" | "interrupted" | "closed";
  checkpoint_id?: string | null;
  parent_checkpoint_id?: string | null;
  closed_at?: string | null;
  closed_reason?: string | null;
  trash_id?: string | null;
  deleted_at?: string | null;
  trash_reason?: "manual" | "expired" | null;
  received?: boolean;
  transfer_id?: string | null;
}

export type SavepointAgentKind = "claude" | "codex";

export function isSavepointAgentKind(value: string | undefined | null): value is SavepointAgentKind {
  return value === "claude" || value === "codex";
}

export function savepointAgentKind(entry: OnlineSavepointEntry): SavepointAgentKind {
  return entry.agent_kind === "codex" ? "codex" : "claude";
}

export function savepointSessionId(entry: OnlineSavepointEntry): string {
  return entry.agent_session_id ?? entry.claude_session_id ?? "";
}

export function savepointIdentityKey(kind: SavepointAgentKind, sessionId: string): string {
  return `${kind}:${sessionId}`;
}

export function savepointEntryIdentityKey(entry: OnlineSavepointEntry): string {
  return savepointIdentityKey(savepointAgentKind(entry), savepointSessionId(entry));
}

export type SavepointListView = "active" | "trash";

export function isFinalSavepoint(entry: OnlineSavepointEntry): boolean {
  return entry.record_kind === "final";
}

export function isCurrentSavepoint(entry: OnlineSavepointEntry): boolean {
  return !isFinalSavepoint(entry) && entry.lifecycle_status !== "closed";
}

export function isClosedSavepoint(entry: OnlineSavepointEntry): boolean {
  return !isFinalSavepoint(entry) && entry.lifecycle_status === "closed";
}

export function isTrashedSavepoint(entry: OnlineSavepointEntry): boolean {
  return Boolean(entry.trash_id);
}

export async function deleteSavepoint(bundleDir: string): Promise<void> {
  return invoke("delete_online_savepoint", { bundleDir });
}

export async function restoreSavepoint(bundleDir: string, trashId: string): Promise<void> {
  return invoke("restore_online_savepoint", { bundleDir, trashId });
}

export async function purgeSavepoint(bundleDir: string, trashId: string): Promise<void> {
  return invoke("purge_online_savepoint", { bundleDir, trashId });
}

interface OpenSessionWorkspace {
  id?: string;
  name?: string;
  panes: Array<{
    id?: string;
    label?: string;
    cwd?: string;
    tabs: Array<{
      id?: string;
      sessionId: string;
      agentId?: string;
      agentKind?: string;
      label?: string;
      cwd?: string;
      claudeSessionId?: string;
      agentSessionId?: string;
    }>;
  }>;
}

type OpenSessionMetadata = Record<string, {
  claudeSessionId?: string;
  agentKind?: string;
  agentSessionId?: string;
  cwd?: string;
  gitBranch?: string;
  processTitle?: string;
} | undefined>;

export interface OpenAgentSession {
  terminalSessionId: string;
  tabId?: string;
  paneId?: string;
  title: string;
  cwd: string;
  agentKind: SavepointAgentKind;
  agentSessionId?: string;
  status: "running" | "dormant";
  workspaceId?: string;
  workspaceName?: string;
  gitBranch?: string;
}

function persistedTabAgentKind(
  tab: OpenSessionWorkspace["panes"][number]["tabs"][number],
): SavepointAgentKind | null {
  if (isSavepointAgentKind(tab.agentKind)) return tab.agentKind;
  if (tab.agentId === "codex") return "codex";
  if (tab.claudeSessionId || tab.agentId === "claude-code") return "claude";
  return null;
}

export function collectOpenAgentSessions(
  workspaces: OpenSessionWorkspace[],
  metadataBySession: OpenSessionMetadata,
): OpenAgentSession[] {
  const running: OpenAgentSession[] = [];
  const dormant: OpenAgentSession[] = [];
  const seenTerminalSessions = new Set<string>();
  for (const workspace of workspaces) {
    for (const pane of workspace.panes) {
      for (const tab of pane.tabs) {
        if (seenTerminalSessions.has(tab.sessionId)) continue;
        const metadata = metadataBySession[tab.sessionId];
        const runningKind = isSavepointAgentKind(metadata?.agentKind)
          ? metadata.agentKind
          : null;
        const persistedKind = persistedTabAgentKind(tab);
        const isRunning = runningKind !== null;
        // Dormant = an agent isn't currently detected on the pane but the tab
        // still carries persisted agent markers — right after an app restart
        // before the agent is relaunched, or while the pane sits in a shell.
        // Live metadata without a supported agentKind must NOT exclude
        // the row: the poller populates metadata for every live pane within
        // one tick (~5s), which used to make dormant rows vanish almost
        // immediately after restart. Stale markers are cleared by the guarded
        // metadata listener when the agent truly exits, and publishing only
        // reads the session jsonl, so a dormant row stays actionable.
        const isDormant = !isRunning && persistedKind !== null;
        if (!isRunning && !isDormant) continue;
        seenTerminalSessions.add(tab.sessionId);
        const cwd = metadata?.cwd ?? tab.cwd ?? pane.cwd ?? "";
        // Never fall back to metadata.processTitle here — it surfaces raw
        // executable names like "node.exe" instead of a human-facing label.
        const agentKind = runningKind ?? persistedKind!;
        const session: OpenAgentSession = {
          terminalSessionId: tab.sessionId,
          tabId: tab.id,
          paneId: pane.id,
          title: tab.label ?? pane.label ?? projectNameFromCwd(cwd),
          cwd,
          agentKind,
          agentSessionId: isRunning
            ? (metadata?.agentSessionId
              ?? (agentKind === "claude" ? metadata?.claudeSessionId : undefined)
              ?? tab.agentSessionId
              ?? (agentKind === "claude" ? tab.claudeSessionId : undefined))
            : (tab.agentSessionId
              ?? (agentKind === "claude" ? tab.claudeSessionId : undefined)),
          status: isRunning ? "running" : "dormant",
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          gitBranch: isRunning ? metadata?.gitBranch : undefined,
        };
        (isRunning ? running : dormant).push(session);
      }
    }
  }
  return [...running, ...dormant];
}

export function collectOpenAgentIdentityKeys(
  workspaces: OpenSessionWorkspace[],
  metadataBySession: OpenSessionMetadata,
): Set<string> {
  const identities = new Set<string>();
  for (const session of collectOpenAgentSessions(workspaces, metadataBySession)) {
    if (session.agentSessionId) {
      identities.add(savepointIdentityKey(session.agentKind, session.agentSessionId));
    }
  }
  return identities;
}

export function filterAndSortSavepoints(
  entries: OnlineSavepointEntry[],
  query: string,
  view: SavepointListView = "active",
): OnlineSavepointEntry[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return entries
    .filter((entry) => {
      if (isTrashedSavepoint(entry) !== (view === "trash")) return false;
      if (!normalizedQuery) return true;
      return [entry.author, entry.cwd, entry.summary_line]
        .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
    })
    .sort((a, b) => {
      if (view === "trash") {
        return Date.parse(b.deleted_at ?? "") - Date.parse(a.deleted_at ?? "");
      }
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return Date.parse(b.updated_at) - Date.parse(a.updated_at);
    });
}

export function projectNameFromCwd(cwd: string): string {
  const segments = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  return segments.slice(-2).join(" / ") || cwd;
}

export function formatUpdatedAgo(updatedAt: string, now = Date.now()): string {
  const updated = Date.parse(updatedAt);
  if (!Number.isFinite(updated)) return onlineStrings.updatedJustNow;
  const minutes = Math.max(0, Math.floor((now - updated) / 60_000));
  if (minutes < 1) return onlineStrings.updatedJustNow;
  if (minutes < 60) return `${minutes}${onlineStrings.updatedAgoMinutes}`;
  return `${Math.floor(minutes / 60)}${onlineStrings.updatedAgoHours}`;
}

export function isExpiringSoon(expiresAt: string, now = Date.now()): boolean {
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(expires)) return false;
  const remaining = expires - now;
  return remaining >= 0 && remaining < 6 * 60 * 60 * 1000;
}

export const SAVEPOINT_PUBLISHED_EVENT = "mycmux:savepoint-published";

/** Toast/status text for a savepoint publish that succeeded. */
export function savepointPublishSuccessMessage(
  result: PublishSavepointResult,
  recordKind: "current" | "final" = "current",
): string {
  const base = recordKind === "final"
    ? onlineStrings.finalizeSuccess
    : result.updated
      ? onlineStrings.publishSuccessUpdate
      : onlineStrings.publishSuccessNew;
  return result.warnings.length > 0
    ? `${base} — ${result.warnings.length}${onlineStrings.publishWarningsSuffix}`
    : base;
}

/** Human-readable text for a savepoint publish that failed. */
export function savepointPublishErrorMessage(error: unknown): string {
  const message = String(error);
  return message.includes("Session transcript") && message.includes("not found")
    ? onlineStrings.publishNoTranscript
    : onlineStrings.publishErrorPrefix + message;
}

/**
 * The one completion path for a successful savepoint publish, whichever UI
 * started it: toast, published-index refresh, and the DOM event the Online
 * panel listens on. Callers must NOT reload the savepoint list themselves —
 * the event already does that, and doing both loads twice.
 */
export function notifySavepointPublished(
  result: PublishSavepointResult,
  recordKind: "current" | "final" = "current",
): void {
  useToastStore.getState().pushToast(
    savepointPublishSuccessMessage(result, recordKind),
    "warning",
  );
  void useOnlineSavepointStore.getState().refresh();
  window.dispatchEvent(new CustomEvent(SAVEPOINT_PUBLISHED_EVENT));
}
