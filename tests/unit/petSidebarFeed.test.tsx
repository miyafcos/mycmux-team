// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TabBar from "../../src/components/layout/TabBar";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { usePetSettingsStore } from "../../src/stores/petSettingsStore";
import { useSessionAttentionStore } from "../../src/stores/sessionAttentionStore";
import { useTerminalObservationStore } from "../../src/stores/terminalObservationStore";
import { useStallStore } from "../../src/stores/stallStore";
import { useUiStore } from "../../src/stores/uiStore";
import type { Workspace } from "../../src/types";
import { PET_TEST_NOW, publishPetFeed } from "../fixtures/petFeed";

// Keep the real sidebar, stores and sprite. Only unrelated live-tail demand and
// bitmap pre-scaling are replaced; jsdom cannot paint an atlas.
vi.mock("../../src/components/layout/LiveTailList", () => ({
  LiveTailSidebarConsumer: () => null,
  WorkspaceLiveTailList: () => null,
}));
vi.mock("../../src/lib/petAtlasScale", async () => ({
  ...await vi.importActual<typeof import("../../src/lib/petAtlasScale")>("../../src/lib/petAtlasScale"),
  peekPrescaledAtlas: () => null,
}));

function workspace(id: string, sessions: string[][]): Workspace {
  return {
    id, name: id, gridTemplateId: "1x1", status: "running", createdAt: 1, pet: "clawd",
    panes: sessions.map((group, index) => ({
      id: `${id}-pane-${index}`, agentId: "shell", sessionId: group[0] ?? "",
      activeTabId: `${group[0]}-tab`,
      tabs: group.map((sessionId) => ({ id: `${sessionId}-tab`, sessionId, agentId: "shell", type: "terminal" })),
    })),
  };
}

