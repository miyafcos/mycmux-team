// @vitest-environment jsdom
import { writeFileSync } from "node:fs";
import { act, Profiler } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { StoreApi } from "zustand/vanilla";
import type { LiveTailState } from "../../src/stores/liveTailStore";
import { useSessionAttentionStore } from "../../src/stores/sessionAttentionStore";
import { applyPtyMetadata } from "../../src/lib/liveAgentMetadata";
import { crsmListSessions, onSavepointPublishProgress, type PtyMetadata } from "../../src/lib/ipc";
import TabBar from "../../src/components/layout/TabBar";
import TerminalPane from "../../src/components/workspace/TerminalPane";
import { GroupingLiveChipBadge } from "../../src/components/layout/GroupingLiveChip";
import { liveTailFixtureScene, LIVE_TAIL_TEST_NOW } from "../fixtures/liveTailList";

const sidebar = vi.hoisted(() => ({ store: undefined as StoreApi<LiveTailState> | undefined }));
vi.mock("../../src/stores/liveTailStore", async () => {
  const actual = await vi.importActual<typeof import("../../src/stores/liveTailStore")>("../../src/stores/liveTailStore");
  return { ...actual, useLiveTailStore: <T,>(selector: (state: LiveTailState) => T) => useStore(sidebar.store!, selector), acquireLiveTailConsumer: () => () => {} };
});
vi.mock("../../src/lib/ipc");
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null), isTauri: () => false, Channel: class {} }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
vi.mock("../../src/hooks/usePaneDragSource", () => ({ usePaneDragSource: () => ({ beginPointerDrag: vi.fn(), shouldSuppressClick: () => false }) }));
vi.mock("../../src/components/composer/PaneComposer", () => ({ PaneComposer: () => null }));
vi.mock("../../src/components/terminal/XTermWrapper", () => ({ default: () => <div className="xterm" />, hasTerminalBuffer: () => false }));

it("bounds observation-only monitor writes across 40 terminal tabs without rerendering L35 rows", async () => {
  vi.useFakeTimers(); vi.setSystemTime(LIVE_TAIL_TEST_NOW);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.mocked(crsmListSessions).mockResolvedValue([]);
  vi.mocked(onSavepointPublishProgress).mockResolvedValue(() => {});
  sidebar.store = createStore<LiveTailState>(() => ({ targets: [], entries: {} }));
  const scene = liveTailFixtureScene(Array.from({ length: 40 }, () => "progress"));
  // Forty displayed terminals, with their real headers and shared sidebar.
  scene.workspace.panes = scene.workspace.panes[0].tabs.map(tab => ({
    id: `pane-${tab.id}`, agentId: tab.agentId, sessionId: tab.sessionId, tabs: [tab], activeTabId: tab.id,
  }));
  scene.targets = scene.targets.map((target, index) => ({ ...target, paneId: scene.workspace.panes[index].id }));
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} });
  useSessionAttentionStore.getState().resetForTests();
  useSettingsStore.setState({ showTerminalHistoryButton: false, paneComposerEnabled: false });
  useUiStore.setState({ activePaneId: scene.targets[0].sessionId, sidebarCollapsed: false, zoomedPaneId: null });
  useWorkspaceListStore.setState({ workspaces: [scene.workspace], activeWorkspaceId: scene.workspace.id });
  sidebar.store.setState({ targets: scene.targets, entries: scene.entries });
  const metadata = (index: number, observedAt: number): PtyMetadata => ({
    session_id: scene.targets[index].sessionId, cwd: "/synthetic", git_branch: null,
    process_name: "claude", process_status: "running", last_output_at: null,
    live_agent_kind: "claude", agent_active: true, agent_session_trusted: false,
    observed_at: observedAt, agent_started_at: LIVE_TAIL_TEST_NOW - 60_000,
  } as PtyMetadata);
  for (let index = 0; index < 40; index++) applyPtyMetadata(metadata(index, LIVE_TAIL_TEST_NOW));
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host), renders: Record<string, number> = {}, commits: Record<string, number> = {};
  // The dispatch-only Vite instrumentation counts real function executions;
  // ordinary full-suite runs also verify commits, store writes and unchanged DOM.
  vi.stubGlobal("__integ4Render", (name: string) => { renders[name] = (renders[name] ?? 0) + 1; });
  const countCommit = (id: string): void => { commits[id] = (commits[id] ?? 0) + 1; };
  let writes = 0;
  const unsubscribe = usePaneMetadataStore.subscribe((state, previous) => {
    if (state.volatileMetadata !== previous.volatileMetadata) writes++;
  });
  try {
    await act(async () => root.render(<>
      <Profiler id="TabBar" onRender={countCommit}><TabBar onNewWorkspace={() => {}} onCloseWorkspace={() => {}} /></Profiler>
      {scene.workspace.panes.map(pane => <Profiler key={pane.id} id="TerminalPane" onRender={countCommit}>
        <TerminalPane pane={pane} workspaceId={scene.workspace.id} />
      </Profiler>)}
      {scene.targets.map(target => <Profiler key={target.sessionId} id="GroupingLiveChip" onRender={countCommit}>
        <GroupingLiveChipBadge sessionId={target.sessionId} declared={false} attentionCategory={null} tabAgentKind="claude" now={LIVE_TAIL_TEST_NOW} />
      </Profiler>)}
    </>));
    expect(host.querySelectorAll(".pane-tabbar")).toHaveLength(40);
    expect(host.querySelectorAll("[data-live-tail-tab]")).toHaveLength(40);
    const content = host.innerHTML;
    for (const key of Object.keys(renders)) renders[key] = 0;
    for (const key of Object.keys(commits)) commits[key] = 0;
    writes = 0;
    // Do not run unrelated UI clocks: the workload isolates monitor delivery.
    // All 40 real applyPtyMetadata calls are batched per 10-second monitor tick.
    for (let tick = 1; tick <= 6; tick++) {
      vi.setSystemTime(LIVE_TAIL_TEST_NOW + tick * 10_000);
      await act(async () => {
        for (let index = 0; index < 40; index++) applyPtyMetadata(metadata(index, Date.now()));
      });
    }
    const counts = { tabs: 40, ticks: 6, writes, renders, commits };
    console.log("INTEG4_RENDER_COUNTS " + JSON.stringify(counts));
    if (process.env.INTEG4_RENDER_OUTPUT) writeFileSync(process.env.INTEG4_RENDER_OUTPUT, JSON.stringify(counts, null, 2) + "\n");
    expect(host.innerHTML).toBe(content);
    expect(renders.TailRow ?? 0).toBe(0);
    expect(writes).toBeLessThanOrEqual(80); // At most one observation write per 30 seconds per tab.
    expect(commits.TerminalPane).toBeLessThanOrEqual(80);
  } finally {
    unsubscribe(); await act(async () => root.unmount()); host.remove();
    useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null });
    sidebar.store.setState({ targets: [], entries: {} });
    usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} });
    vi.unstubAllGlobals(); vi.useRealTimers();
  }
});
