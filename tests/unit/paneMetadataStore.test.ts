import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";

describe("paneMetadataStore notification clearing", () => {
  beforeEach(() => {
    usePaneMetadataStore.setState({ metadata: {}, lastLog: {} });
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
});
