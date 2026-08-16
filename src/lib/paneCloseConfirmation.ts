import { confirm } from "@tauri-apps/plugin-dialog";
import type { Pane } from "../types";
import { usePaneMetadataStore } from "../stores/paneMetadataStore";
import { collectLiveAgentTabs, collectPaneCloseVictims, paneCloseImpactMessage } from "./paneCloseImpact";
import { agentCloseDialogOptions } from "./agentCloseDialog";

export interface PaneCloseConfirmOptions {
  /** Shown in the body when a workspace is closed, so the target is unambiguous. */
  workspaceName?: string;
}

export async function confirmPaneClose(
  panes: readonly Pane[],
  scope: "pane" | "workspace",
  options: PaneCloseConfirmOptions = {},
): Promise<boolean> {
  const metadata = usePaneMetadataStore.getState().metadata;
  const volatileMetadata = usePaneMetadataStore.getState().volatileMetadata;
  const victims = collectPaneCloseVictims(panes, metadata, volatileMetadata);
  const liveAgentTabs = scope === "pane" ? collectLiveAgentTabs(panes, metadata, volatileMetadata) : [];
  // A pane holding nothing live closes unprompted, the way it always has.
  // A workspace never did: it asked every time, and it keeps asking even when
  // no tab looks busy, because the close takes every pane in it.
  if (victims.length === 0 && scope === "pane") return true;

  const body = scope === "pane" && liveAgentTabs.length > 0
    ? `このペインには実行中のエージェントタブが ${liveAgentTabs.length} 件あります。まとめて閉じますか？`
    : victims.length > 0
      ? paneCloseImpactMessage(victims)
    : "開いているタブは、まとめて終了します。";
  const named = scope === "workspace" && options.workspaceName
    ? `ワークスペース「${options.workspaceName}」\n${body}`
    : body;

  return confirm(named, {
    ...(scope === "pane"
      ? agentCloseDialogOptions("このペインを閉じます")
      : {
          title: "このワークスペースを閉じます",
          kind: "warning" as const,
          okLabel: "閉じる",
          cancelLabel: "やめる",
        }),
  }).catch(() => false);
}
