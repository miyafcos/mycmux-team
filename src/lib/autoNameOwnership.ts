import type { PaneTab } from "../types";
export function isAutomaticNameTarget(tab: Pick<PaneTab, "label" | "labelSource" | "displayName" | "displayNameSource">): boolean {
  if (tab.labelSource === "user") return false;
  if (tab.displayName && tab.displayNameSource !== "auto") return false;
  if (tab.labelSource && !["user", "ai", "launch"].includes(tab.labelSource)) return false;
  if (tab.label?.trim() && !tab.labelSource && !/^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)+$/.test(tab.label)) return false;
  return true;
}
/** Display ownership priority shared by presentation and sibling reservations. */
export function preferredTabName(tab: Pick<PaneTab, "label" | "labelSource" | "displayName">): string | undefined {
  const label = tab.label?.trim() ? tab.label : undefined;
  return (tab.labelSource === "user" ? label : undefined) ?? tab.displayName ?? label;
}
