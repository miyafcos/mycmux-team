// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), handlers: new Map<string, (event: { payload: unknown }) => void>() }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<object>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name, handler) => { mocks.handlers.set(name, handler); return () => mocks.handlers.delete(name); }) }));
import { canonicalPeerWindowTabs, paneTabFromWindowIndex, parsePeerWindowTabIndex } from "../../src/components/dashboard/peerWindowTabs";
import { buildDashboardCards, resolveDisplayState } from "../../src/components/dashboard/dashboardModel";
import { resolveComposerRoute } from "../../src/components/dashboard/interventionRouting";
import { getPtyMetadataSnapshot } from "../../src/lib/ipc";
import { connectLiveAgentHydration } from "../../src/lib/liveAgentMetadata";
import { codexRestoreNoticeEpoch } from "../../src/lib/codexRestoreLifecycle";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { getTabDisplayLabel } from "../../src/lib/tabDisplayLabel";
import type { DashboardModelInput } from "../../src/components/dashboard/dashboardModel";
import type { PaneTab, Workspace } from "../../src/types";
import { peerIndex } from "./fixtures/peerWindowTabs";

const input = (): DashboardModelInput => ({ metadataBySession: {}, volatileMetadataBySession: {}, lastLogBySession: {}, lastLogAtBySession: {},
  attentionBySession: {}, seenAttentionByTab: new Map(), doneMarkByTab: new Map(), stallsBySession: {}, now: 1000, hasTerminalBuffer: () => false });
