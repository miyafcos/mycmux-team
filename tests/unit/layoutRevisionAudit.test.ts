import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installLayoutRevisionAudit } from "../../src/lib/layoutRevisionAudit";
import { WORKSPACE_COLORS } from "../../src/lib/workspaceColors";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import type { Pane, PaneTab, Workspace } from "../../src/types";

const BLUE = WORKSPACE_COLORS[0].value;

function tab(id: string): PaneTab {
  return {
    id,
    sessionId: `session-${id}`,
    agentId: "shell-starter",
    type: "terminal",
  };
}

function pane(id: string, tabs: PaneTab[]): Pane {
  const active = tabs[0];
  return {
    id,
    agentId: active?.agentId ?? "",
    sessionId: active?.sessionId ?? "",
    activeTabId: active?.id ?? "",
    tabs,
  };
}

function workspace(id: string, name: string): Workspace {
  return {
    id,
    name,
    gridTemplateId: "1x1",
    status: "running",
    createdAt: 10,
    color: BLUE,
    pet: "clawd",
    panes: [pane(`pane-${id}`, [tab(`t-${id}`)])],
    splitColumns: [[`pane-${id}`]],
    columnWidths: [1],
    rowHeightsPerCol: [[1]],
  };
}

let unsubscribe: (() => void) | undefined;
const violations: string[] = [];

beforeEach(() => {
  violations.length = 0;
  useWorkspaceListStore.setState({
    workspaces: [workspace("ws-a", "Alpha"), workspace("ws-b", "Beta")],
    activeWorkspaceId: "ws-a",
    lastActivePaneByWorkspace: {},
    layoutRevision: 0,
  });
  unsubscribe = installLayoutRevisionAudit({
    onViolation: (message) => {
      violations.push(message);
    },
  });
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = undefined;
});

describe("layoutRevision audit", () => {
  it("reports a direct setState that changes the projection without bumping revision", () => {
    const current = useWorkspaceListStore.getState().workspaces;
    useWorkspaceListStore.setState({
      workspaces: [{ ...current[0], name: "Leaked" }, current[1]],
    });
    expect(violations.some((message) => message.includes("without layoutRevision bump"))).toBe(true);
  });

  it("does not report a violation for public layout actions", () => {
    const store = useWorkspaceListStore.getState();
    store.renameWorkspace("ws-a", "Renamed");
    store.setWorkspaceColor("ws-a", BLUE);
    store.setWorkspacePet("ws-a", "clawd");
    store.setWorkspaceStatus("ws-a", "running");
    store.reorderWorkspaces(0, 0);
    store.setActiveWorkspace("ws-b");
    store.createWorkspace(
      "Gamma",
      "1x1",
      [pane("pane-c", [tab("t-c")])],
      [["pane-c"]],
      { id: "ws-c", createdAt: 12, pet: "clawd", activate: false },
    );
    store.removeWorkspace("ws-c");
    store._replaceWorkspaces(structuredClone(useWorkspaceListStore.getState().workspaces));
    expect(violations).toEqual([]);
  });

  it("reports non-finite layout state without throwing and resumes normal auditing", () => {
    const poisoned = structuredClone(useWorkspaceListStore.getState().workspaces);
    poisoned[0].columnWidths = [NaN];
    expect(() => useWorkspaceListStore.setState({ workspaces: poisoned })).not.toThrow();
    expect(violations).toEqual([
      expect.stringMatching(/non-finite persistent number at workspace\.columnWidths\[0\]/i),
    ]);

    const recovered = [workspace("ws-a", "Alpha"), workspace("ws-b", "Beta")];
    expect(() => useWorkspaceListStore.setState({ workspaces: recovered, layoutRevision: 1 })).not.toThrow();
    violations.length = 0;
    expect(() => useWorkspaceListStore.setState({
      workspaces: [{ ...recovered[0], name: "Leaked after recovery" }, recovered[1]],
    })).not.toThrow();
    expect(violations.some((message) => message.includes("without layoutRevision bump"))).toBe(true);
  });

  it("installs on an already non-finite layout without throwing", () => {
    unsubscribe?.();
    unsubscribe = undefined;
    const poisoned = structuredClone(useWorkspaceListStore.getState().workspaces);
    poisoned[0].columnWidths = [Infinity];
    useWorkspaceListStore.setState({ workspaces: poisoned });
    violations.length = 0;

    expect(() => {
      unsubscribe = installLayoutRevisionAudit({
        onViolation: (message) => violations.push(message),
      });
    }).not.toThrow();
    expect(unsubscribe).toBeTypeOf("function");
    expect(violations).toEqual([
      expect.stringMatching(/non-finite persistent number at workspace\.columnWidths\[0\]/i),
    ]);
  });
});
