import { getAgent, getDefaultAgent } from "./agents";
import type { PaneTab } from "../types";
import type { PaneMetadata, PaneVolatileMetadata } from "../stores/paneMetadataStore";

export function getTabDisplayLabel(
  tab: PaneTab,
  isTabActive: boolean,
  metadataBySession: Record<string, PaneMetadata | undefined>,
  volatileMetadataBySession: Record<string, PaneVolatileMetadata | undefined> = {},
): string {
  const agent = getAgent(tab.agentId) ?? getDefaultAgent();
  const tabMeta = metadataBySession[tab.sessionId];
  const tabProcessTitle = volatileMetadataBySession[tab.sessionId]?.processTitle;
  const tabCwd = tabMeta?.cwd;
  return tab.label
    ?? (tabProcessTitle
        ? tabProcessTitle
        : (isTabActive && tabCwd ? tabCwd.split("/").pop() || agent.name : agent.name));
}
