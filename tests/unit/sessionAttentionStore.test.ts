import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FeedSessionPayload,
  SessionAttentionKind,
  SessionStatusChangedPayload,
  SessionStatusSnapshotPayload,
} from "../../src/lib/ipc";
import type { PaneTab, Workspace } from "../../src/types";
const ipcMocks = vi.hoisted(() => ({
  getSessionStatusSnapshot: vi.fn(),
  onSessionStatusChanged: vi.fn(),
}));

vi.mock("../../src/lib/ipc", () => ipcMocks);

import {
  connectSessionAttentionStore,
  attentionDetail,
  isAttentionUnseen,
  readSeenAttention,
  resolveAttentionTabs,
  resolveNextAttentionTarget,
  SEEN_ATTENTION_STORAGE_KEY,
  summarizeUnseenAttention,
  useSessionAttentionStore,
} from "../../src/stores/sessionAttentionStore";

function session(
  sessionId: string,
  attentionId: string | null,
  kind: SessionAttentionKind,
  revision: number,
  stateSince: number,
  detail: string | null = null,
): FeedSessionPayload {
  return {
    session_id: sessionId,
    session_revision: revision,
    status: {
      attention: {
        attention_id: attentionId,
        kind,
        detail,
        state_since: stateSince,
      },
      ui_state: kind === "done" ? "done" : kind === "none" ? "idle" : "waiting",
    },
  };
}

function snapshot(
  sessions: FeedSessionPayload[],
  serverEpoch = "server",
  seq = Math.max(0, ...sessions.map((item) => item.session_revision)),
): SessionStatusSnapshotPayload {
  return { server_epoch: serverEpoch, seq, sessions };
}

function changed(
  payload: FeedSessionPayload,
  serverEpoch = "server",
  seq = payload.session_revision,
): SessionStatusChangedPayload {
  return {
    ...payload,
    v: 2,
    kind: "event",
    event: "status.changed",
    server_epoch: serverEpoch,
    seq,
  };
}

function tab(id: string, sessionId: string): PaneTab {
  return { id, sessionId, agentId: "shell", type: "terminal" };
}

function workspace(tabs: PaneTab[], activeTabId = tabs[0]?.id ?? ""): Workspace {
  return {
    id: "workspace",
    name: "Workspace",
    gridTemplateId: "1x1",
    status: "running",
    createdAt: 1,
    panes: [{
      id: "pane",
      agentId: "shell",
      sessionId: tabs[0]?.sessionId ?? "session",
      tabs,
      activeTabId,
    }],
  };
}

beforeEach(() => {
  useSessionAttentionStore.getState().resetForTests();
  vi.clearAllMocks();
});

