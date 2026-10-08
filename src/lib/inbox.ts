import { invoke } from "@tauri-apps/api/core";
import type { PreviewArtifactInfo } from "./ipc";
import { useDashboardViewStore } from "../stores/dashboardViewStore";
import { useWorkspaceListStore } from "../stores/workspaceListStore";
import { useWorkspaceLayoutStore } from "../stores/workspaceLayoutStore";
import { useUiStore } from "../stores/uiStore";
import { useToastStore } from "../stores/toastStore";

export interface InboxEntry {
  from: string;
  title: string;
  path: string;
  receivedAt: number;
}

export const inboxStrings = {
  title: "受け取り箱",
  recent: "最近届いた 20 件",
  open: "開く",
  close: "閉じる",
  refresh: "更新",
  empty: "届いたファイルはまだありません",
  loading: "読み込み中…",
  failed: "受け取り箱を読み込めませんでした",
  openFailed: "届いたファイルを開けませんでした",
  delivered: (from: string, title: string) => from + " から届きました: " + title,
} as const;

const senderLabels = new Map([["grokbot", "Grok Bot"], ["dot", "dot"], ["codex", "Codex"], ["claude", "Claude"]]);
export function inboxSenderLabel(from: string): string {
  return senderLabels.get(from) ?? from;
}

/** Only explicit user actions focus a preview. Receipt itself leaves the workspace alone. */
export async function openInboxEntry(entry: InboxEntry): Promise<void> {
  try {
    const [{ selectOpenTarget }, { createWorkspaceAtCwd }] = await Promise.all([
      import("./openWithPaths"), import("./workspaceBootstrap"),
    ]);
    if (!useWorkspaceListStore.getState().workspaces.length) {
      createWorkspaceAtCwd("", { name: inboxStrings.title });
    }
    const target = selectOpenTarget(useWorkspaceListStore.getState(), useUiStore.getState().activePaneId);
    if (!target) throw new Error("No workspace pane is available");
    const info = await invoke<PreviewArtifactInfo>("inbox_preview", { sessionId: target.sessionId, path: entry.path });
    useWorkspaceLayoutStore.getState().openOrReloadHtmlPreviewPane(target.workspaceId, target.paneId, info);
    useDashboardViewStore.getState().close();
  } catch (error) {
    useToastStore.getState().pushToast(inboxStrings.openFailed + ": " + String(error), "error");
  }
}

// Scope deduplication to the delivered file, never to message text: reports may share a title.
const noticeIds = new Map<string, string>();
export async function postInboxMessage(args: Record<string, unknown> | null | undefined): Promise<InboxEntry> {
  const entry = await invoke<InboxEntry>("inbox_post", { from: args?.from, title: args?.title, path: args?.path });
  const previous = noticeIds.get(entry.path);
  if (previous && useToastStore.getState().toasts.some((toast) => toast.id === previous)) return entry;
  const id = useToastStore.getState().pushToast(
    inboxStrings.delivered(inboxSenderLabel(entry.from), entry.title), "info",
    { label: inboxStrings.open, run: () => { void openInboxEntry(entry); } },
    undefined, undefined, "user-action",
  );
  noticeIds.set(entry.path, id);
  const visible = new Set(useToastStore.getState().toasts.map((toast) => toast.id));
  for (const [path, noticeId] of noticeIds) if (!visible.has(noticeId)) noticeIds.delete(path);
  return entry;
}

export function listInboxEntries(): Promise<InboxEntry[]> {
  return invoke<InboxEntry[]>("inbox_recent");
}
