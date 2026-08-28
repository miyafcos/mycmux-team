// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const orderingMocks = vi.hoisted(() => ({
  claimLeader: vi.fn(),
  getPtyMetadataSnapshot: vi.fn(),
  getWindowFragments: vi.fn(),
  listPets: vi.fn(),
  loadPersistentData: vi.fn(),
  onCloseRequested: vi.fn(),
  quitApp: vi.fn(),
  readAgentSessionMappings: vi.fn(),
  restoreWorkspaceConfigs: vi.fn(),
  savePersistentData: vi.fn(),
  setAppFrontendVisible: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: vi.fn(async () => false),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "main",
    onCloseRequested: orderingMocks.onCloseRequested,
  }),
}));

vi.mock("../../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/ipc")>();
  return {
    ...actual,
    claimLeader: orderingMocks.claimLeader,
    getPtyMetadataSnapshot: orderingMocks.getPtyMetadataSnapshot,
    getWindowFragments: orderingMocks.getWindowFragments,
    listPets: orderingMocks.listPets,
    loadPersistentData: orderingMocks.loadPersistentData,
    quitApp: orderingMocks.quitApp,
    readAgentSessionMappings: orderingMocks.readAgentSessionMappings,
    savePersistentData: orderingMocks.savePersistentData,
    setAppFrontendVisible: orderingMocks.setAppFrontendVisible,
  };
});

vi.mock("../../src/lib/workspaceRestore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/workspaceRestore")>();
  return {
    ...actual,
    restoreWorkspaceConfigs: orderingMocks.restoreWorkspaceConfigs,
  };
});

import { useWorkspacePersist } from "../../src/components/layout/SocketListener";
import {
  __resetPersistenceCoordinatorForTests,
  currentPersistenceLeaderGeneration,
  getPersistentSchemaState,
  requestImmediatePersist,
} from "../../src/lib/workspacePersistenceCoordinator";
import {
  hashCanonical,
  persistentLayoutProjection,
  persistentLayoutSignature,
} from "../../src/lib/persistentLayoutProjection";
import {
  __resetGroupingRuntimeForTests,
  markDurabilityPending,
  recordPersistOutcome,
  runLayoutTransition,
  useGroupingRuntimeStore,
} from "../../src/stores/groupingRuntimeStore";
import { __resetToastStoreForTests } from "../../src/stores/toastStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import type { Workspace } from "../../src/types";

function workspace(name: string): Workspace {
  const tab = {
    id: "tab-ordering",
    sessionId: "session-ordering",
    agentId: "claude-code",
    type: "terminal" as const,
  };
  return {
    id: "workspace-ordering",
    name,
    gridTemplateId: "single",
    panes: [{
      id: "pane-ordering",
      agentId: tab.agentId,
      sessionId: tab.sessionId,
      tabs: [tab],
      activeTabId: tab.id,
    }],
    splitColumns: [["pane-ordering"]],
    columnWidths: [1],
    rowHeightsPerCol: [[1]],
    status: "running",
    createdAt: 1,
  };
}

function workspaceWithDuplicateAndJunkSessions(): Workspace {
  const validAgentSessionId = "11111111-1111-4111-8111-111111111111";
  return {
    id: "workspace-request-parity",
    name: "Request parity",
    gridTemplateId: "single",
    panes: [{
      id: "pane-request-parity",
      agentId: "claude-code",
      sessionId: "session-winner",
      tabs: [
        {
          id: "tab-winner",
          sessionId: "session-winner",
          agentId: "claude-code",
          type: "terminal",
          agentKind: "claude",
          agentSessionId: validAgentSessionId,
          claudeSessionId: validAgentSessionId,
        },
        {
          id: "tab-duplicate",
          sessionId: "session-duplicate",
          agentId: "claude-code",
          type: "terminal",
          agentKind: "claude",
          agentSessionId: validAgentSessionId,
          claudeSessionId: validAgentSessionId,
        },
        {
          id: "tab-junk",
          sessionId: "session-junk",
          agentId: "claude-code",
          type: "terminal",
          agentKind: "claude",
          agentSessionId: "C:/work/agent id",
          claudeSessionId: "C:/work/agent id",
        },
      ],
      activeTabId: "tab-winner",
    }],
    splitColumns: [["pane-request-parity"]],
    columnWidths: [1],
    rowHeightsPerCol: [[1]],
    status: "running",
    createdAt: 1,
  };
}

