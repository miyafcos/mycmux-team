import { cropLiveTail } from "../../src/lib/liveTail/crop";
import type { LiveTailFactKind } from "../../src/lib/liveTail/facts";
import type { LiveTailEntry, LiveTailTarget } from "../../src/stores/liveTailStore";
import type { PaneTab, Workspace } from "../../src/types";

export const LIVE_TAIL_TEST_NOW = 1_800_000_000_000;
export const LIVE_TAIL_KINDS: LiveTailFactKind[] = ["progress", "cmd", "stale", "frozen", "unreadable", "error", "idle", "alive"];

export function liveTailFixtureEntry(kind: LiveTailFactKind, now = LIVE_TAIL_TEST_NOW): LiveTailEntry {
  const rawRows = kind === "error"
    ? ["API Error: 500 sample", "* Cooked for 3s · done 01:00"]
    : kind === "idle" ? ["Sample result", "* Cooked for 3s · done 01:00"]
      : kind === "cmd" ? ["● Wait for sample report · 2m 4s", "⎿  $ sample-wait", "* Thinking… (3m 12s · ↓ 62.3k tokens)"]
        : ["● Read sample draft", "Sample output", "* Thinking… (3m 12s · ↓ 62.3k tokens)"];
  const crop = cropLiveTail(rawRows, "claude");
  const observation = { crop, rawRows, lastOutputAt: now - (kind === "frozen" ? 180_000 : 1_000), observedAt: now };
  const evidence = {
    observation, observations: 2, workingSinceMs: now - (kind === "stale" ? 180_000 : 20_000),
    rawUnchangedSinceMs: now - (kind === "frozen" ? 180_000 : kind === "unreadable" ? 30_000 : 0),
    lastProgressAt: kind === "progress" ? now - 12_000 : null,
    commandSinceMs: kind === "cmd" ? now - 124_000 : null,
    commandAdvanced: kind === "cmd", outputAdvancedWithSameScreen: false,
  };
  return { history: [observation], evidence, screenWorking: crop.state === "working" };
}

export function liveTailFixtureScene(kinds = LIVE_TAIL_KINDS, workspaceId = "sample-workspace") {
  const tabs: PaneTab[] = kinds.map((kind, index) => ({
    id: `sample-tab-${index}`, sessionId: `sample-session-${index}`, agentId: index % 2 ? "codex" : "claude",
    agentKind: index % 2 ? "codex" : "claude", type: "terminal",
    label: `Sample ${kind}`, labelSource: "user",
  }));
  const workspace: Workspace = {
    id: workspaceId, name: "Sample Workspace", gridTemplateId: "1x1", createdAt: LIVE_TAIL_TEST_NOW,
    status: "running", panes: [{ id: "sample-pane", agentId: "claude", sessionId: tabs[0]?.sessionId ?? "", tabs, activeTabId: tabs[0]?.id ?? "" }],
  };
  const targets: LiveTailTarget[] = tabs.map((tab, index) => ({
    sessionId: tab.sessionId, workspaceId, workspaceName: workspace.name, paneId: "sample-pane", tabId: tab.id,
    name: `Backend name ${index}`, agentKind: tab.agentKind ?? null, status: "working", waitingForReply: false,
  }));
  const entries = Object.fromEntries(tabs.map((tab, index) => [tab.sessionId, liveTailFixtureEntry(kinds[index])]));
  return { workspace, targets, entries };
}
