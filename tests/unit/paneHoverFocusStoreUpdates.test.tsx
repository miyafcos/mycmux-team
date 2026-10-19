// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pane, Workspace } from "../../src/types";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import { useUiStore } from "../../src/stores/uiStore";
import { setup, cleanup, mount, pane, workspace, content, textarea, pointer, advance, mocks } from "./paneHoverFocusHarness";

beforeEach(() => setup()); afterEach(cleanup);
const list = () => useWorkspaceListStore.getState();
const active = () => useUiStore.getState().activePaneId;
function updateWorkspace(update: (ws: Workspace) => Workspace) {
  const state = list();
  useWorkspaceListStore.setState({ workspaces: state.workspaces.map((ws) => ws.id === "w" ? update(ws) : ws),
    layoutRevision: state.layoutRevision + 1 });
}
function updateTarget(update: (p: Pane) => Pane) {
  updateWorkspace((ws) => ({ ...ws, panes: ws.panes.map((p) => p.id === "p-b" ? update(p) : p) }));
}
async function arm() {
  const b = pane("b"), c = pane("c");
  b.tabs.push(pane("b-next").tabs[0]); c.tabs.push(pane("background").tabs[0]);
  await mount(workspace([pane("a"), b, c]));
  useWorkspaceListStore.setState({ workspaces: [...list().workspaces, workspace([pane("other")], "other")] });
  await act(async () => { textarea("a").focus(); pointer(content(), "pointermove"); });
}
const harmless = ["empty name patches", "background tab rename", "target tab rename", "workspace rename",
  "background metadata", "target metadata", "inactive workspace structure", "layout revision only",
  "unrelated UI fields", "unchanged UI notification"] as const;
function harmlessUpdate(kind: typeof harmless[number], sequence = 1) {
  const state = list();
  switch (kind) {
    case "empty name patches": {
      const workspaces = state.workspaces;
      state.applyNamePatches({ tabs: [], workspaces: [] });
      expect(list().workspaces).not.toBe(workspaces);
      expect(list().workspaces).toEqual(workspaces);
      expect(list().layoutRevision).toBe(state.layoutRevision);
      break;
    }
    case "background tab rename":
    case "target tab rename": {
      const background = kind === "background tab rename";
      const paneId = background ? "p-c" : "p-b", tabId = background ? "t-background" : "t-b";
      useWorkspaceLayoutStore.getState().setTabLabel("w", paneId, tabId, "renamed-" + sequence);
      expect(list().getWorkspace("w")!.panes.find((p) => p.id === paneId)!.tabs.find((t) => t.id === tabId)!.label).toBe("renamed-" + sequence);
      expect(list().layoutRevision).toBeGreaterThan(state.layoutRevision);
      break;
    }
    case "workspace rename":
      state.renameWorkspace("w", "renamed-" + sequence);
      expect(list().getWorkspace("w")!.name).toBe("renamed-" + sequence);
      expect(list().layoutRevision).toBeGreaterThan(state.layoutRevision);
      break;
    case "background metadata":
    case "target metadata": {
      const id = kind === "background metadata" ? "background" : "b";
      const result = state.setPaneAgentSessionFromMetadata(id, { agentKind: "codex", agentSessionId: "conversation-" + sequence });
      expect(result).toEqual({ accepted: true, applied: true });
      expect(list().getWorkspace("w")!.panes.flatMap((p) => p.tabs).find((t) => t.sessionId === id)!.agentSessionId).toBe("conversation-" + sequence);
      expect(list().layoutRevision).toBeGreaterThan(state.layoutRevision);
      break;
    }
    case "inactive workspace structure":
      useWorkspaceListStore.setState({ workspaces: state.workspaces.map((ws) => ws.id === "other" ? { ...ws, panes: [] } : ws),
        layoutRevision: state.layoutRevision + 1 });
      expect(list().getWorkspace("other")!.panes).toEqual([]);
      break;
    case "layout revision only": useWorkspaceListStore.setState({ layoutRevision: state.layoutRevision + 1 }); break;
    case "unrelated UI fields":
      useUiStore.setState({ sidebarWidth: 333, sidebarCollapsed: true, lastActivePaneId: "c", requestedSettingsTab: "notifications" });
      expect(useUiStore.getState().sidebarWidth).toBe(333);
      break;
    case "unchanged UI notification": useUiStore.setState({ activePaneId: "a" }); break;
  }
}
const structural = [
  ["target active tab", () => updateTarget((p) => ({ ...p, activeTabId: "t-b-next" }))],
  ["pane removal", () => updateWorkspace((ws) => ({ ...ws, panes: ws.panes.filter((p) => p.id !== "p-b") }))],
  ["workspace switch", () => useWorkspaceListStore.setState({ activeWorkspaceId: "other" })],
  ["pane order", () => updateWorkspace((ws) => ({ ...ws, panes: [...ws.panes].reverse() }))],
  ["pane id", () => updateTarget((p) => ({ ...p, id: "replacement" }))],
  ["pane session", () => updateTarget((p) => ({ ...p, sessionId: "replacement" }))],
  ["tab id", () => updateTarget((p) => ({ ...p, tabs: p.tabs.map((t, i) => i ? t : { ...t, id: "replacement" }) }))],
  ["tab session", () => updateTarget((p) => ({ ...p, tabs: p.tabs.map((t, i) => i ? t : { ...t, sessionId: "replacement" }) }))],
  ["tab type", () => updateTarget((p) => ({ ...p, tabs: p.tabs.map((t, i) => i ? t : { ...t, type: "launcher" }) }))],
  ["tab restorability", () => updateTarget((p) => ({ ...p, tabs: p.tabs.map((t, i) => i ? t : { ...t, lifecycle: "declared" }) }))],
  ["split shape", () => updateWorkspace((ws) => ({ ...ws, splitColumns: [["p-a"], ["p-b", "p-c"]] }))],
  ["grid template", () => updateWorkspace((ws) => ({ ...ws, gridTemplateId: "2x2" }))],
  ["column widths", () => updateWorkspace((ws) => ({ ...ws, columnWidths: [200, 400] }))],
  ["row heights", () => updateWorkspace((ws) => ({ ...ws, rowHeightsPerCol: [[200, 400, 300]] }))],
  ["column divider pins", () => updateWorkspace((ws) => ({ ...ws, columnDividerPins: [true] }))],
  ["row divider pins", () => updateWorkspace((ws) => ({ ...ws, rowDividerPinsPerCol: [[true, false]] }))],
  ["tab order", () => updateTarget((p) => ({ ...p, tabs: [...p.tabs].reverse() }))],
  ["tab removal", () => updateTarget((p) => ({ ...p, tabs: p.tabs.slice(0, 1) }))],
  ["active pane", () => useUiStore.setState({ activePaneId: "c" })],
  ["focus revision", () => useUiStore.getState().bumpFocusRevision()],
  ["zoomed pane", () => useUiStore.setState({ zoomedPaneId: "p-b" })],
] satisfies Array<[string, () => void]>;

