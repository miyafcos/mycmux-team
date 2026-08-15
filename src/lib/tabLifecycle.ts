import type { PaneTab } from "../types/workspace";

export type DeclaredPaneTab = PaneTab & { lifecycle: "declared" };
export type RestorablePaneTab = PaneTab & { lifecycle?: undefined };

export const KNOWN_LIFECYCLES = ["declared"] as const;

function isKnownLifecycle(value: unknown): value is typeof KNOWN_LIFECYCLES[number] {
  return KNOWN_LIFECYCLES.some((lifecycle) => lifecycle === value);
}

export function isDeclaredTab(tab: PaneTab): tab is DeclaredPaneTab {
  return isKnownLifecycle(tab.lifecycle) && tab.lifecycle === "declared";
}

export function isRestorableTab<T extends { lifecycle?: unknown }>(
  tab: T,
): tab is T & { lifecycle?: undefined } {
  return tab.lifecycle === undefined;
}

export function partitionTabsForRestore(tabs: PaneTab[]): {
  restorable: RestorablePaneTab[];
  declared: DeclaredPaneTab[];
  quarantined: PaneTab[];
} {
  const restorable: RestorablePaneTab[] = [];
  const declared: DeclaredPaneTab[] = [];
  const quarantined: PaneTab[] = [];

  for (const tab of tabs) {
    if (isRestorableTab(tab)) restorable.push(tab);
    else if (isDeclaredTab(tab)) declared.push(tab);
    else quarantined.push(tab);
  }
  return { restorable, declared, quarantined };
}

/** Exhaustiveness guard: launch paths must narrow to RestorablePaneTab before this point. */
export function assertNeverLaunchable(tab: never): never {
  throw new Error(`Non-restorable tab reached a launch path: ${JSON.stringify(tab)}`);
}
