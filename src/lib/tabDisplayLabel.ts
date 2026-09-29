import { getAgent, getDefaultAgent } from "./agents";
import type { PaneTab } from "../types";
import type { PaneMetadata, PaneVolatileMetadata } from "../stores/paneMetadataStore";

export function getTabDisplayLabel(
  tab: Pick<PaneTab, "label" | "labelSource" | "displayName"> & Partial<Pick<PaneTab, "agentId" | "sessionId" | "cwd">>,
  isTabActive = true,
  metadataBySession: Record<string, PaneMetadata | undefined> = {},
  volatileMetadataBySession: Record<string, PaneVolatileMetadata | undefined> = {},
): string {
  const agent = getAgent(tab.agentId ?? "") ?? getDefaultAgent();
  const tabMeta = metadataBySession[tab.sessionId ?? ""];
  const tabProcessTitle = volatileMetadataBySession[tab.sessionId ?? ""]?.processTitle;
  const tabCwd = tabMeta?.cwd ?? tab.cwd;
  const label = tab.label?.trim() ? tab.label : undefined;
  void isTabActive;
  return (tab.labelSource === "user" ? label : undefined)
    ?? tab.displayName
    ?? label
    ?? (tabProcessTitle
        ? tabProcessTitle
        : (tabCwd ? tabCwd.replace(/\\/g, "/").split("/").pop() || agent.name : agent.name));
}
