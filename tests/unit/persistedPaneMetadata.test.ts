import { afterEach, describe, expect, it, vi } from "vitest";
import { persistedPaneMetadataChanged, subscribePersistedPaneMetadata } from "../../src/components/layout/SocketListener";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
const initial = usePaneMetadataStore.getState();
afterEach(() => usePaneMetadataStore.setState(initial, true));
describe("actual metadata subscriptions for saving and fragments", () => {
  it("schedules neither stream for display-only changes, and both for each saved field", () => {
    usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {}, lastLog: {}, lastLogAt: {} });
    const save = vi.fn(); const publish = vi.fn();
    const stopSave = subscribePersistedPaneMetadata(save);
    const stopPublish = subscribePersistedPaneMetadata(publish);
    const store = usePaneMetadataStore.getState();
    try {
      for (let i = 0; i < 1000; i++) {
        store.setMetadata("session", { agentStatus: i % 2 ? "working" : "waiting", gitBranch: "branch-" + i });
        store.incrementNotification("session");
        store.setMetadata("session", { lastLogLine: "output-" + i, processTitle: "claude", backendLastOutputAt: i });
      }
      expect(save).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      for (const change of [{ cwd: "/project" }, { agentKind: "claude" as const }, { agentSessionId: "conversation" }, { claudeSessionId: "conversation" }]) store.setMetadata("session", change);
      expect(save).toHaveBeenCalledTimes(4);
      expect(publish).toHaveBeenCalledTimes(4);
      store.setMetadata("session", { cwd: "/project" });
      expect(save).toHaveBeenCalledTimes(4);
      store.removeMetadata("session");
      expect(save).toHaveBeenCalledTimes(5);
      expect(publish).toHaveBeenCalledTimes(5);
    } finally { stopSave(); stopPublish(); }
    store.setMetadata("session", { cwd: "/other" });
    expect(save).toHaveBeenCalledTimes(5);
  });
  it("ignores adding and removing empty/UI-only records", () => {
    expect(persistedPaneMetadataChanged({ session: {} }, {})).toBe(false);
    expect(persistedPaneMetadataChanged({}, { session: { notificationCount: 1 } })).toBe(false);
  });
});
