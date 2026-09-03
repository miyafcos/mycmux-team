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

/**
 * Whether a tab owns a PTY session.
 *
 * `makeTab` hands every tab a `sessionId` regardless of type, so the field
 * cannot be used to tell them apart: a web tab is a child webview and a
 * launcher tab is a React picker, and neither has a process to kill, restore,
 * or report to the socket API as a terminal. Callers used to spell this as
 * `type !== "web"`, which silently swept each new non-PTY type back in.
 *
 * `browser` and `online` stay on the true side. They predate this predicate and
 * moving them is a separate behaviour change, not a launcher fix — but they
 * likely belong here too.
 */
export function tabHasPty(tab: { type?: string | null }): boolean {
  return tab.type !== "web" && tab.type !== "launcher";
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
