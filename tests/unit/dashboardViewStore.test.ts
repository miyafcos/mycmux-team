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

describe("dashboard session list collapsed store", () => {
  it("defaults to expanded and persists a toggle to localStorage", async () => {
    const {
      DASHBOARD_SESSION_LIST_COLLAPSED_STORAGE_KEY,
      useDashboardViewStore,
    } = await loadStore();

    expect(useDashboardViewStore.getState().sessionListCollapsed).toBe(false);
    expect(window.localStorage.getItem(DASHBOARD_SESSION_LIST_COLLAPSED_STORAGE_KEY)).toBeNull();

    useDashboardViewStore.getState().toggleSessionListCollapsed();
    expect(useDashboardViewStore.getState().sessionListCollapsed).toBe(true);
    expect(window.localStorage.getItem(DASHBOARD_SESSION_LIST_COLLAPSED_STORAGE_KEY)).toBe("true");

    useDashboardViewStore.getState().toggleSessionListCollapsed();
    expect(useDashboardViewStore.getState().sessionListCollapsed).toBe(false);
    expect(window.localStorage.getItem(DASHBOARD_SESSION_LIST_COLLAPSED_STORAGE_KEY)).toBe("false");
  });

  it("restores collapsed from storage in a fresh store", async () => {
    const { DASHBOARD_SESSION_LIST_COLLAPSED_STORAGE_KEY } = await loadStore();
    window.localStorage.setItem(DASHBOARD_SESSION_LIST_COLLAPSED_STORAGE_KEY, "true");
    const restored = await loadStore();
    expect(restored.useDashboardViewStore.getState().sessionListCollapsed).toBe(true);
  });

  it("subtracts the collapsed list width when computing minimap max", async () => {
    const { dashboardMinimapMaxWidth } = await loadStore();
    expect(dashboardMinimapMaxWidth(1000)).toBe(376);
    expect(dashboardMinimapMaxWidth(1000, true)).toBe(450);
    expect(dashboardMinimapMaxWidth(1200, true)).toBe(540);
  });
});

