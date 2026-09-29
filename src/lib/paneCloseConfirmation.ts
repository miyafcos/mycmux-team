import { confirm } from "@tauri-apps/plugin-dialog";
import type { Pane } from "../types";
import { usePaneMetadataStore } from "../stores/paneMetadataStore";
import { collectLiveAgentTabs, collectPaneCloseVictims, paneCloseImpactMessage } from "./paneCloseImpact";
import { agentCloseDialogOptions } from "./agentCloseDialog";

export interface PaneCloseConfirmOptions {
  /** Shown in the body when a workspace is closed, so the target is unambiguous. */
  workspaceName?: string;
  /**
   * Closing a window: how many other windows stay open. The two outcomes read
   * nothing alike — closing the last window is quitting, and everything in it
   * comes back next launch, while closing one of several ends the work in it
   * for good — so the question has to say which one it is asking.
   */
  peerWindowCount?: number;
}

export async function confirmPaneClose(
  panes: readonly Pane[],
  scope: "pane" | "workspace" | "window",
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
    ? `このタブには実行中のエージェントペインが ${liveAgentTabs.length} 件あります。まとめて閉じますか？`
    : victims.length > 0
      ? paneCloseImpactMessage(victims)
    : "開いているペインは、まとめて終了します。";
  const peers = options.peerWindowCount ?? 0;
  const outcome = scope !== "window"
    ? ""
    : peers > 0
      ? `\nこのウィンドウの中のものは、次に起動しても戻りません（他の ${peers} 個のウィンドウはそのまま動きます）。`
      : "\n次に起動したときに、いまの状態から再開できます。";
  const named = scope === "workspace" && options.workspaceName
    ? `ワークスペース「${options.workspaceName}」\n${body}`
    : `${body}${outcome}`;

  return confirm(named, {
    ...(scope === "pane"
      ? agentCloseDialogOptions("このタブを閉じます")
      : {
          title: scope === "window"
            ? peers > 0 ? "このウィンドウを閉じます" : "mycmux を終了します"
            : "このワークスペースを閉じます",
          kind: "warning" as const,
          okLabel: "閉じる",
          cancelLabel: "やめる",
        }),
  }).catch(() => false);
}
