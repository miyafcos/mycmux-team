// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null), Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
beforeEach(() => { localStorage.clear(); vi.resetModules(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("agent tab settings and bounded per-tab choices", () => {
  it("defaults to conversation, persists both choices and resets missing data on rehydrate", async () => {
    const { useSettingsStore: store } = await import("../../src/stores/settingsStore");
    expect(store.getState().agentTabContent).toBe("conversation");
    for (const value of ["terminal", "conversation"] as const) {
      store.getState().setAgentTabContent(value);
      expect(JSON.parse(localStorage.getItem("mycmux-settings")!).state.agentTabContent).toBe(value);
      await store.persist.rehydrate();
      expect(store.getState().agentTabContent).toBe(value);
    }
    store.getState().setAgentTabContent("terminal");
    localStorage.setItem("mycmux-settings", JSON.stringify({ version: 7, state: {} }));
    await store.persist.rehydrate();
    expect(store.getState().agentTabContent).toBe("conversation");
  });
  it.each([null, 1, true, {}, [], "unknown", "Conversation", "terminal", "conversation"])("normalizes persisted and setter value %j", async value => {
    localStorage.setItem("mycmux-settings", JSON.stringify({ version: 7, state: { agentTabContent: value } }));
    const { useSettingsStore: store } = await import("../../src/stores/settingsStore");
    const expected = value === "conversation" ? "conversation" : "terminal";
    expect(store.getState().agentTabContent).toBe(expected);
    store.getState().setAgentTabContent(value as never);
    expect(store.getState().agentTabContent).toBe(expected);
  });
  it("offers both Japanese choices beside history and updates the live setting", async () => {
    const { useSettingsStore: store } = await import("../../src/stores/settingsStore");
    store.setState({ agentTabContent: "terminal" });
    const { NotificationsLayoutTab } = await import("../../src/components/settings/tabs/NotificationsLayoutTab");
    const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(NotificationsLayoutTab)));
      const select = [...host.querySelectorAll("select")].find(node => node.closest("label")?.textContent?.includes("エージェントのタブの中身"))!;
      expect([...select.options].map(option => option.textContent)).toEqual(["端末 (今まで)", "会話の表示 (試作)"]);
      expect(select.value).toBe("terminal");
      await act(async () => { select.value = "conversation"; select.dispatchEvent(new Event("change", { bubbles: true })); });
      expect(store.getState().agentTabContent).toBe("conversation");
      await act(async () => { select.value = "terminal"; select.dispatchEvent(new Event("change", { bubbles: true })); });
      expect(store.getState().agentTabContent).toBe("terminal");
      expect(host.textContent).toContain("過去の会話の読み方");
    } finally { await act(async () => root.unmount()); host.remove(); }
  });
  it("round trips independent tab ids and caps its most recent choices", async () => {
    const { useAgentTabViewStore: store, readAgentTabViews, AGENT_TAB_VIEW_KEY, AGENT_TAB_VIEW_LIMIT } = await import("../../src/stores/agentTabViewStore");
    expect(store.getState().views).toEqual({});
    store.getState().setView("tab-a", "terminal");
    store.getState().setView("tab-b", "conversation");
    expect(readAgentTabViews()).toEqual({ "tab-a": "terminal", "tab-b": "conversation" });
    for (let index = 0; index < AGENT_TAB_VIEW_LIMIT; index++) store.getState().setView(`tab-${index}`, "terminal");
    expect(Object.keys(store.getState().views)).toHaveLength(AGENT_TAB_VIEW_LIMIT);
    expect(store.getState().views["tab-a"]).toBeUndefined();
    expect(JSON.parse(localStorage.getItem(AGENT_TAB_VIEW_KEY)!)).toHaveLength(AGENT_TAB_VIEW_LIMIT);
    expect(readAgentTabViews()).toEqual(store.getState().views);
  });
  it("ignores malformed entries and storage failures without losing a current choice", async () => {
    const { useAgentTabViewStore: store, readAgentTabViews, AGENT_TAB_VIEW_KEY } = await import("../../src/stores/agentTabViewStore");
    for (const value of ["{broken", "{}", "null"]) {
      localStorage.setItem(AGENT_TAB_VIEW_KEY, value); expect(readAgentTabViews()).toEqual({});
    }
    localStorage.setItem(AGENT_TAB_VIEW_KEY, JSON.stringify([["good", "terminal"], ["bad", "invalid"], [null, "conversation"]]));
    expect(readAgentTabViews()).toEqual({ good: "terminal" });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("unavailable"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("full"); });
    expect(readAgentTabViews()).toEqual({});
    expect(() => store.getState().setView("current-tab", "terminal")).not.toThrow();
    expect(store.getState().views["current-tab"]).toBe("terminal");
  });
});
