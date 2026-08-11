import { getAgent, getDefaultAgent } from "./agents";
import type { PaneTab } from "../types";
import type { PaneMetadata } from "../stores/paneMetadataStore";

export function getTabDisplayLabel(
  tab: PaneTab,
  isTabActive: boolean,
  metadataBySession: Record<string, PaneMetadata | undefined>,
): string {
  const agent = getAgent(tab.agentId) ?? getDefaultAgent();
  const tabMeta = metadataBySession[tab.sessionId];
  const tabProcessTitle = tabMeta?.processTitle;
  const tabCwd = tabMeta?.cwd;
  return tab.label
    ?? (tabProcessTitle
        ? tabProcessTitle
        : (isTabActive && tabCwd ? tabCwd.split("/").pop() || agent.name : agent.name));
}
