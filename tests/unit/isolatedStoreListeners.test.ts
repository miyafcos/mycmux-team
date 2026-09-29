import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";

import { isolateStoreListener, isolateSubscribers } from "../../src/lib/isolatedStoreListeners";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import type { PaneTab, Workspace } from "../../src/types";

// v0.80.1-v0.80.2: a background listener on the layout store threw "Illegal invocation"
// whenever the layout revision moved. zustand passed that straight to whoever changed the
// layout and skipped the listeners after it.
const illegalInvocation = () => new TypeError("Illegal invocation");

const unsubscribers: Array<() => void> = [];
function keep(unsubscribe: () => void): () => void {
  unsubscribers.push(unsubscribe);
  return unsubscribe;
}

function silenceConsoleError() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

function isolationLogs(consoleError: ReturnType<typeof silenceConsoleError>, storeName: string): unknown[][] {
  return consoleError.mock.calls.filter(([message]) =>
    typeof message === "string" && message.startsWith(`[mycmux] ${storeName} store listener threw`));
}

function launcherWorkspace(): Workspace {
  const launcher: PaneTab = { id: "launcher", sessionId: "session-launcher", agentId: "shell-starter", type: "launcher" };
  return {
    id: "ws",
    name: "Workspace 1",
    gridTemplateId: "1x1",
    status: "running",
    createdAt: 1,
    panes: [{ id: "pane", agentId: launcher.agentId, sessionId: launcher.sessionId, tabs: [launcher], activeTabId: launcher.id }],
    splitColumns: [["pane"]],
  };
}

function resetStores(): void {
  useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null, lastActivePaneByWorkspace: {}, layoutRevision: 0 });
  useUiStore.setState({ activePaneId: null, lastActivePaneId: null, focusRevision: 0, zoomedPaneId: null });
  usePaneMetadataStore.getState().removeMetadata("session-probe");
}

beforeEach(resetStores);

afterEach(() => {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  resetStores();
  vi.restoreAllMocks();
});

describe("isolated workspace list listeners", () => {
  it("lets setState finish and the later listeners run when one listener throws", () => {
    const consoleError = silenceConsoleError();
    const failure = illegalInvocation();
    const seen: number[] = [];
    keep(useWorkspaceListStore.subscribe(() => { throw failure; }));
    keep(useWorkspaceListStore.subscribe((state) => { seen.push(state.layoutRevision); }));

    expect(() => useWorkspaceListStore.setState({ layoutRevision: 7 })).not.toThrow();

    expect(useWorkspaceListStore.getState().layoutRevision).toBe(7);
    expect(seen).toEqual([7]);
    expect(isolationLogs(consoleError, "workspaceList")).toEqual([[expect.any(String), failure]]);
  });

  it("still closes the launcher pane after the picked pane opens while a listener throws", () => {
    const consoleError = silenceConsoleError();
    useWorkspaceListStore.setState({
      workspaces: [launcherWorkspace()],
      activeWorkspaceId: "ws",
      lastActivePaneByWorkspace: {},
      layoutRevision: 0,
    });
    useUiStore.setState({ activePaneId: "session-launcher" });
    keep(useWorkspaceListStore.subscribe((state, previous) => {
      if (state.layoutRevision !== previous.layoutRevision) throw illegalInvocation();
    }));

    // LauncherPane.launchAgent: open the picked entry in the same pane, then close the launcher.
    const layout = useWorkspaceLayoutStore.getState();
    layout.addTabToPaneWithOptions("ws", "pane", { agentId: "shell-starter", cwd: "/work" });
    layout.removeTabFromPane("ws", "pane", "launcher");

    const tabs = useWorkspaceListStore.getState().getWorkspace("ws")?.panes[0]?.tabs ?? [];
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ type: "terminal", cwd: "/work" });
    expect(tabs.some((tab) => tab.id === "launcher")).toBe(false);
    expect(isolationLogs(consoleError, "workspaceList").length).toBeGreaterThan(0);
  });

  it("stops calling a listener once it unsubscribes", () => {
    const consoleError = silenceConsoleError();
    const seen: number[] = [];
    // keep() as well, so a failure part-way still leaves no listener behind for the next test.
    const unsubscribeRecorder = keep(useWorkspaceListStore.subscribe((state) => { seen.push(state.layoutRevision); }));
    const unsubscribeThrower = keep(useWorkspaceListStore.subscribe(() => { throw illegalInvocation(); }));

    useWorkspaceListStore.setState({ layoutRevision: 1 });
    unsubscribeRecorder();
    unsubscribeThrower();
    useWorkspaceListStore.setState({ layoutRevision: 2 });

    expect(seen).toEqual([1]);
    expect(isolationLogs(consoleError, "workspaceList")).toHaveLength(1);
  });
});