describe("canonical attention connection", () => {
  it("listens before snapshot, then replays in-flight events after snapshot ordering", async () => {
    const order: string[] = [];
    let callback: ((payload: SessionStatusChangedPayload) => void) | undefined;
    const unlisten = vi.fn();
    ipcMocks.onSessionStatusChanged.mockImplementation(async (nextCallback) => {
      order.push("listen");
      callback = nextCallback;
      return unlisten;
    });
    ipcMocks.getSessionStatusSnapshot.mockImplementation(async () => {
      order.push("snapshot");
      callback?.(changed(session("session-a", "attention-2", "error", 2, 200), "server", 2));
      return {
        server_epoch: "server",
        seq: 1,
        sessions: [
          session("session-a", "attention-1", "approval", 1, 200),
          session("session-b", "attention-b", "input", 1, 100),
        ],
      };
    });

    const disconnect = await connectSessionAttentionStore();

    expect(order).toEqual(["listen", "snapshot"]);
    expect(useSessionAttentionStore.getState().attentionBySession["session-a"])
      .toMatchObject({ attentionId: "attention-2", kind: "error", sessionRevision: 2 });
    expect(resolveAttentionTabs(
      [tab("tab-a", "session-a"), tab("tab-b", "session-b")],
      useSessionAttentionStore.getState().attentionBySession,
      useSessionAttentionStore.getState().seenAttentionByTab,
    ).map(({ tab: item }) => item.id)).toEqual(["tab-b", "tab-a"]);
    disconnect();
    expect(unlisten).toHaveBeenCalledOnce();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("summarizeUnseenAttention", () => {
  const tabs = [
    tab("tab-a", "session-a"),
    tab("tab-b", "session-b"),
    tab("tab-c", "session-c"),
  ];

  function summarize() {
    const state = useSessionAttentionStore.getState();
    return summarizeUnseenAttention(tabs, state.attentionBySession, state.seenAttentionByTab);
  }

  it("reports nothing when there is no attention at all", () => {
    expect(summarize()).toEqual({ count: 0, category: null });
  });

  it("counts every unseen actionable tab and reports the most urgent category", () => {
    useSessionAttentionStore.getState().applySnapshot(snapshot([
      session("session-a", "attention-a", "done", 1, 100),
      session("session-b", "attention-b", "error", 1, 200),
      session("session-c", "attention-c", "approval", 1, 300),
    ]));

    expect(summarize()).toEqual({ count: 2, category: "waiting" });
  });

  it("does not count a tab whose only unseen attention is done", () => {
    useSessionAttentionStore.getState().applySnapshot(snapshot([
      session("session-a", "attention-a", "done", 1, 100),
    ]));

    expect(summarize()).toEqual({ count: 0, category: null });
  });

  it("drops a tab once its attention has been seen", () => {
    const store = useSessionAttentionStore.getState();
    store.applySnapshot(snapshot([
      session("session-a", "attention-a", "approval", 1, 100),
      session("session-b", "attention-b", "error", 1, 200),
    ]));
    store.markSeen("tab-a", "attention-a");

    expect(summarize()).toEqual({ count: 1, category: "error" });

    useSessionAttentionStore.getState().markSeen("tab-b", "attention-b");
    expect(summarize()).toEqual({ count: 0, category: null });
  });

  it("ignores sessions with no attention id or a resolved 'none' kind", () => {
    useSessionAttentionStore.getState().applySnapshot(snapshot([
      session("session-a", null, "approval", 1, 100),
      session("session-b", "attention-b", "none", 1, 200),
      session("session-c", "attention-c", "input", 1, 300),
    ]));

    expect(summarize()).toEqual({ count: 1, category: "waiting" });
  });
});

describe("seen attention identity", () => {
  it("does not light again for detail changes under the same attention id", () => {
    const store = useSessionAttentionStore.getState();
    store.applySnapshot(snapshot([session("session-a", "attention-1", "approval", 1, 100, "Proceed?")]));
    store.markSeen("tab-a", "attention-1");

    store.applyChanged(changed(session(
      "session-a",
      "attention-1",
      "approval",
      2,
      100,
      "Proceed with the updated command?",
    )));

    const state = useSessionAttentionStore.getState();
    expect(isAttentionUnseen("tab-a", state.attentionBySession["session-a"], state.seenAttentionByTab))
      .toBe(false);
    expect(state.attentionBySession["session-a"].detail).toBe("Proceed with the updated command?");
  });

  it("lights again when attention id changes", () => {
    const store = useSessionAttentionStore.getState();
    store.applySnapshot(snapshot([session("session-a", "attention-1", "approval", 1, 100)]));
    store.markSeen("tab-a", "attention-1");
    store.applyChanged(changed(session("session-a", "attention-2", "approval", 2, 200)));

    const state = useSessionAttentionStore.getState();
    expect(isAttentionUnseen("tab-a", state.attentionBySession["session-a"], state.seenAttentionByTab))
      .toBe(true);
  });

  it("marks only client-local seen state and leaves canonical unresolved attention intact", () => {
    const store = useSessionAttentionStore.getState();
    store.applySnapshot(snapshot([session("session-a", "attention-1", "input", 1, 100)]));
    store.markSeen("tab-a", "attention-1");

    const state = useSessionAttentionStore.getState();
    expect(state.seenAttentionByTab.get("tab-a")).toBe("attention-1");
    expect(state.attentionBySession["session-a"]).toMatchObject({
      attentionId: "attention-1",
      kind: "input",
      sessionRevision: 1,
    });
  });

  it("ignores a stale revision that arrives after a newer event", () => {
    const store = useSessionAttentionStore.getState();
    store.applyChanged(changed(session("session-a", "attention-2", "error", 2, 200)));
    store.applyChanged(changed(session("session-a", "attention-1", "approval", 1, 100)));

    expect(useSessionAttentionStore.getState().attentionBySession["session-a"])
      .toMatchObject({ attentionId: "attention-2", kind: "error", sessionRevision: 2 });
  });

  it("accepts lower revisions after the server epoch changes", () => {
    const store = useSessionAttentionStore.getState();
    store.applyChanged(changed(session("session-a", "old", "error", 9, 900), "old-epoch", 9));
    store.applyChanged(changed(session("session-a", "new", "approval", 1, 100), "new-epoch", 1));

    expect(useSessionAttentionStore.getState()).toMatchObject({
      serverEpoch: "new-epoch",
      lastSeq: 1,
      attentionBySession: {
        "session-a": { attentionId: "new", sessionRevision: 1 },
      },
    });
  });
});

describe("seen attention persistence", () => {
  it("reads valid tab/id pairs and rejects malformed storage", () => {
    const storage = {
      getItem: vi.fn(() => JSON.stringify([["tab-a", "attention-1"], [4, "bad"]])),
      setItem: vi.fn(),
    };
    expect([...readSeenAttention(storage)]).toEqual([["tab-a", "attention-1"]]);
    expect(storage.getItem).toHaveBeenCalledWith(SEEN_ATTENTION_STORAGE_KEY);

    storage.getItem.mockReturnValue("not-json");
    expect([...readSeenAttention(storage)]).toEqual([]);
  });

  it("persists only the tab/id seen map", () => {
    const setItem = vi.fn();
    vi.stubGlobal("window", { localStorage: { getItem: vi.fn(() => null), setItem } });
    useSessionAttentionStore.getState().markSeen("tab-a", "attention-1");

    expect(setItem).toHaveBeenCalledWith(
      SEEN_ATTENTION_STORAGE_KEY,
      JSON.stringify([["tab-a", "attention-1"]]),
    );
  });
});

describe("attention routing", () => {
  it("shows the canonical detail as one line only for input or approval", () => {
    const store = useSessionAttentionStore.getState();
    store.applySnapshot(snapshot([
      session("session-w", "attention-w", "input", 1, 100, "Run this?\nPlease confirm."),
      session("session-e", "attention-e", "error", 1, 200, "Do not display this"),
    ]));
    const state = useSessionAttentionStore.getState();

    expect(attentionDetail(state.attentionBySession["session-w"]))
      .toBe("Run this? Please confirm.");
    expect(attentionDetail(state.attentionBySession["session-e"])).toBeNull();
  });

  it("classifies the upper section and sorts it by occurrence", () => {
    const tabs = [tab("tab-a", "session-a"), tab("tab-b", "session-b"), tab("tab-c", "session-c")];
    const store = useSessionAttentionStore.getState();
    store.applySnapshot(snapshot([
      session("session-a", "attention-a", "done", 1, 300),
      session("session-b", "attention-b", "approval", 1, 100),
      session("session-c", "attention-c", "error", 1, 200),
    ]));
    const state = useSessionAttentionStore.getState();

    expect(resolveAttentionTabs(tabs, state.attentionBySession, state.seenAttentionByTab)
      .map(({ tab: item, category }) => [item.id, category]))
      .toEqual([["tab-b", "waiting"], ["tab-c", "error"], ["tab-a", "done"]]);
  });

  it("keeps seen waiting/error unresolved but removes seen done from the upper section", () => {
    const tabs = [tab("tab-w", "session-w"), tab("tab-e", "session-e"), tab("tab-d", "session-d")];
    const store = useSessionAttentionStore.getState();
    store.applySnapshot(snapshot([
      session("session-w", "attention-w", "input", 1, 100),
      session("session-e", "attention-e", "error", 1, 200),
      session("session-d", "attention-d", "done", 1, 300),
    ]));
    store.markSeen("tab-w", "attention-w");
    store.markSeen("tab-e", "attention-e");
    store.markSeen("tab-d", "attention-d");
    const state = useSessionAttentionStore.getState();

    expect(resolveAttentionTabs(tabs, state.attentionBySession, state.seenAttentionByTab)
      .map(({ tab: item }) => item.id))
      .toEqual(["tab-w", "tab-e"]);
  });

  it("routes waiting before error, excludes unseen done, and rotates after the current target", () => {
    const tabs = [tab("tab-d", "session-d"), tab("tab-e", "session-e"), tab("tab-w", "session-w")];
    const store = useSessionAttentionStore.getState();
    store.applySnapshot(snapshot([
      session("session-d", "attention-d", "done", 1, 100),
      session("session-e", "attention-e", "error", 1, 200),
      session("session-w", "attention-w", "approval", 1, 300),
    ]));
    const state = useSessionAttentionStore.getState();
    const workspaces = [workspace(tabs)];

    expect(resolveNextAttentionTarget(
      workspaces,
      state.attentionBySession,
      state.seenAttentionByTab,
      null,
    )?.tab.id).toBe("tab-w");
    expect(resolveNextAttentionTarget(
      workspaces,
      state.attentionBySession,
      state.seenAttentionByTab,
      "tab-w",
    )?.tab.id).toBe("tab-e");
    expect(resolveNextAttentionTarget(
      workspaces,
      state.attentionBySession,
      state.seenAttentionByTab,
      "tab-e",
    )?.tab.id).toBe("tab-w");
  });

  it("returns null when no attention target exists", () => {
    const tabs = [tab("tab-a", "session-a")];
    const store = useSessionAttentionStore.getState();
    store.applySnapshot(snapshot([session("session-a", null, "none", 1, 0)]));
    const state = useSessionAttentionStore.getState();

    expect(resolveNextAttentionTarget(
      [workspace(tabs)],
      state.attentionBySession,
      state.seenAttentionByTab,
      "tab-a",
    )).toBeNull();
  });

  it("returns null when the current tab is the only attention target", () => {
    const tabs = [tab("tab-a", "session-a")];
    const store = useSessionAttentionStore.getState();
    store.applySnapshot(snapshot([session("session-a", "attention-a", "input", 1, 100)]));
    const state = useSessionAttentionStore.getState();

    expect(resolveNextAttentionTarget(
      [workspace(tabs)],
      state.attentionBySession,
      state.seenAttentionByTab,
      "tab-a",
    )).toBeNull();
  });
});
