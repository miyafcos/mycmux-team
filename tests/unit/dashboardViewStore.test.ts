// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function setViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
}

async function loadStore() {
  vi.resetModules();
  return import("../../src/stores/dashboardViewStore");
}

beforeEach(() => {
  window.localStorage.clear();
  setViewportWidth(1200);
});

afterEach(() => {
  window.localStorage.clear();
  vi.resetModules();
});

describe("dashboard minimap width store", () => {
  it("clamps invalid, lower, and upper action values to a readable range", async () => {
    const {
      DASHBOARD_MINIMAP_DEFAULT_WIDTH,
      DASHBOARD_MINIMAP_MIN_WIDTH,
      DASHBOARD_MINIMAP_STORAGE_KEY,
      dashboardMinimapMaxWidth,
      useDashboardViewStore,
    } = await loadStore();

    useDashboardViewStore.getState().setMinimapWidth(0);
    expect(useDashboardViewStore.getState().minimapWidth).toBe(DASHBOARD_MINIMAP_MIN_WIDTH);
    useDashboardViewStore.getState().setMinimapWidth(-200);
    expect(useDashboardViewStore.getState().minimapWidth).toBe(DASHBOARD_MINIMAP_MIN_WIDTH);
    useDashboardViewStore.getState().setMinimapWidth(Number.NaN);
    expect(useDashboardViewStore.getState().minimapWidth).toBe(DASHBOARD_MINIMAP_DEFAULT_WIDTH);
    useDashboardViewStore.getState().setMinimapWidth(10_000);
    expect(useDashboardViewStore.getState().minimapWidth).toBe(dashboardMinimapMaxWidth(1200));
    expect(window.localStorage.getItem(DASHBOARD_MINIMAP_STORAGE_KEY)).toBe(String(dashboardMinimapMaxWidth(1200)));
  });

  it("restores a persisted width in a fresh store and defaults malformed storage", async () => {
    const { DASHBOARD_MINIMAP_STORAGE_KEY } = await loadStore();
    window.localStorage.setItem(DASHBOARD_MINIMAP_STORAGE_KEY, "420");
    const restored = await loadStore();
    expect(restored.useDashboardViewStore.getState().minimapWidth).toBe(420);

    window.localStorage.setItem(DASHBOARD_MINIMAP_STORAGE_KEY, "not-a-number");
    const malformed = await loadStore();
    expect(malformed.useDashboardViewStore.getState().minimapWidth).toBe(malformed.DASHBOARD_MINIMAP_DEFAULT_WIDTH);
  });

  it("keeps 360px for the chat before applying the 45 percent maximum", async () => {
    const { dashboardMinimapMaxWidth } = await loadStore();
    expect(dashboardMinimapMaxWidth(1200)).toBe(540);
    expect(dashboardMinimapMaxWidth(1000)).toBe(376);
  });
});

