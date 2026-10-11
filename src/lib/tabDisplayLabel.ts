import { shortAutomaticName } from "./autoNamePolicy";
import { isAutomaticNameTarget, preferredTabName } from "./autoNameOwnership";
import { getAgent, getDefaultAgent } from "./agents";
import type { PaneTab } from "../types";
import type { PaneMetadata, PaneVolatileMetadata } from "../stores/paneMetadataStore";

export function getTabDisplayFullLabel(
  tab: Pick<PaneTab, "label" | "labelSource" | "displayName"> & Partial<Pick<PaneTab, "agentId" | "sessionId" | "cwd" | "displayNameSource">>,
  isTabActive = true,
  metadataBySession: Record<string, PaneMetadata | undefined> = {},
  volatileMetadataBySession: Record<string, PaneVolatileMetadata | undefined> = {},
): string {
  const agent = getAgent(tab.agentId ?? "") ?? getDefaultAgent();
  const tabMeta = metadataBySession[tab.sessionId ?? ""];
  const tabProcessTitle = volatileMetadataBySession[tab.sessionId ?? ""]?.processTitle;
  const tabCwd = tabMeta?.cwd ?? tab.cwd;
  void isTabActive;
  return preferredTabName(tab)
    ?? (tabProcessTitle
        ? tabProcessTitle
        : (tabCwd ? tabCwd.replace(/\\/g, "/").split("/").pop() || agent.name : agent.name));
}

export function getTabDisplayLabel(...args: Parameters<typeof getTabDisplayFullLabel>): string {
  const full = getTabDisplayFullLabel(...args);
  const tab = args[0];
  return tab.displayNameSource === "auto" && isAutomaticNameTarget(tab) ? shortAutomaticName(full) : full;
}
