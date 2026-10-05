import type { Pane, PaneTab, Workspace } from "../../../src/types";

export function fixture(paneCount = 1, tabCount = 1, type: PaneTab["type"] = "terminal"): Workspace {
  const panes: Pane[] = Array.from({ length: paneCount }, (_, p) => {
    const tabs = Array.from({ length: tabCount }, (_, t) => ({
      id: `t${p}-${t}`, sessionId: `pty-${p}-${t}`, agentId: "shell", type,
    }));
    return { id: `p${p}`, sessionId: tabs[0].sessionId, agentId: "shell", tabs, activeTabId: tabs[0].id };
  });
  return { id: "w", name: "Test", gridTemplateId: "1x1", status: "running", createdAt: 1, panes };
}