describe("dashboard chat columns", () => {
  it("keeps selectedTabId synchronized with click replacement, drop addition, activation, and close", async () => {
    const { DASHBOARD_CHAT_COLUMN_LIMIT, useDashboardViewStore } = await loadStore();
    const store = useDashboardViewStore.getState();

    store.setSelectedTabId("tab-a");
    store.addChatColumn("tab-b");
    expect(useDashboardViewStore.getState()).toMatchObject({
      chatColumnTabIds: ["tab-a", "tab-b"], activeChatColumn: 1, selectedTabId: "tab-b",
    });

    store.setSelectedTabId("tab-c");
    expect(useDashboardViewStore.getState()).toMatchObject({
      chatColumnTabIds: ["tab-a", "tab-c"], activeChatColumn: 1, selectedTabId: "tab-c",
    });
    store.setActiveChatColumn(0);
    expect(useDashboardViewStore.getState().selectedTabId).toBe("tab-a");

    store.addChatColumn("tab-b");
    store.addChatColumn("tab-c");
    store.addChatColumn("tab-d");
    expect(useDashboardViewStore.getState().chatColumnTabIds).toHaveLength(DASHBOARD_CHAT_COLUMN_LIMIT);
    expect(useDashboardViewStore.getState().chatColumnTabIds).not.toContain("tab-d");
    store.removeChatColumn(1);
    expect(useDashboardViewStore.getState().selectedTabId).toBe(useDashboardViewStore.getState().chatColumnTabIds[useDashboardViewStore.getState().activeChatColumn]);
  });

  it("reorders columns by measured slots while the active tab follows its column", async () => {
    const { useDashboardViewStore } = await loadStore();
    const store = useDashboardViewStore.getState();

    store.setSelectedTabId("tab-a");
    store.addChatColumn("tab-b");
    store.addChatColumn("tab-c");
    store.moveChatColumn(0, 2);
    expect(useDashboardViewStore.getState().chatColumnTabIds).toEqual(["tab-b", "tab-a", "tab-c"]);

    useDashboardViewStore.setState({ chatColumnTabIds: ["tab-a", "tab-b", "tab-c"], activeChatColumn: 2, selectedTabId: "tab-c" });
    store.moveChatColumn(2, 0);
    expect(useDashboardViewStore.getState()).toMatchObject({
      chatColumnTabIds: ["tab-c", "tab-a", "tab-b"], activeChatColumn: 0, selectedTabId: "tab-c",
    });

    const beforeNoOp = useDashboardViewStore.getState().chatColumnTabIds;
    store.moveChatColumn(-1, 0);
    store.moveChatColumn(0, 0);
    store.moveChatColumn(0, 1);
    expect(useDashboardViewStore.getState().chatColumnTabIds).toBe(beforeNoOp);

    useDashboardViewStore.setState({ chatColumnTabIds: ["tab-a", "tab-b", "tab-c"], activeChatColumn: 0, selectedTabId: "tab-a" });
    store.moveChatColumn(0, 3);
    expect(useDashboardViewStore.getState()).toMatchObject({
      chatColumnTabIds: ["tab-b", "tab-c", "tab-a"], activeChatColumn: 2, selectedTabId: "tab-a",
    });
  });

  it("inserts new columns at a clamped slot and moves existing columns without exceeding the cap", async () => {
    const { useDashboardViewStore } = await loadStore();
    const store = useDashboardViewStore.getState();

    store.setSelectedTabId("tab-a");
    store.insertChatColumn("tab-b", -10);
    store.insertChatColumn("tab-c", 99);
    expect(useDashboardViewStore.getState()).toMatchObject({
      chatColumnTabIds: ["tab-b", "tab-a", "tab-c"], activeChatColumn: 2, selectedTabId: "tab-c",
    });

    store.setActiveChatColumn(1);
    store.insertChatColumn("tab-b", 3);
    expect(useDashboardViewStore.getState()).toMatchObject({
      chatColumnTabIds: ["tab-a", "tab-c", "tab-b"], activeChatColumn: 0, selectedTabId: "tab-a",
    });

    const beforeFull = useDashboardViewStore.getState().chatColumnTabIds;
    store.insertChatColumn("tab-d", 1);
    expect(useDashboardViewStore.getState().chatColumnTabIds).toBe(beforeFull);
  });
});

describe("openDashboardForTab", () => {
  it("clears filters and selects the tab before opening the view", async () => {
    const { useDashboardViewStore } = await loadStore();
    const { openDashboardForTab } = await import("../../src/components/layout/openDashboardForTab");
    const store = useDashboardViewStore.getState();
    store.setQuery("codex");
    store.setStateFilter("needsHuman");
    store.setWorkspaceFilter("ws-other");
    store.setAgentFilter("claude");

    openDashboardForTab("tab-target");

    // フィルタが残っていると対象カードが消えて別セッションに落ちるので、
    // 選択より先に全部落としてから開く。
    expect(useDashboardViewStore.getState()).toMatchObject({
      open: true,
      query: "",
      stateFilter: null,
      workspaceFilter: null,
      agentFilter: null,
      selectedTabId: "tab-target",
    });
    expect(useDashboardViewStore.getState().chatColumnTabIds).toContain("tab-target");
  });
});