describe("HF-01 relevant store facts", () => {
  it.each(harmless)("HF01 preserves the original 100ms dwell through %s at 50ms", async (kind) => {
    await arm(); await advance(50);
    let notifications = 0;
    const stopList = useWorkspaceListStore.subscribe(() => { notifications++; });
    const stopUi = useUiStore.subscribe(() => { notifications++; });
    try { await act(async () => { harmlessUpdate(kind); }); }
    finally { stopList(); stopUi(); }
    expect(notifications).toBeGreaterThan(0);
    await advance(49); expect(active()).toBe("a");
    await advance(1); expect(active()).toBe("b"); expect(document.activeElement).toBe(textarea());
  });
  it.each(harmless)("HF01 preserves pending acquisition through %s", async (kind) => {
    await arm(); await advance(100, false); expect(active()).toBe("a");
    await act(async () => { harmlessUpdate(kind); });
    await advance(0); expect(active()).toBe("b"); expect(document.activeElement).toBe(textarea());
  });
  it.each(["dwell", "acquisition"])("HF01 cancels relevant changes during %s", async (phase) => {
    // Each structural change has its own isolated case below; this also proves a transient focus revision cancels.
    await arm(); await advance(phase === "dwell" ? 50 : 100, phase === "dwell");
    await act(async () => {
      useUiStore.getState().bumpFocusRevision();
      useUiStore.setState({ focusRevision: 0 });
    });
    await advance(200); expect(active()).toBe("a"); expect(mocks.focus.get("b")).not.toHaveBeenCalled();
  });
  describe.each(["dwell", "acquisition"])("HF01 %s cancellation", (phase) => {
    it.each(structural)("HF01 cancels on %s", async (_name, update) => {
      await arm(); await advance(phase === "dwell" ? 50 : 100, phase === "dwell");
      await act(async () => { update(); });
      const expected = active();
      await advance(200); expect(active()).toBe(expected); expect(active()).not.toBe("b");
      expect(mocks.focus.get("b")).not.toHaveBeenCalled();
    });
  });
  it("HF01 switches after 100ms without mouse motion amid 30ms rename and metadata updates", async () => {
    await arm();
    for (let sequence = 1; sequence <= 3; sequence++) {
      await advance(30);
      await act(async () => {
        harmlessUpdate("background tab rename", sequence); harmlessUpdate("target metadata", sequence);
        harmlessUpdate("empty name patches", sequence);
      });
      expect(active()).toBe("a");
    }
    await advance(9); expect(active()).toBe("a");
    await advance(1); expect(active()).toBe("b"); expect(document.activeElement).toBe(textarea());
    expect(useUiStore.getState().focusRevision).toBe(1);
  });
});
