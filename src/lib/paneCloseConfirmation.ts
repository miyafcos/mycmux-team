import { confirm } from "@tauri-apps/plugin-dialog";
import type { Pane } from "../types";
import { usePaneMetadataStore } from "../stores/paneMetadataStore";
import { collectPaneCloseVictims, paneCloseImpactMessage } from "./paneCloseImpact";

export interface PaneCloseConfirmOptions {
  /** Shown in the body when a workspace is closed, so the target is unambiguous. */
  workspaceName?: string;
}

export async function confirmPaneClose(
  panes: readonly Pane[],
  scope: "pane" | "workspace",
  options: PaneCloseConfirmOptions = {},
): Promise<boolean> {
  const victims = collectPaneCloseVictims(panes, usePaneMetadataStore.getState().metadata);
  // A pane holding nothing live closes unprompted, the way it always has.
  // A workspace never did: it asked every time, and it keeps asking even when
  // no tab looks busy, because the close takes every pane in it.
  if (victims.length === 0 && scope === "pane") return true;

  const body = victims.length > 0
    ? paneCloseImpactMessage(victims)
    : "開いているタブは、まとめて終了します。";
  const named = scope === "workspace" && options.workspaceName
    ? `ワークスペース「${options.workspaceName}」\n${body}`
    : body;

  return confirm(named, {
    title: scope === "workspace" ? "このワークスペースを閉じます" : "このペインを閉じます",
    kind: "warning",
    okLabel: "閉じる",
    cancelLabel: "やめる",
  }).catch(() => false);
}
