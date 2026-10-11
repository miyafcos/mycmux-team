import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";

describe("paneMetadataStore notification clearing", () => {
  beforeEach(() => {
    usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {}, lastLog: {}, lastLogAt: {} });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("INTEG-4 keeps observation-only state stable below 30 seconds and publishes at the boundary", () => {
    let now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const evidence = { agentSessionId: "conversation", startedAt: now - 1000 };
    usePaneMetadataStore.getState().setLiveAgent("session", "claude", true, evidence);
    const before = usePaneMetadataStore.getState();
    now += 29_999;
    before.setLiveAgent("session", "claude", true, evidence);
    expect(usePaneMetadataStore.getState()).toBe(before);
    now++;
    before.setLiveAgent("session", "claude", true, evidence);
    expect(usePaneMetadataStore.getState().volatileMetadata.session.liveAgentObservedAt).toBe(now);
    expect(usePaneMetadataStore.getState().volatileMetadata.session.liveAgentChangedAt).toBe(now - 30_000);
  });

  it("INTEG-4 publishes identity changes and process exits inside the observation window", () => {
    let now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const store = usePaneMetadataStore.getState();
    store.setLiveAgent("session", "claude", true, { agentSessionId: "A", startedAt: now - 1000 });
    now++;
    store.setLiveAgent("session", "claude", true, { agentSessionId: "B", startedAt: now });
    expect(usePaneMetadataStore.getState().volatileMetadata.session).toMatchObject({ liveAgentSessionId: "B", liveAgentObservedAt: now, liveAgentChangedAt: now });
    now++;
    store.setLiveAgent("session", null, false);
    expect(usePaneMetadataStore.getState().volatileMetadata.session).toMatchObject({ liveAgentKind: null, ptyAlive: false, liveAgentObservedAt: now });
  });

  it("INTEG-4 rebases observation uncertainty immediately after clock rollback", () => {
    let now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const store = usePaneMetadataStore.getState();
    store.setLiveAgent("session", "claude", true);
    now -= 3_600_000;
    store.setLiveAgent("session", "claude", true);
    expect(usePaneMetadataStore.getState().volatileMetadata.session).toMatchObject({
      liveAgentObservedAt: now, liveAgentChangedAt: now, liveAgentIdentityUnknownSince: now, liveAgentStartUnknownSince: now,
    });
  });

  it("keeps state references stable when notification counters are already zero", () => {
    usePaneMetadataStore.setState({
      metadata: { session: { notificationCount: 0, workDoneCount: 0 } },
    });
    const before = usePaneMetadataStore.getState();
    const listener = vi.fn();
    const unsubscribe = usePaneMetadataStore.subscribe(listener);

    before.clearNotification("session");

    expect(usePaneMetadataStore.getState()).toBe(before);
    expect(usePaneMetadataStore.getState().metadata).toBe(before.metadata);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("clears a real notification exactly once", () => {
    usePaneMetadataStore.setState({
      metadata: { session: { notificationCount: 2, workDoneCount: 1 } },
    });
    const listener = vi.fn();
    const unsubscribe = usePaneMetadataStore.subscribe(listener);

    usePaneMetadataStore.getState().clearNotification("session");
    usePaneMetadataStore.getState().clearNotification("session");

    expect(usePaneMetadataStore.getState().metadata.session).toMatchObject({
      notificationCount: 0,
      workDoneCount: 0,
    });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("timestamps effective status changes without refreshing unchanged states", () => {
    const now = vi.spyOn(Date, "now")
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(200);

    usePaneMetadataStore.getState().setMetadata("session", { processIsShell: false });
    expect(usePaneMetadataStore.getState().metadata.session.agentStatusAt).toBe(100);

    usePaneMetadataStore.getState().setMetadata("session", { processIsShell: false });
    expect(usePaneMetadataStore.getState().metadata.session.agentStatusAt).toBe(100);

    usePaneMetadataStore.getState().setMetadata("session", { processIsShell: true });
    expect(usePaneMetadataStore.getState().metadata.session.agentStatusAt).toBe(200);
    expect(now).toHaveBeenCalledTimes(2);
  });

  it("timestamps the transition away from waiting", () => {
    vi.spyOn(Date, "now").mockReturnValue(300);
    usePaneMetadataStore.setState({
      metadata: {
        session: {
          agentStatus: "waiting",
          agentStatusAt: 100,
          processIsShell: false,
        },
      },
    });

    usePaneMetadataStore.getState().clearAgentStatus("session");

    expect(usePaneMetadataStore.getState().metadata.session).toMatchObject({
      agentStatus: undefined,
      agentStatusAt: 300,
      processIsShell: false,
    });
  });

  it("timestamps a direct transition into waiting", () => {
    vi.spyOn(Date, "now").mockReturnValue(400);
    usePaneMetadataStore.setState({
      metadata: {
        session: {
          agentStatusAt: 100,
          processIsShell: false,
        },
      },
    });

    usePaneMetadataStore.getState().notifyWaiting("session", 1);

    expect(usePaneMetadataStore.getState().metadata.session).toMatchObject({
      agentStatus: "waiting",
      agentStatusAt: 400,
      screenStatusAt: 400,
    });
  });

  it("does not synthesize process evidence from legacy status timestamps", () => {
    usePaneMetadataStore.setState({
      metadata: {
        first: { processIsShell: false, agentStatusAt: 500 },
        second: { processIsShell: false, agentStatusAt: 500 },
      },
    });

    expect(usePaneMetadataStore.getState().metadata.first).not.toHaveProperty("processStatusAt");
    expect(usePaneMetadataStore.getState().metadata.second).not.toHaveProperty("processStatusAt");
  });

  it("keeps persistent metadata stable across volatile terminal updates", () => {
    const store = usePaneMetadataStore.getState();
    store.setMetadata("session", { cwd: "C:\\work", processIsShell: false });
    const before = usePaneMetadataStore.getState();

    before.setVolatileMetadata("session", {
      processTitle: "codex",
      outputActive: true,
      workingPatternVisible: true,
      backendLastOutputAt: 1_234,
    });

    const after = usePaneMetadataStore.getState();
    expect(after.metadata).toBe(before.metadata);
    expect(after.metadata.session).not.toMatchObject({ processTitle: "codex" });
    expect(after.volatileMetadata).not.toBe(before.volatileMetadata);
    expect(after.volatileMetadata.session).toEqual({
      processTitle: "codex",
      outputActive: true,
      workingPatternVisible: true,
      backendLastOutputAt: 1_234,
    });

    after.removeMetadata("session");
    expect(usePaneMetadataStore.getState().volatileMetadata.session).toBeUndefined();
  });
});