describe("each isolated store", () => {
  it.each([
    {
      storeName: "workspaceList",
      subscribe: (listener: () => void) => useWorkspaceListStore.subscribe(listener),
      change: () => useWorkspaceListStore.setState({ layoutRevision: 41 }),
    },
    {
      storeName: "paneMetadata",
      subscribe: (listener: () => void) => usePaneMetadataStore.subscribe(listener),
      change: () => usePaneMetadataStore.getState().setMetadata("session-probe", { cwd: "/probe" }),
    },
    {
      storeName: "ui",
      subscribe: (listener: () => void) => useUiStore.subscribe(listener),
      change: () => useUiStore.getState().bumpFocusRevision(),
    },
  ])("keeps a throwing $storeName listener out of the action that changed it", ({ storeName, subscribe, change }) => {
    const consoleError = silenceConsoleError();
    let later = 0;
    keep(subscribe(() => { throw illegalInvocation(); }));
    keep(subscribe(() => { later += 1; }));

    expect(change).not.toThrow();

    expect(later).toBe(1);
    expect(isolationLogs(consoleError, storeName)).toHaveLength(1);
  });
});

describe("isolateSubscribers", () => {
  it("wraps a store once however many times it is called", () => {
    const store = createStore<{ count: number }>(() => ({ count: 0 }));
    const original = store.subscribe;
    isolateSubscribers(store, "probe");
    const isolated = store.subscribe;
    isolateSubscribers(store, "probe");

    expect(isolated).not.toBe(original);
    expect(store.subscribe).toBe(isolated);

    // The app's stores are isolated where they are created, so another call changes nothing.
    const workspaceListSubscribe = useWorkspaceListStore.subscribe;
    isolateSubscribers(useWorkspaceListStore, "workspaceList");
    expect(useWorkspaceListStore.subscribe).toBe(workspaceListSubscribe);
  });

  it("keeps zustand's one entry per listener", () => {
    const store = createStore<{ count: number }>(() => ({ count: 0 }));
    isolateSubscribers(store, "probe");
    const listener = vi.fn();
    const first = store.subscribe(listener);
    store.subscribe(listener);

    store.setState({ count: 1 });
    expect(listener).toHaveBeenCalledTimes(1);

    first();
    store.setState({ count: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("isolateStoreListener", () => {
  it("passes the state pair through and logs what the listener throws", () => {
    const consoleError = silenceConsoleError();
    const failure = illegalInvocation();
    const received: Array<[number, number]> = [];
    const isolated = isolateStoreListener("probe", (state: number, previous: number) => {
      received.push([state, previous]);
      throw failure;
    });

    expect(() => isolated(2, 1)).not.toThrow();

    expect(received).toEqual([[2, 1]]);
    expect(consoleError).toHaveBeenCalledWith(
      "[mycmux] probe store listener threw; the change it was told about still applied and the other listeners still ran",
      failure,
    );
  });

  it("hands back what the listener returns", () => {
    const consoleError = silenceConsoleError();
    const isolated = isolateStoreListener("probe", (state: number, previous: number) => state * 10 + previous);

    expect(isolated(4, 2)).toBe(42);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("hands back undefined when the listener throws", () => {
    const consoleError = silenceConsoleError();
    const isolated = isolateStoreListener("probe", (): number => { throw illegalInvocation(); });

    expect(isolated()).toBeUndefined();
    expect(consoleError).toHaveBeenCalledTimes(1);
  });
});
