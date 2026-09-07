import { describe, expect, it } from "vitest";
import { buildNotificationPanelModel } from "../../src/lib/notificationPanelModel";
import { collectNotificationEntries, countNotifications } from "../../src/lib/notificationEntries";
import type { PaneMetadata } from "../../src/stores/paneMetadataStore";
import type { Workspace } from "../../src/types";

function workspace(sessionIds: string[]): Workspace {
  return {
    id: "ws",
    name: "Workspace",
    panes: [{
      id: "pane",
      sessionId: sessionIds[0] ?? "pane-session",
      agentId: "shell-starter",
      tabs: sessionIds.map((sessionId, index) => ({
        id: `tab-${index}`,
        sessionId,
        agentId: "shell-starter",
        label: `タブ${index}`,
      })),
      activeTabId: "tab-0",
    }],
  } as unknown as Workspace;
}

const waiting = (count: number): PaneMetadata => ({ notificationCount: count });

describe("notification entries", () => {
  it("lists one entry per live tab that has notifications", () => {
    const entries = collectNotificationEntries(
      [workspace(["a", "b", "c"])],
      { a: waiting(1), b: waiting(3), c: {} },
    );

    expect(entries.map((entry) => [entry.sessionId, entry.count])).toEqual([["b", 3], ["a", 1]]);
  });

  it("ignores metadata for sessions this window no longer owns", () => {
    const metadata = { live: waiting(1), orphan: waiting(9) };

    expect(countNotifications([workspace(["live"])], metadata)).toBe(1);
    expect(collectNotificationEntries([workspace(["live"])], metadata)).toHaveLength(1);
  });

  it("agrees with the panel when nothing is live", () => {
    // The legacy collector and the two-section panel both exclude orphan sessions.
    const metadata = { orphan: waiting(4) };

    expect(countNotifications([], metadata)).toBe(0);
    expect(collectNotificationEntries([], metadata)).toEqual([]);
    expect(buildNotificationPanelModel([], {}, metadata).unreadCount).toBe(0);
  });

  it("keeps the legacy sidebar count while the bell also includes completion arrivals", () => {
    const ws = workspace(["a", "b"]);
    const metadata = { a: { notificationCount: 2 }, b: { workDoneCount: 3 } };
    expect(countNotifications([ws], metadata)).toBe(2);
    expect(collectNotificationEntries([ws], metadata)).toHaveLength(1);
    const model = buildNotificationPanelModel([ws], {}, metadata);
    expect(model.unreadCount).toBe(5);
    expect(model.unread.map((row) => row.sessionId)).toEqual(["b", "a"]);
  });
});
