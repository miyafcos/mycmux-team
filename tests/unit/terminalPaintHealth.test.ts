import { expect, it } from "vitest";
import { TerminalStreamHealth } from "../../src/lib/terminalStreamHealth";
import { admitPaintRepair } from "../../src/components/terminal/terminalPaintBudget";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
const source = { revision: 0, available: true };
type Workspace = ReturnType<typeof useWorkspaceListStore.getState>["workspaces"][number];

it("terminalHealth_parseAdvancesButPaintStalls_repairsRendererOnTargetOnly across opposite poll phases", () => {
  let now = 0;
  const stalled = new TerminalStreamHealth(() => now), painting = new TerminalStreamHealth(() => now);
  let backend = 100;
  let detected = false;
  for (let i = 0; i < 10; i++) {
    if (i % 2 === 0) backend++; else { stalled.observeParse(source); painting.observeParse(source); }
    painting.rendered();
    detected ||= stalled.inspectPaint(true, backend);
    expect(painting.inspectPaint(true, backend)).toBe(false);
    if (i < 5) expect(detected).toBe(false);
    now += 2000;
  }
  expect(detected).toBe(true);
});

it.each(["hidden", "zero-size", "idle", "parser-idle", "backend-idle"])("terminalHealth_hiddenOrIdleNeverTriggersPaintRepair (%s)", mode => {
  let now = 0, backend = 100;
  const health = new TerminalStreamHealth(() => now);
  for (let i = 0; i < 30; i++) {
    if (mode !== "idle" && mode !== "parser-idle") health.observeParse(source);
    if (mode !== "idle" && mode !== "backend-idle") backend++;
    expect(health.inspectPaint(mode !== "hidden" && mode !== "zero-size", backend)).toBe(false);
    now += 2000;
  }
});

it("paintRepair_budgetSurvivesRemountAndClearsOnClose", () => {
  const id = "abcd0123";
  const original = useWorkspaceListStore.getState().workspaces;
  const workspace = { id: "budget", panes: [{ id: "pane", sessionId: id, tabs: [{ id: "tab", sessionId: id }] }] } as Workspace;
  useWorkspaceListStore.setState({ workspaces: [workspace] });
  try {
    for (let i = 0; i < 5; i++) {
      // A new stream-health instance represents each mount; the allowance belongs to the tab.
      new TerminalStreamHealth();
      expect(admitPaintRepair(id, 30000 * i)).toEqual({ state: "admitted", attempt: i + 1 });
      expect(admitPaintRepair(id, 30000 * i + 1).state).not.toBe("admitted");
    }
    expect(admitPaintRepair(id, 151000).state).not.toBe("admitted");
    useWorkspaceListStore.setState({ workspaces: [] });
    useWorkspaceListStore.setState({ workspaces: [workspace] });
    expect(admitPaintRepair(id, 152000)).toEqual({ state: "admitted", attempt: 1 });
  } finally {
    useWorkspaceListStore.setState({ workspaces: original });
  }
});