describe("dashboard chat columns", () => {
  it("keeps selectedTabId synchronized with focus, drop addition, activation, and close", async () => {
    const { useDashboardViewStore } = await loadStore();
    const store = useDashboardViewStore.getState();

    store.setSelectedTabId("tab-a");
    store.addChatColumn("tab-b");
    expect(useDashboardViewStore.getState()).toMatchObject({
      chatColumnTabIds: ["tab-a", "tab-b"], activeChatColumn: 1, selectedTabId: "tab-b",
    });

    store.setSelectedTabId("tab-c");
    expect(useDashboardViewStore.getState()).toMatchObject({
      chatColumnTabIds: ["tab-a", "tab-b", "tab-c"], activeChatColumn: 2, selectedTabId: "tab-c",
    });
    store.setActiveChatColumn(0);
    expect(useDashboardViewStore.getState().selectedTabId).toBe("tab-a");

    store.addChatColumn("tab-d");
    expect(useDashboardViewStore.getState()).toMatchObject({
      chatColumnTabIds: ["tab-a", "tab-c", "tab-d"],
      activeChatColumn: 2,
      selectedTabId: "tab-d",
    });
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

    store.insertChatColumn("tab-d", 1);
    expect(useDashboardViewStore.getState()).toMatchObject({
      chatColumnTabIds: ["tab-a", "tab-d", "tab-b"],
      activeChatColumn: 1,
      selectedTabId: "tab-d",
    });
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

describe("dashboard multi-open chat columns", () => {
  it("branches click toggle as add, focus-only, then close", async () => {
    const { useDashboardViewStore } = await loadStore();
    const store = useDashboardViewStore.getState();

    store.toggleChatColumn("tab-a");
    store.toggleChatColumn("tab-b");
    expect(useDashboardViewStore.getState()).toMatchObject({
      chatColumnTabIds: ["tab-a", "tab-b"],
      activeChatColumn: 1,
      selectedTabId: "tab-b",
    });

    store.toggleChatColumn("tab-a");
    expect(useDashboardViewStore.getState()).toMatchObject({
      chatColumnTabIds: ["tab-a", "tab-b"],
      activeChatColumn: 0,
      selectedTabId: "tab-a",
    });

    store.toggleChatColumn("tab-a");
    expect(useDashboardViewStore.getState()).toMatchObject({
      chatColumnTabIds: ["tab-b"],
      activeChatColumn: 0,
      selectedTabId: "tab-b",
    });
  });

  it("evicts the oldest column with FIFO when a fourth is toggled at the default cap", async () => {
    const { useDashboardViewStore } = await loadStore();
    const store = useDashboardViewStore.getState();
    store.toggleChatColumn("tab-a");
    store.toggleChatColumn("tab-b");
    store.toggleChatColumn("tab-c");
    store.toggleChatColumn("tab-d");
    expect(useDashboardViewStore.getState()).toMatchObject({
      chatColumnTabIds: ["tab-b", "tab-c", "tab-d"],
      activeChatColumn: 2,
      selectedTabId: "tab-d",
    });
  });

  it("replaces the single column each click when the limit is 1", async () => {
    const { useDashboardViewStore } = await loadStore();
    const store = useDashboardViewStore.getState();
    store.setChatColumnLimit(1);
    store.toggleChatColumn("tab-a");
    store.toggleChatColumn("tab-b");
    expect(useDashboardViewStore.getState()).toMatchObject({
      chatColumnLimit: 1,
      chatColumnTabIds: ["tab-b"],
      activeChatColumn: 0,
      selectedTabId: "tab-b",
    });
    store.toggleChatColumn("tab-c");
    expect(useDashboardViewStore.getState().chatColumnTabIds).toEqual(["tab-c"]);
  });

  it("keeps the newest columns when the limit is lowered from 5 to 2", async () => {
    const { useDashboardViewStore } = await loadStore();
    const store = useDashboardViewStore.getState();
    store.setChatColumnLimit(5);
    store.toggleChatColumn("tab-a");
    store.toggleChatColumn("tab-b");
    store.toggleChatColumn("tab-c");
    store.toggleChatColumn("tab-d");
    store.toggleChatColumn("tab-e");
    store.setChatColumnLimit(2);
    expect(useDashboardViewStore.getState()).toMatchObject({
      chatColumnLimit: 2,
      chatColumnTabIds: ["tab-d", "tab-e"],
    });
  });

  it("counts the report inbox as a column and evicts it with FIFO", async () => {
    const { DASHBOARD_INBOX_COLUMN_ID, useDashboardViewStore } = await loadStore();
    const store = useDashboardViewStore.getState();
    store.toggleChatColumn("tab-a");
    store.toggleChatColumn("tab-b");
    store.toggleChatColumn(DASHBOARD_INBOX_COLUMN_ID);
    expect(useDashboardViewStore.getState().chatColumnTabIds).toEqual(["tab-a", "tab-b", DASHBOARD_INBOX_COLUMN_ID]);
    store.toggleChatColumn("tab-c");
    expect(useDashboardViewStore.getState()).toMatchObject({
      chatColumnTabIds: ["tab-b", DASHBOARD_INBOX_COLUMN_ID, "tab-c"],
      selectedTabId: "tab-c",
    });
  });

  it("allows the last open column to close to an empty layout", async () => {
    const { useDashboardViewStore } = await loadStore();
    const store = useDashboardViewStore.getState();
    store.toggleChatColumn("tab-a");
    store.toggleChatColumn("tab-a");
    expect(useDashboardViewStore.getState()).toMatchObject({
      chatColumnTabIds: [],
      activeChatColumn: 0,
      selectedTabId: null,
    });
  });

  it("keeps an already active column open when focusChatColumn is used", async () => {
    const { useDashboardViewStore } = await loadStore();
    const store = useDashboardViewStore.getState();
    store.toggleChatColumn("tab-a");
    store.focusChatColumn("tab-a");
    expect(useDashboardViewStore.getState()).toMatchObject({
      chatColumnTabIds: ["tab-a"],
      activeChatColumn: 0,
      selectedTabId: "tab-a",
    });
  });

  it("keeps the previously active column when the limit drops from 5 to 2", async () => {
    const { useDashboardViewStore } = await loadStore();
    const store = useDashboardViewStore.getState();
    store.setChatColumnLimit(5);
    store.toggleChatColumn("tab-a");
    store.toggleChatColumn("tab-b");
    store.toggleChatColumn("tab-c");
    store.toggleChatColumn("tab-d");
    store.toggleChatColumn("tab-e");
    store.setActiveChatColumn(0);
    store.setChatColumnLimit(2);
    expect(useDashboardViewStore.getState()).toMatchObject({
      chatColumnLimit: 2,
      chatColumnTabIds: ["tab-a", "tab-e"],
      activeChatColumn: 0,
      selectedTabId: "tab-a",
    });
  });

  it("evicts the inactive column instead of the active one when opening past the cap", async () => {
    const { useDashboardViewStore } = await loadStore();
    const store = useDashboardViewStore.getState();
    store.setChatColumnLimit(2);
    store.toggleChatColumn("tab-a");
    store.toggleChatColumn("tab-b");
    store.setActiveChatColumn(0);
    store.toggleChatColumn("tab-c");
    expect(useDashboardViewStore.getState()).toMatchObject({
      chatColumnTabIds: ["tab-a", "tab-c"],
      activeChatColumn: 1,
      selectedTabId: "tab-c",
    });
  });

  it("does not open a new column when every open column is pinned", async () => {
    const { useDashboardViewStore } = await loadStore();
    const { useToastStore } = await import("../../src/stores/toastStore");
    const store = useDashboardViewStore.getState();
    store.setChatColumnLimit(2);
    store.toggleChatColumn("tab-a");
    store.toggleChatColumn("tab-b");
    store.toggleChatColumnPin("tab-a");
    store.toggleChatColumnPin("tab-b");
    const before = useDashboardViewStore.getState();
    store.toggleChatColumn("tab-c");
    expect(useDashboardViewStore.getState()).toMatchObject({
      chatColumnTabIds: ["tab-a", "tab-b"],
      activeChatColumn: before.activeChatColumn,
      selectedTabId: before.selectedTabId,
      pinnedChatColumnTabIds: ["tab-a", "tab-b"],
    });
    expect(useToastStore.getState().toasts.map((toast) => toast.message)).toContain(
      "全ての列が固定されています。固定を外すか上限を上げてください",
    );
  });

  it("does not toast when browsing to a blocked tab via setSelectedTabId", async () => {
    const { useDashboardViewStore } = await loadStore();
    const { useToastStore } = await import("../../src/stores/toastStore");
    const store = useDashboardViewStore.getState();
    store.setChatColumnLimit(2);
    store.toggleChatColumn("tab-a");
    store.toggleChatColumn("tab-b");
    store.toggleChatColumnPin("tab-a");
    store.toggleChatColumnPin("tab-b");
    const before = useDashboardViewStore.getState();
    store.setSelectedTabId("tab-c");
    expect(useDashboardViewStore.getState()).toMatchObject({
      chatColumnTabIds: ["tab-a", "tab-b"],
      activeChatColumn: before.activeChatColumn,
      selectedTabId: before.selectedTabId,
      pinnedChatColumnTabIds: ["tab-a", "tab-b"],
    });
    expect(useToastStore.getState().toasts.map((toast) => toast.message)).not.toContain(
      "全ての列が固定されています。固定を外すか上限を上げてください",
    );
  });

  it("still toasts when explicitly focusing a blocked tab", async () => {
    const { useDashboardViewStore } = await loadStore();
    const { useToastStore } = await import("../../src/stores/toastStore");
    const store = useDashboardViewStore.getState();
    store.setChatColumnLimit(2);
    store.toggleChatColumn("tab-a");
    store.toggleChatColumn("tab-b");
    store.toggleChatColumnPin("tab-a");
    store.toggleChatColumnPin("tab-b");
    const before = useDashboardViewStore.getState();
    store.focusChatColumn("tab-c");
    expect(useDashboardViewStore.getState()).toMatchObject({
      chatColumnTabIds: ["tab-a", "tab-b"],
      activeChatColumn: before.activeChatColumn,
      selectedTabId: before.selectedTabId,
      pinnedChatColumnTabIds: ["tab-a", "tab-b"],
    });
    expect(useToastStore.getState().toasts.map((toast) => toast.message)).toContain(
      "全ての列が固定されています。固定を外すか上限を上げてください",
    );
  });

  it("keeps pinned columns when opening past the cap", async () => {
    const { useDashboardViewStore } = await loadStore();
    const store = useDashboardViewStore.getState();
    store.setChatColumnLimit(2);
    store.toggleChatColumn("tab-a");
    store.toggleChatColumn("tab-b");
    store.toggleChatColumnPin("tab-a");
    store.setActiveChatColumn(0);
    store.toggleChatColumn("tab-c");
    expect(useDashboardViewStore.getState()).toMatchObject({
      chatColumnTabIds: ["tab-a", "tab-c"],
      activeChatColumn: 1,
      selectedTabId: "tab-c",
      pinnedChatColumnTabIds: ["tab-a"],
    });
  });

  it("drops a column pin when that column closes", async () => {
    const { DASHBOARD_CHAT_COLUMN_PINS_STORAGE_KEY, useDashboardViewStore } = await loadStore();
    const store = useDashboardViewStore.getState();
    store.toggleChatColumn("tab-a");
    store.toggleChatColumn("tab-b");
    store.toggleChatColumnPin("tab-a");
    expect(JSON.parse(window.localStorage.getItem(DASHBOARD_CHAT_COLUMN_PINS_STORAGE_KEY) ?? "[]")).toEqual(["tab-a"]);
    store.removeChatColumn(0);
    expect(useDashboardViewStore.getState()).toMatchObject({
      chatColumnTabIds: ["tab-b"],
      pinnedChatColumnTabIds: [],
    });
    expect(JSON.parse(window.localStorage.getItem(DASHBOARD_CHAT_COLUMN_PINS_STORAGE_KEY) ?? "[]")).toEqual([]);
  });

  it("restores pinned columns from storage in a fresh store", async () => {
    const { DASHBOARD_CHAT_COLUMN_PINS_STORAGE_KEY } = await loadStore();
    window.localStorage.setItem(DASHBOARD_CHAT_COLUMN_PINS_STORAGE_KEY, JSON.stringify(["tab-keep"]));
    const restored = await loadStore();
    expect(restored.useDashboardViewStore.getState().pinnedChatColumnTabIds).toEqual(["tab-keep"]);
  });
});

describe("dashboard preview column", () => {
  it("adds one preview column and evicts with the same FIFO rule as other columns", async () => {
    const { DASHBOARD_PREVIEW_COLUMN_ID, useDashboardViewStore } = await loadStore();
    const store = useDashboardViewStore.getState();
    store.toggleChatColumn("tab-a");
    store.openOrReloadPreviewColumn({
      previewPath: "C:/tmp/a.html",
      sourcePath: "C:/tmp/a.html",
      sourceKind: "html",
    });
    expect(useDashboardViewStore.getState().chatColumnTabIds).toEqual(["tab-a", DASHBOARD_PREVIEW_COLUMN_ID]);
    expect(useDashboardViewStore.getState().previewColumn).toMatchObject({
      htmlPath: "C:/tmp/a.html",
      sourcePath: "C:/tmp/a.html",
      sourceKind: "html",
      previewPath: "C:/tmp/a.html",
      isDirty: false,
    });

    store.toggleChatColumn("tab-b");
    store.toggleChatColumn("tab-c");
    expect(useDashboardViewStore.getState().chatColumnTabIds).toEqual([
      DASHBOARD_PREVIEW_COLUMN_ID,
      "tab-b",
      "tab-c",
    ]);
  });

  it("replaces the preview contents instead of opening a second preview column", async () => {
    const { DASHBOARD_PREVIEW_COLUMN_ID, useDashboardViewStore } = await loadStore();
    const store = useDashboardViewStore.getState();
    store.toggleChatColumn("tab-a");
    store.openOrReloadPreviewColumn({
      previewPath: "C:/tmp/a.html",
      sourcePath: "C:/tmp/a.html",
      sourceKind: "html",
    });
    store.openOrReloadPreviewColumn({
      previewPath: "C:/tmp/b.html",
      sourcePath: "C:/tmp/b.html",
      sourceKind: "html",
    });
    expect(useDashboardViewStore.getState().chatColumnTabIds.filter((tabId) => tabId === DASHBOARD_PREVIEW_COLUMN_ID)).toHaveLength(1);
    expect(useDashboardViewStore.getState().chatColumnTabIds).toEqual(["tab-a", DASHBOARD_PREVIEW_COLUMN_ID]);
    expect(useDashboardViewStore.getState().previewColumn).toMatchObject({
      sourcePath: "C:/tmp/b.html",
      previewPath: "C:/tmp/b.html",
      reloadKey: 1,
      isDirty: false,
    });
  });

  it("drops the preview column pin when that column closes", async () => {
    const { DASHBOARD_CHAT_COLUMN_PINS_STORAGE_KEY, DASHBOARD_PREVIEW_COLUMN_ID, useDashboardViewStore } = await loadStore();
    const store = useDashboardViewStore.getState();
    store.toggleChatColumn("tab-a");
    store.openOrReloadPreviewColumn({
      previewPath: "C:/tmp/a.html",
      sourcePath: "C:/tmp/a.html",
      sourceKind: "html",
    });
    store.toggleChatColumnPin(DASHBOARD_PREVIEW_COLUMN_ID);
    expect(useDashboardViewStore.getState().pinnedChatColumnTabIds).toEqual([DASHBOARD_PREVIEW_COLUMN_ID]);
    expect(JSON.parse(window.localStorage.getItem(DASHBOARD_CHAT_COLUMN_PINS_STORAGE_KEY) ?? "[]")).toEqual([
      DASHBOARD_PREVIEW_COLUMN_ID,
    ]);
    store.removeChatColumn(useDashboardViewStore.getState().chatColumnTabIds.indexOf(DASHBOARD_PREVIEW_COLUMN_ID));
    expect(useDashboardViewStore.getState()).toMatchObject({
      chatColumnTabIds: ["tab-a"],
      pinnedChatColumnTabIds: [],
    });
    expect(JSON.parse(window.localStorage.getItem(DASHBOARD_CHAT_COLUMN_PINS_STORAGE_KEY) ?? "[]")).toEqual([]);
  });

  it("reloads the same file by bumping reloadKey and asks before discarding dirty edits", async () => {
    const { DASHBOARD_PREVIEW_COLUMN_ID, useDashboardViewStore } = await loadStore();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const store = useDashboardViewStore.getState();
    store.openOrReloadPreviewColumn({
      previewPath: "C:/tmp/a.html",
      sourcePath: "C:/tmp/a.html",
      sourceKind: "html",
    });
    store.setPreviewDirty(true);
    store.openOrReloadPreviewColumn({
      previewPath: "C:/tmp/b.html",
      sourcePath: "C:/tmp/b.html",
      sourceKind: "html",
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(useDashboardViewStore.getState().previewColumn).toMatchObject({
      sourcePath: "C:/tmp/a.html",
      isDirty: true,
    });

    confirm.mockReturnValue(true);
    store.openOrReloadPreviewColumn({
      previewPath: "C:/tmp/a.html",
      sourcePath: "C:/tmp/a.html",
      sourceKind: "html",
    });
    expect(useDashboardViewStore.getState().previewColumn).toMatchObject({
      sourcePath: "C:/tmp/a.html",
      reloadKey: 1,
      isDirty: false,
    });
    expect(useDashboardViewStore.getState().chatColumnTabIds).toEqual([DASHBOARD_PREVIEW_COLUMN_ID]);
    confirm.mockRestore();
  });
});
