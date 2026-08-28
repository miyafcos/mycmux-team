import { describe, expect, it, vi } from "vitest";

import {
  acquireGroupingPanelOpen,
  getGroupingPanelOpen,
  subscribeGroupingPanelOpen,
} from "../../src/components/layout/groupingPanelPresence";

describe("groupingPanelPresence", () => {
  it("reference-counts acquire and releases with an idempotent disposer", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeGroupingPanelOpen(listener);
    const releaseOne = acquireGroupingPanelOpen();
    const releaseTwo = acquireGroupingPanelOpen();
    expect(getGroupingPanelOpen()).toBe(true);

    releaseOne();
    expect(getGroupingPanelOpen()).toBe(true);
    releaseOne();
    expect(getGroupingPanelOpen()).toBe(true);
    releaseTwo();
    expect(getGroupingPanelOpen()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
