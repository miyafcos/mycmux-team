// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { detachedDockTarget, useDetachedDockStore } from "../../src/stores/detachedDockStore";
import { sameDockTarget } from "../../src/lib/tearout/preview";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import type { PaneHandoffEndpoint } from "../../src/lib/paneHandoff";
import type { Workspace } from "../../src/types";

const source: PaneHandoffEndpoint = { workspaceId: "original", paneId: "source-pane",
  tab: { id: "source-tab", sessionId: "source-pty", agentId: "shell", type: "terminal" },
  metadata: { agentKind: "claude", agentSessionId: "fake-source-agent", cwd: "C:/demo/source" } };
const geometry = { x: 0, y: 0, scale: 1 };
let hit: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = `<div data-dnd-workspace-id="receiver" data-dnd-pane-id="target-pane">
    <div class="pane-tabbar"><span data-tab-id="target-tab"></span></div>
    <div data-dnd-handoff-surface="true"><div class="xterm"></div></div></div>`;
  const pane = document.querySelector<HTMLElement>("[data-dnd-pane-id]")!;
  pane.getBoundingClientRect = () => ({ left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400 }) as DOMRect;
  hit = document.querySelector<HTMLElement>(".xterm")!;
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => hit) });
  useWorkspaceListStore.setState({ workspaces: [{ id: "receiver", panes: [{ id: "target-pane",
    activeTabId: "target-tab", sessionId: "target-pty", tabs: [{ id: "target-tab", sessionId: "target-pty", agentId: "shell", type: "terminal" }] }] }] as Workspace[] });
  usePaneMetadataStore.setState({ metadata: { "target-pty": { agentKind: "codex" } } });
  useDetachedDockStore.getState().clear();
});
const resolve = (x = 300, y = 200, endpoint: PaneHandoffEndpoint | null = source) =>
  detachedDockTarget({ screenX: x, screenY: y }, geometry, document, null, endpoint);

describe("native tearout handoff targets", () => {
  it("pins the receiving terminal, agent and PTY at the center", () => {
    expect(resolve()).toEqual({ kind: "handoff", workspaceId: "receiver", paneId: "target-pane",
      tabId: "target-tab", sessionId: "target-pty", targetAgentKind: "codex" });
  });
  it.each(["missing", "grok", "same-pane", "source-browser", "target-shell", "target-browser", "nonterminal-surface"])(
    "keeps the ordinary center target for %s", (mode) => {
      let endpoint = structuredClone(source);
      if (mode === "missing") endpoint.metadata = undefined;
      if (mode === "grok") endpoint.metadata!.agentKind = "grok";
      if (mode === "same-pane") { endpoint.workspaceId = "receiver"; endpoint.paneId = "target-pane"; }
      if (mode === "source-browser") endpoint.tab!.type = "browser";
      if (mode === "target-shell") usePaneMetadataStore.setState({ metadata: {} });
      if (mode === "target-browser") useWorkspaceListStore.getState().workspaces[0].panes[0].tabs[0].type = "browser";
      if (mode === "nonterminal-surface") hit = document.querySelector<HTMLElement>("[data-dnd-pane-id]")!;
      expect(resolve(300, 200, endpoint)).toEqual({ kind: "pane-zone", workspaceId: "receiver", paneId: "target-pane", zone: "center" });
    });
  it("keeps Grok as an eligible recipient, matching the previous pipeline", () => {
    usePaneMetadataStore.setState({ metadata: { "target-pty": { agentKind: "grok" } } });
    expect(resolve()).toMatchObject({ kind: "handoff", targetAgentKind: "grok" });
  });
  it("does not offer handoff when no single-agent drag context was provided", () => {
    expect(resolve(300, 200, null)?.kind).toBe("pane-zone");
  });
  it("keeps the tab strip an insertion target even with an eligible source", () => {
    hit = document.querySelector<HTMLElement>("[data-tab-id]")!;
    hit.getBoundingClientRect = () => ({ left: 0, right: 100 }) as DOMRect;
    expect(resolve(75, 20)).toEqual({ kind: "tab-index", workspaceId: "receiver", paneId: "target-pane", index: 1 });
  });
  it.each([[5, 200, "left"], [595, 200, "right"], [300, 35, "up"], [300, 395, "down"]] as const)(
    "keeps the terminal edge %s,%s a %s split", (x, y, zone) => {
      expect(resolve(x, y)).toEqual({ kind: "pane-zone", workspaceId: "receiver", paneId: "target-pane", zone });
    });
  it("compares and publishes handoff targets by the pinned tab, PTY and agent", () => {
    const target = resolve()!;
    const changes = vi.fn(); const stop = useDetachedDockStore.subscribe(changes);
    useDetachedDockStore.getState().setTarget(target);
    useDetachedDockStore.getState().setTarget({ ...target });
    expect(changes).toHaveBeenCalledTimes(1);
    expect(sameDockTarget(target, { ...target })).toBe(true);
    if (target.kind !== "handoff") throw new Error("missing handoff target");
    expect(sameDockTarget(target, { ...target, sessionId: "replacement-pty" })).toBe(false);
    useDetachedDockStore.getState().setTarget({ ...target, tabId: "replacement-tab" });
    expect(changes).toHaveBeenCalledTimes(2); stop();
  });
});