let host: HTMLDivElement;
let root: Root;
const sprite = () => host.querySelector<HTMLElement>('[data-dnd-workspace-target-id="background"] .cmux-pet-sprite')!;
const row = () => Math.abs(parseFloat(sprite().style.getPropertyValue("--pet-row-offset"))) / parseFloat(sprite().style.height);
const render = () => act(() => root.render(createElement(TabBar, { onNewWorkspace: () => {}, onCloseWorkspace: () => {} })));
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(PET_TEST_NOW);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useWorkspaceListStore.setState({
    workspaces: [workspace("foreground", [["front"]]), workspace("background", [["a", "b"], ["c"]])],
    activeWorkspaceId: "foreground",
  });
  usePetSettingsStore.setState(usePetSettingsStore.getInitialState(), true);
  usePetSettingsStore.getState().setPetDisplayMode("ws");
  useSessionAttentionStore.getState().resetForTests();
  useTerminalObservationStore.setState({ observed: new Set() });
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} });
  useStallStore.getState().replaceEntries({});
  useUiStore.setState({ sidebarCollapsed: false, zoomedPaneId: null });
  for (const id of ["front", "a", "b", "c"]) publishPetFeed(id, { activity: "idle" });
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null });
  useTerminalObservationStore.setState({ observed: new Set() });
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} });
  useStallStore.getState().replaceEntries({});
  useSessionAttentionStore.getState().resetForTests();
  usePetSettingsStore.setState(usePetSettingsStore.getInitialState(), true);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("real sidebar pet from a background session feed", () => {
  it.each(["input", "approval"] as const)("S-A / R2: hidden %s in a non-front tab calls", (kind) => {
    publishPetFeed("b", { kind });
    render();
    expect(row()).toBe(6);
    expect(sprite().classList.contains("cmux-pet-sprite--static")).toBe(false);
    expect(useTerminalObservationStore.getState().observed.size).toBe(0);
  });

  it("S-B: an external answer clears frozen background waiting and starts work immediately", () => {
    usePaneMetadataStore.getState().setMetadata("b", { agentStatus: "waiting", workingPatternVisible: true });
    publishPetFeed("b", { kind: "input" });
    render();
    expect(row()).toBe(6);
    act(() => publishPetFeed("b", { activity: "running_silent", uiState: "working", stateSince: PET_TEST_NOW }));
    expect(row()).toBe(7);
  });

  it("S-C / R10: stopped background sessions animate row zero every 6.6 seconds", () => {
    usePaneMetadataStore.getState().setMetadata("a", { agentStatus: "waiting", workingPatternVisible: true });
    render();
    expect(row()).toBe(0);
    expect(sprite().style.getPropertyValue("--pet-duration")).toBe("6600ms");
    expect(sprite().classList.contains("cmux-pet-sprite--static")).toBe(false);
  });

  it("S-C regression: frozen outputActive cannot keep stopped background sessions running", () => {
    usePaneMetadataStore.getState().setMetadata("a", { outputActive: true, backendLastOutputAt: PET_TEST_NOW - 60_000 });
    render();
    expect(row()).toBe(0);
  });

  it("R8 regression: background output expires even if the last observed screen stays active", () => {
    usePaneMetadataStore.getState().setMetadata("a", { outputActive: true });
    publishPetFeed("a", { lastOutputAt: PET_TEST_NOW, activity: "streaming" });
    render();
    expect(row()).toBe(7);
    advance(30_000);
    expect(row()).toBe(7);
    advance(3_000);
    expect(row()).toBe(0);
  });

  it("S-D / R9: silent background work keeps running for two minutes without output", () => {
    publishPetFeed("c", { activity: "running_silent", uiState: "working", lastOutputAt: PET_TEST_NOW - 60_000 });
    render();
    advance(120_000);
    expect(row()).toBe(7);
  });

  it("S-E / R3: a seen background rate limit remains stuck", () => {
    publishPetFeed("c", { kind: "rate_limited" });
    const attention = useSessionAttentionStore.getState().attentionBySession.c;
    useSessionAttentionStore.getState().markSeen("c-tab", attention.attentionId!);
    render();
    expect(row()).toBe(5);
  });

  it("S-G: idle without blocking attention ignores frozen background waiting", () => {
    usePaneMetadataStore.getState().setMetadata("a", { agentStatus: "waiting" });
    publishPetFeed("a", { kind: "none", activity: "idle", stateSince: PET_TEST_NOW });
    render();
    expect(row()).toBe(0);
  });

  it("aggregation: calling in another pane outranks working", () => {
    publishPetFeed("a", { activity: "running_silent" });
    publishPetFeed("c", { kind: "approval" });
    render();
    expect(row()).toBe(6);
  });

  it("aggregation: working outranks unread completion in another pane", () => {
    publishPetFeed("a", { activity: "running_silent" });
    publishPetFeed("c", { kind: "done" });
    render();
    expect(row()).toBe(7);
  });

  it("R6: a background stall rests while queued input calls", () => {
    publishPetFeed("b", { activity: "running_silent" });
    useStallStore.getState().replaceEntries({ b: { sessionId: "b", reason: "silent", since: PET_TEST_NOW - 300_000 } });
    render();
    expect(row()).toBe(0);
    act(() => useStallStore.getState().replaceEntries({ b: { sessionId: "b", reason: "queued_input", since: PET_TEST_NOW } }));
    expect(row()).toBe(6);
  });

  it("S6 / R5: unread done shows review and reading it rests immediately", () => {
    publishPetFeed("b", { kind: "done", activity: "streaming", lastOutputAt: PET_TEST_NOW - 1_000 });
    render();
    expect(row()).toBe(8);
    act(() => useSessionAttentionStore.getState().markSeen("b-tab", useSessionAttentionStore.getState().attentionBySession.b.attentionId!));
    expect(row()).toBe(0);
  });

  it("hold: completed work stays running for 3 seconds then reviews", () => {
    publishPetFeed("b", { activity: "running_silent" });
    render();
    act(() => publishPetFeed("b", { kind: "done" }));
    expect(row()).toBe(7);
    advance(2_999);
    expect(row()).toBe(7);
    advance(1);
    expect(row()).toBe(8);
  });

  it("hold: new human attention interrupts a pending demotion immediately", () => {
    publishPetFeed("b", { activity: "running_silent" });
    render();
    act(() => publishPetFeed("b", { activity: "idle" }));
    advance(1_000);
    act(() => publishPetFeed("b", { kind: "input" }));
    expect(row()).toBe(6);
    advance(4_000);
    expect(row()).toBe(6);
  });
});