afterEach(() => { mocks.handlers.clear(); mocks.invoke.mockReset(); useWorkspaceListStore.setState({ workspaces: [] }); });
describe("peer window display projection", () => {
  it("keeps window/workspace/pane/tab locations, local priority, published priority, and main pending cards", () => {
    const pending = peerIndex("mycmux-w1", true);
    const published = peerIndex("mycmux-w2");
    const main = peerIndex("main");
    const returning = peerIndex("main", true); returning[0].workspaces[0].panes[0].tabs[0].tab_id = "returning";
    const peers = canonicalPeerWindowTabs([...pending, ...main, ...published, ...returning], []);
    expect(peers.map(peer => [peer.windowLabel, peer.tab.id])).toEqual([["mycmux-w2", "peer-tab"], ["main", "returning"]]);
    expect(peers[0]).toMatchObject({ workspace: { id: "peer-workspace", name: "Peer workspace" }, pane: { id: "peer-pane" } });
    const local = [{ panes: [{ tabs: [{ id: "peer-tab" }] }] }] as Workspace[];
    expect(canonicalPeerWindowTabs(published, local)).toEqual([]);
  });
  it("preserves naming, resume identity, source marks and only the launch target without changing IDs", () => {
    const tab = peerIndex()[0].workspaces[0].panes[0].tabs[0];
    Object.assign(tab, { label: "old", label_source: "ai", display_name: "A readable generated name", display_name_source: "auto",
      source_kind: "pdf", source_path: "C:/read.pdf", command_argv: ["codex"], launch_env: { MYCMUX_LAUNCH_TARGET: "mac", SECRET: "private" } });
    const mapped = paneTabFromWindowIndex(tab);
    expect(mapped).toMatchObject({ id: "peer-tab", sessionId: "peer-session", displayNameSource: "auto", agentSessionId: "peer-conversation",
      sourceKind: "pdf", sourcePath: "C:/read.pdf", commandArgv: ["codex"], launchEnv: { MYCMUX_LAUNCH_TARGET: "mac" } });
    const owner: PaneTab = { id: "peer-tab", sessionId: "peer-session", agentId: "codex", label: "old", labelSource: "ai",
      displayName: "A readable generated name", displayNameSource: "auto", agentKind: "codex", agentSessionId: "peer-conversation" };
    expect(getTabDisplayLabel(mapped)).toBe(getTabDisplayLabel(owner));
    expect(mapped.launchEnv).toEqual({ MYCMUX_LAUNCH_TARGET: "mac" });
    expect(mapped).not.toHaveProperty("terminalSnapshot");
  });
  it.each([null, 42, { SECRET: "private" }])("omits a launch environment without a string target: %j", (launchEnv) => {
    const tab = peerIndex()[0].workspaces[0].panes[0].tabs[0];
    Object.assign(tab, { launch_env: launchEnv });
    expect(paneTabFromWindowIndex(tab).launchEnv).toBeUndefined();
  });
  it.each([false, true])("matches the local declared card, display state, mark and composer with signals=%s", (withSignals) => {
    const index = peerIndex();
    Object.assign(index[0].workspaces[0].panes[0].tabs[0], { lifecycle: "declared", pty_alive: false, live_agent_kind: null });
    const owner = canonicalPeerWindowTabs(index, [])[0].workspace;
    const modelInput = { ...input(), ...(withSignals ? { statusSignalsBySession: {} } : {}) };
    const local = buildDashboardCards([owner], modelInput)[0];
    const remote = buildDashboardCards([], { ...modelInput, peerWindowTabs: index })[0];
    const state = (card: typeof local) => ({ status: card.status, unobserved: card.unobserved,
      neverStarted: card.neverStarted, display: resolveDisplayState(card), mark: card.mark,
      composer: resolveComposerRoute(card.brief, !card.neverStarted, card.tab.type === "web") });
    expect(state(remote)).toEqual(state(local));
    expect(state(remote)).toMatchObject({ status: "unobserved", unobserved: true, neverStarted: true,
      display: "idle", composer: { kind: "disabled", reason: "notStarted" } });
    delete index[0].workspaces[0].panes[0].tabs[0].lifecycle;
    const stopped = buildDashboardCards([], { ...modelInput, statusSignalsBySession: {}, peerWindowTabs: index })[0];
    expect(stopped).toMatchObject({ unobserved: false, neverStarted: false, volatileMetadata: { ptyAlive: false } });
    expect(resolveDisplayState(stopped)).toBe("stopped");
    expect(resolveComposerRoute(stopped.brief, !stopped.neverStarted)).toEqual({ kind: "paneSendText" });
  });
  it("validates malformed indexes without throwing", () => {
    for (const value of [null, undefined, {}, [null], [{ window_label: "x", workspaces: null }]]) expect(parsePeerWindowTabIndex(value)).toBeNull();
    expect(parsePeerWindowTabIndex(peerIndex())).toEqual(peerIndex());
  });
  it("uses native liveness despite real non-owner restore invalidation and publication events", async () => {
    useWorkspaceListStore.setState({ workspaces: [] });
    usePaneMetadataStore.setState({ volatileMetadata: { "peer-session": { ptyAlive: false, liveAgentKind: null } } });
    mocks.invoke.mockImplementation(async command => command === "get_pty_metadata_snapshot"
      ? { "peer-session": { session_id: "peer-session", session_epoch: 7, live_agent_kind: "codex", cwd: "", agent_active: true } } : []);
    const stop = connectLiveAgentHydration(Promise.resolve());
    try {
      await vi.waitFor(() => expect(mocks.handlers.has("codex-restore-published")).toBe(true));
      mocks.handlers.get("codex-restore-invalidated")!({ payload: { session_id: "peer-session" } });
      mocks.handlers.get("codex-restore-published")!({ payload: { session_id: "peer-session", session_epoch: 7 } });
      expect(codexRestoreNoticeEpoch("peer-session")).toBeNull();
      expect(await getPtyMetadataSnapshot()).toEqual({});
      const card = buildDashboardCards([], { ...input(), peerWindowTabs: peerIndex(),
        volatileMetadataBySession: usePaneMetadataStore.getState().volatileMetadata })[0];
      expect(card).toMatchObject({ windowLabel: "mycmux-w1", unobserved: false, neverStarted: false,
        volatileMetadata: { ptyAlive: true, liveAgentKind: "codex" }, mark: { dormant: false, kind: "codex" } });
      const dead = peerIndex(); dead[0].workspaces[0].panes[0].tabs[0].pty_alive = false;
      const stopped = buildDashboardCards([], { ...input(), peerWindowTabs: dead })[0];
      expect(stopped.volatileMetadata?.ptyAlive).toBe(false);
      expect(stopped.mark?.dormant).toBe(true);
    } finally { stop(); }
  });
});