function trackedPersistDraft(source: Workspace, revision: number) {
  const snapshot = persistentLayoutProjection([source]);
  const signature = persistentLayoutSignature([source]);
  const snapshotDigest = hashCanonical(snapshot);
  markDurabilityPending(
    revision,
    signature,
    snapshotDigest,
    currentPersistenceLeaderGeneration(),
  );
  const pending = useGroupingRuntimeStore.getState().durability;
  if (pending.status !== "pending") throw new Error("durability request was not marked pending");
  return {
    requestId: pending.requestId,
    revision,
    signature,
    snapshot,
    snapshotDigest,
  };
}

async function flushMicrotasks(iterations = 20): Promise<void> {
  await act(async () => {
    for (let index = 0; index < iterations; index += 1) await Promise.resolve();
  });
}

describe("SocketListener persistent write ordering", () => {
  let host: HTMLDivElement | null = null;
  let root: Root | null = null;
  const originalWorkspaceState = useWorkspaceListStore.getState();

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    __resetGroupingRuntimeForTests();
    __resetPersistenceCoordinatorForTests();
    __resetToastStoreForTests();
    useWorkspaceListStore.setState(originalWorkspaceState, true);
    orderingMocks.claimLeader.mockResolvedValue(true);
    orderingMocks.getPtyMetadataSnapshot.mockResolvedValue({});
    orderingMocks.getWindowFragments.mockResolvedValue([]);
    orderingMocks.listPets.mockResolvedValue([]);
    orderingMocks.loadPersistentData.mockResolvedValue({
      schemaVersion: 1,
      supported: true,
      data: {
        schema_version: 1,
        workspaces: [],
        settings: {
          font_size: 14,
          line_height: 1.2,
          font_family: "monospace",
          theme_id: "default",
        },
      },
    });
    orderingMocks.onCloseRequested.mockResolvedValue(() => {});
    orderingMocks.quitApp.mockResolvedValue(undefined);
    orderingMocks.readAgentSessionMappings.mockResolvedValue({});
    orderingMocks.restoreWorkspaceConfigs.mockReturnValue({ activePaneSessionId: null });
    orderingMocks.savePersistentData.mockResolvedValue(undefined);
    orderingMocks.setAppFrontendVisible.mockResolvedValue(undefined);

    const Harness = () => {
      useWorkspacePersist();
      return null;
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(createElement(Harness)));
    await vi.waitFor(() => expect(getPersistentSchemaState()).toEqual({
      status: "supported",
      schemaVersion: 1,
    }));
    await act(async () => vi.advanceTimersByTimeAsync(600));
    await flushMicrotasks();
    orderingMocks.readAgentSessionMappings.mockClear();
    orderingMocks.getWindowFragments.mockClear();
    orderingMocks.savePersistentData.mockClear();
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    __resetToastStoreForTests();
    useWorkspaceListStore.setState(originalWorkspaceState, true);
    host?.remove();
    root = null;
    host = null;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("serializes a request preflight ahead of a later autosave and preserves the request ACK", async () => {
    const r1 = workspace("R1");
    const r2 = workspace("R2");
    let releaseR1!: (mappings: Record<string, never>) => void;
    orderingMocks.readAgentSessionMappings
      .mockImplementationOnce(() => new Promise((resolve) => { releaseR1 = resolve; }))
      .mockResolvedValue({});

    act(() => {
      useWorkspaceListStore.setState((state) => ({
        workspaces: [r1],
        activeWorkspaceId: r1.id,
        layoutRevision: state.layoutRevision + 1,
      }));
    });
    const snapshot = persistentLayoutProjection([r1]);
    const snapshotDigest = hashCanonical(snapshot);
    const requestOutcome = requestImmediatePersist({
      requestId: "ordering-r1",
      revision: 11,
      signature: persistentLayoutSignature([r1]),
      snapshot,
      snapshotDigest,
    });
    await flushMicrotasks();
    expect(orderingMocks.readAgentSessionMappings).toHaveBeenCalledOnce();

    act(() => {
      useWorkspaceListStore.setState((state) => ({
        workspaces: [r2],
        layoutRevision: state.layoutRevision + 1,
      }));
    });
    await act(async () => vi.advanceTimersByTimeAsync(500));
    await flushMicrotasks();
    expect(orderingMocks.savePersistentData).not.toHaveBeenCalled();

    releaseR1({});
    const outcome = await requestOutcome;
    await flushMicrotasks();

    const savedNames = orderingMocks.savePersistentData.mock.calls.map(
      ([saved]) => saved.workspaces[0]?.name,
    );
    expect(savedNames).toEqual(["R1", "R2"]);
    expect(outcome).toMatchObject({
      status: "saved",
      requestId: "ordering-r1",
      savedRevision: 11,
      savedDigest: snapshotDigest,
    });
    expect(savedNames.at(-1)).toBe("R2");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("skips a queued autosave after the leading autosave clears dirty", async () => {
    const r1 = workspace("R1");
    const r2 = workspace("R2");
    let releaseLeadingAutosave!: (mappings: Record<string, never>) => void;
    orderingMocks.readAgentSessionMappings
      .mockImplementationOnce(() => new Promise((resolve) => { releaseLeadingAutosave = resolve; }))
      .mockResolvedValue({});

    act(() => {
      useWorkspaceListStore.setState((state) => ({
        workspaces: [r1],
        activeWorkspaceId: r1.id,
        layoutRevision: state.layoutRevision + 1,
      }));
    });
    await act(async () => vi.advanceTimersByTimeAsync(500));
    await flushMicrotasks();
    expect(orderingMocks.readAgentSessionMappings).toHaveBeenCalledOnce();

    act(() => {
      useWorkspaceListStore.setState((state) => ({
        workspaces: [r2],
        layoutRevision: state.layoutRevision + 1,
      }));
    });
    await act(async () => vi.advanceTimersByTimeAsync(500));
    await flushMicrotasks();
    expect(orderingMocks.savePersistentData).not.toHaveBeenCalled();

    releaseLeadingAutosave({});
    await flushMicrotasks();

    expect(orderingMocks.savePersistentData).toHaveBeenCalledOnce();
    expect(orderingMocks.savePersistentData.mock.calls[0][0].workspaces[0]?.name).toBe("R2");
    expect(orderingMocks.readAgentSessionMappings).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("repairs disk after an older frozen request follows a late-bound autosave", async () => {
    const stateA = workspace("A");
    const stateB = workspace("B");
    const stateC = workspace("C");
    let releaseLeadingAutosave!: (mappings: Record<string, never>) => void;
    orderingMocks.readAgentSessionMappings
      .mockImplementationOnce(() => new Promise((resolve) => { releaseLeadingAutosave = resolve; }))
      .mockResolvedValue({});

    act(() => {
      useWorkspaceListStore.setState((state) => ({
        workspaces: [stateA],
        activeWorkspaceId: stateA.id,
        layoutRevision: state.layoutRevision + 1,
      }));
    });
    await act(async () => vi.advanceTimersByTimeAsync(500));
    await flushMicrotasks();
    expect(orderingMocks.readAgentSessionMappings).toHaveBeenCalledOnce();

    act(() => {
      useWorkspaceListStore.setState((state) => ({
        workspaces: [stateB],
        layoutRevision: state.layoutRevision + 1,
      }));
    });
    const snapshot = persistentLayoutProjection([stateB]);
    const snapshotDigest = hashCanonical(snapshot);
    const requestOutcome = requestImmediatePersist({
      requestId: "ordering-frozen-b",
      revision: 12,
      signature: persistentLayoutSignature([stateB]),
      snapshot,
      snapshotDigest,
    });
    await flushMicrotasks();

    act(() => {
      useWorkspaceListStore.setState((state) => ({
        workspaces: [stateC],
        layoutRevision: state.layoutRevision + 1,
      }));
    });
    await act(async () => vi.advanceTimersByTimeAsync(500));
    await flushMicrotasks();
    expect(orderingMocks.savePersistentData).not.toHaveBeenCalled();

    releaseLeadingAutosave({});
    const outcome = await requestOutcome;
    await flushMicrotasks();
    await act(async () => vi.runAllTimersAsync());
    await flushMicrotasks();

    const savedNames = orderingMocks.savePersistentData.mock.calls.map(
      ([saved]) => saved.workspaces[0]?.name,
    );
    expect(savedNames).toEqual(["C", "B", "C"]);
    expect(outcome).toMatchObject({
      status: "saved",
      requestId: "ordering-frozen-b",
      savedRevision: 12,
      savedDigest: snapshotDigest,
    });
    expect(useWorkspaceListStore.getState().workspaces[0]?.name).toBe("C");
    expect(savedNames.at(-1)).toBe(useWorkspaceListStore.getState().workspaces[0]?.name);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not schedule an extra autosave when live layout still matches the request", async () => {
    const current = workspace("Current");
    act(() => {
      useWorkspaceListStore.setState((state) => ({
        workspaces: [current],
        activeWorkspaceId: current.id,
        layoutRevision: state.layoutRevision + 1,
      }));
    });
    await act(async () => vi.advanceTimersByTimeAsync(500));
    await flushMicrotasks();
    orderingMocks.readAgentSessionMappings.mockClear();
    orderingMocks.getWindowFragments.mockClear();
    orderingMocks.savePersistentData.mockClear();

    const snapshot = persistentLayoutProjection([current]);
    const snapshotDigest = hashCanonical(snapshot);
    await expect(requestImmediatePersist({
      requestId: "ordering-current-request",
      revision: 13,
      signature: persistentLayoutSignature([current]),
      snapshot,
      snapshotDigest,
    })).resolves.toMatchObject({
      status: "saved",
      requestId: "ordering-current-request",
      savedDigest: snapshotDigest,
    });
    await flushMicrotasks();
    await act(async () => vi.runAllTimersAsync());
    await flushMicrotasks();

    expect(orderingMocks.savePersistentData).toHaveBeenCalledOnce();
    expect(orderingMocks.savePersistentData.mock.calls[0][0].workspaces[0]?.name).toBe("Current");
    expect(orderingMocks.readAgentSessionMappings).not.toHaveBeenCalled();
    expect(orderingMocks.getWindowFragments).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries a failed production request and clears its failed durability state", async () => {
    const current = workspace("Retry current");
    act(() => {
      useWorkspaceListStore.setState((state) => ({
        workspaces: [current],
        activeWorkspaceId: current.id,
        layoutRevision: state.layoutRevision + 1,
      }));
    });
    vi.clearAllTimers();
    await flushMicrotasks();
    orderingMocks.savePersistentData.mockClear();
    const timerSpy = vi.spyOn(globalThis, "setTimeout");
    orderingMocks.savePersistentData
      .mockRejectedValueOnce(new Error("first production save failed"))
      .mockResolvedValue(undefined);

    const outcome = await requestImmediatePersist(trackedPersistDraft(current, 21));
    recordPersistOutcome(outcome);
    expect(outcome).toMatchObject({
      status: "failed",
      retryScheduled: true,
      failureGeneration: 1,
    });
    expect(useGroupingRuntimeStore.getState().durability).toMatchObject({
      status: "failed",
      failureGeneration: 1,
    });
    __resetToastStoreForTests();
    expect(vi.getTimerCount()).toBe(1);

    const retryTimerIndex = timerSpy.mock.calls.findLastIndex(([, delay]) => delay === 5_000);
    expect(retryTimerIndex).toBeGreaterThanOrEqual(0);
    clearTimeout(timerSpy.mock.results[retryTimerIndex]?.value as ReturnType<typeof setTimeout>);
    (timerSpy.mock.calls[retryTimerIndex]?.[0] as () => void)();
    await flushMicrotasks(200);

    expect(orderingMocks.savePersistentData).toHaveBeenCalledTimes(2);
    expect(orderingMocks.savePersistentData.mock.calls.map(
      ([saved]) => saved.workspaces[0]?.name,
    )).toEqual(["Retry current", "Retry current"]);
    expect(useGroupingRuntimeStore.getState().durability).toMatchObject({ status: "saved" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries only the newest failed generation and supersedes the matching failure", async () => {
    const current = workspace("Newest current");
    act(() => {
      useWorkspaceListStore.setState((state) => ({
        workspaces: [current],
        activeWorkspaceId: current.id,
        layoutRevision: state.layoutRevision + 1,
      }));
    });
    vi.clearAllTimers();
    await flushMicrotasks();
    orderingMocks.savePersistentData.mockClear();
    const timerSpy = vi.spyOn(globalThis, "setTimeout");
    orderingMocks.savePersistentData
      .mockRejectedValueOnce(new Error("older request failed"))
      .mockRejectedValueOnce(new Error("newer request failed"))
      .mockResolvedValue(undefined);

    const olderOutcome = await requestImmediatePersist(trackedPersistDraft(workspace("Older"), 31));
    recordPersistOutcome(olderOutcome);
    expect(olderOutcome).toMatchObject({ status: "failed", failureGeneration: 1 });
    expect(useGroupingRuntimeStore.getState().durability).toMatchObject({
      status: "failed",
      failureGeneration: 1,
    });

    const newerOutcome = await requestImmediatePersist(trackedPersistDraft(workspace("Newer"), 32));
    recordPersistOutcome(newerOutcome);
    expect(newerOutcome).toMatchObject({ status: "failed", failureGeneration: 2 });
    expect(useGroupingRuntimeStore.getState().durability).toMatchObject({
      status: "failed",
      failureGeneration: 2,
    });
    __resetToastStoreForTests();
    expect(vi.getTimerCount()).toBe(1);

    const retryTimerIndex = timerSpy.mock.calls.findLastIndex(([, delay]) => delay === 5_000);
    expect(retryTimerIndex).toBeGreaterThanOrEqual(0);
    clearTimeout(timerSpy.mock.results[retryTimerIndex]?.value as ReturnType<typeof setTimeout>);
    (timerSpy.mock.calls[retryTimerIndex]?.[0] as () => void)();
    await flushMicrotasks(200);

    expect(orderingMocks.savePersistentData.mock.calls.map(
      ([saved]) => saved.workspaces[0]?.name,
    )).toEqual(["Older", "Newer", "Newest current"]);
    expect(useGroupingRuntimeStore.getState().durability).toMatchObject({
      status: "saved",
      requestId: newerOutcome.requestId,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("re-arms the production retry queue after a transition blocks an attempt", async () => {
    const current = workspace("Re-arm current");
    act(() => {
      useWorkspaceListStore.setState((state) => ({
        workspaces: [current],
        activeWorkspaceId: current.id,
        layoutRevision: state.layoutRevision + 1,
      }));
    });
    vi.clearAllTimers();
    await flushMicrotasks();
    orderingMocks.savePersistentData.mockClear();
    const timerSpy = vi.spyOn(globalThis, "setTimeout");
    orderingMocks.savePersistentData
      .mockRejectedValueOnce(new Error("retry must re-arm"))
      .mockResolvedValue(undefined);

    const outcome = await requestImmediatePersist(trackedPersistDraft(current, 41));
    recordPersistOutcome(outcome);
    expect(outcome).toMatchObject({ status: "failed", failureGeneration: 1 });
    __resetToastStoreForTests();
    expect(vi.getTimerCount()).toBe(1);

    const firstRetryTimerIndex = timerSpy.mock.calls.findLastIndex(([, delay]) => delay === 5_000);
    expect(firstRetryTimerIndex).toBeGreaterThanOrEqual(0);
    clearTimeout(timerSpy.mock.results[firstRetryTimerIndex]?.value as ReturnType<typeof setTimeout>);
    runLayoutTransition("grouping-commit", () => {
      (timerSpy.mock.calls[firstRetryTimerIndex]?.[0] as () => void)();
    });
    await flushMicrotasks();
    expect(orderingMocks.savePersistentData).toHaveBeenCalledOnce();
    expect(useGroupingRuntimeStore.getState().durability).toMatchObject({
      status: "failed",
      failureGeneration: 1,
    });
    expect(vi.getTimerCount()).toBe(1);

    const rearmedTimerIndex = timerSpy.mock.calls.findLastIndex(([, delay]) => delay === 15_000);
    expect(rearmedTimerIndex).toBeGreaterThan(firstRetryTimerIndex);
    clearTimeout(timerSpy.mock.results[rearmedTimerIndex]?.value as ReturnType<typeof setTimeout>);
    (timerSpy.mock.calls[rearmedTimerIndex]?.[0] as () => void)();
    await flushMicrotasks(200);

    expect(orderingMocks.savePersistentData).toHaveBeenCalledTimes(2);
    expect(useGroupingRuntimeStore.getState().durability).toMatchObject({ status: "saved" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the production request serializer for duplicate and junk agent sessions", async () => {
    const current = workspaceWithDuplicateAndJunkSessions();
    act(() => {
      useWorkspaceListStore.setState((state) => ({
        workspaces: [current],
        activeWorkspaceId: current.id,
        layoutRevision: state.layoutRevision + 1,
      }));
    });
    await act(async () => vi.advanceTimersByTimeAsync(500));
    await flushMicrotasks();
    orderingMocks.savePersistentData.mockClear();

    const snapshot = persistentLayoutProjection([current]);
    const snapshotDigest = hashCanonical(snapshot);
    await expect(requestImmediatePersist({
      requestId: "request-production-parity",
      revision: 51,
      signature: persistentLayoutSignature([current]),
      snapshot,
      snapshotDigest,
    })).resolves.toMatchObject({ status: "saved" });
    await flushMicrotasks();
    await act(async () => vi.runAllTimersAsync());
    await flushMicrotasks();

    expect(orderingMocks.savePersistentData).toHaveBeenCalledOnce();
    const savedTabs = orderingMocks.savePersistentData.mock.calls[0][0]
      .workspaces[0]?.panes[0]?.tabs;
    expect(savedTabs?.[0]).toMatchObject({
      tab_id: "tab-winner",
      agent_session_id: "11111111-1111-4111-8111-111111111111",
      claude_session_id: "11111111-1111-4111-8111-111111111111",
    });
    expect(savedTabs?.[1]).toMatchObject({
      tab_id: "tab-duplicate",
      agent_session_id: null,
      claude_session_id: null,
    });
    expect(savedTabs?.[2]).toMatchObject({
      tab_id: "tab-junk",
      agent_session_id: null,
      claude_session_id: null,
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
