import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";

describe("paneMetadataStore notification clearing", () => {
  beforeEach(() => {
    usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {}, lastLog: {}, lastLogAt: {} });
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
