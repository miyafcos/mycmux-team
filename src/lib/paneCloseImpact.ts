import type { Pane, PaneTab } from "../types";
import type { PaneMetadata } from "../stores/paneMetadataStore";
import { getTabDisplayLabel } from "./tabDisplayLabel";
import { deriveDisplayStatus } from "./notificationStatus";

export interface PaneCloseVictim {
  sessionId: string;
  label: string;
  reason: "working" | "agent";
}

export function collectPaneCloseVictims(
  panes: readonly Pane[],
  metadataBySession: Record<string, PaneMetadata | undefined>,
): PaneCloseVictim[] {
  return panes.flatMap((pane) => pane.tabs.flatMap((tab) => {
    const metadata = metadataBySession[tab.sessionId];
    const reason = deriveVictimReason(tab, metadata);
    if (!reason) return [];
    return [{
      sessionId: tab.sessionId,
      label: getTabDisplayLabel(tab, tab.id === pane.activeTabId, metadataBySession),
      reason,
    }];
  }));
}

/** Live agent tabs that would be terminated by closing the supplied panes. */
export function collectLiveAgentTabs(
  panes: readonly Pane[],
  metadataBySession: Record<string, PaneMetadata | undefined>,
): PaneCloseVictim[] {
  return panes.flatMap((pane) => pane.tabs.flatMap((tab) => {
    const metadata = metadataBySession[tab.sessionId];
    const agentKind = metadata?.agentKind ?? tab.agentKind;
    if (!agentKind || metadata?.processIsShell === true) return [];
    return [{
      sessionId: tab.sessionId,
      label: getTabDisplayLabel(tab, tab.id === pane.activeTabId, metadataBySession),
      reason: "agent" as const,
    }];
  }));
}

function deriveVictimReason(
  tab: PaneTab,
  metadata: PaneMetadata | undefined,
): PaneCloseVictim["reason"] | null {
  if (deriveDisplayStatus(metadata) === "working") return "working";
  if (tab.agentKind || metadata?.agentKind || metadata?.processIsShell === false) return "agent";
  return null;
}

export function paneCloseImpactMessage(victims: readonly PaneCloseVictim[]): string {
  const listed = victims.slice(0, 5).map((victim) => `・${victim.label}`);
  const remaining = victims.length - listed.length;
  if (remaining > 0) listed.push(`ほか ${remaining} 件`);
  return [
    `稼働中のタブが ${victims.length} 個あります。閉じると、まとめて終了します。`,
    ...listed,
  ].join("\n");
}
