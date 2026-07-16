import type { Pane } from "../types";

// Pure tab-marker rewrite used by workspaceLayoutStore when an
// "agent-restore-downgraded" event arrives. Kept free of store imports so
// the matching / rewrite rules are unit-testable in isolation.
//
// - "clear": full downgrade (no fallback id was recoverable) — drop the dead
//   markers so the same invalid id cannot re-trigger the warning on every
//   future launch of the pane.
// - "repoint": a fallback conversation WAS resumed — rewrite the persisted
//   markers to the fallback id, otherwise the tab keeps pointing at the
//   original dead id and the next launch downgrades all over again.
export type TabAgentSessionRewrite =
  | { type: "clear" }
  | { type: "repoint"; kind: string; fallbackSessionId: string };

export interface TabAgentSessionRewriteResult {
  panes: Pane[];
  didChange: boolean;
}

export function rewriteTabAgentSession(
  panes: Pane[],
  terminalSessionId: string,
  rewrite: TabAgentSessionRewrite,
): TabAgentSessionRewriteResult {
  let didChange = false;
  const nextPanes = panes.map((pane) => {
    const tabs = pane.tabs.map((tab) => {
      if (tab.sessionId !== terminalSessionId) return tab;

      if (rewrite.type === "clear") {
        if (
          tab.claudeSessionId === undefined &&
          tab.agentKind === undefined &&
          tab.agentSessionId === undefined
        ) {
          return tab;
        }
        didChange = true;
        return {
          ...tab,
          claudeSessionId: undefined,
          agentKind: undefined,
          agentSessionId: undefined,
        };
      }

      // Repoint: update whichever field(s) drive the next restore launch
      // (TerminalPane prefers agentKind+agentSessionId, then claudeSessionId).
      const next = { ...tab };
      let tabChanged = false;
      if (rewrite.kind === "claude" && next.claudeSessionId !== rewrite.fallbackSessionId) {
        next.claudeSessionId = rewrite.fallbackSessionId;
        tabChanged = true;
      }
      if (
        (next.agentSessionId !== undefined || rewrite.kind !== "claude") &&
        next.agentSessionId !== rewrite.fallbackSessionId
      ) {
        next.agentSessionId = rewrite.fallbackSessionId;
        tabChanged = true;
      }
      if (!tabChanged) return tab;
      didChange = true;
      return next;
    });
    return { ...pane, tabs };
  });

  return { panes: didChange ? nextPanes : panes, didChange };
}
