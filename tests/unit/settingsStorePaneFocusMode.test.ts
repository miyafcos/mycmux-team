// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null), Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}), emit: vi.fn() }));

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => { document.body.replaceChildren(); });

describe("pane focus setting", () => {
  it.each([6, 7])("S01 defaults missing version %s fields to click", async (version) => {
    localStorage.setItem("mycmux-settings", JSON.stringify({ version, state: { notificationsEnabled: false } }));
    const { useSettingsStore } = await import("../../src/stores/settingsStore");
    expect(useSettingsStore.getState().paneFocusMode).toBe("click");
    expect(useSettingsStore.getState().notificationsEnabled).toBe(false);
  });

  it.each([null, false, true, 0, {}, [], "", "CLICK", "Hover", "invalid", "click", "hover"])(
    "S01 normalizes persisted and setter value %j", async (value) => {
      localStorage.setItem("mycmux-settings", JSON.stringify({ version: 7, state: { paneFocusMode: value } }));
      const { useSettingsStore } = await import("../../src/stores/settingsStore");
      const expected = value === "hover" ? "hover" : "click";
      expect(useSettingsStore.getState().paneFocusMode).toBe(expected);
      useSettingsStore.getState().setPaneFocusMode("hover");
      useSettingsStore.getState().setPaneFocusMode(value as any);
      expect(useSettingsStore.getState().paneFocusMode).toBe(expected);
    },
  );

  it("S02 defaults fresh installs and round trips both modes at version 7", async () => {
    const { useSettingsStore } = await import("../../src/stores/settingsStore");
    expect(useSettingsStore.getState().paneFocusMode).toBe("click");
    for (const mode of ["hover", "click"] as const) {
      useSettingsStore.getState().setPaneFocusMode(mode);
      expect(JSON.parse(localStorage.getItem("mycmux-settings")!)).toMatchObject({ version: 7, state: { paneFocusMode: mode } });
      await useSettingsStore.persist.rehydrate();
      expect(useSettingsStore.getState().paneFocusMode).toBe(mode);
    }
  });

  it("S01 review: missing field on rehydrate resets an already-hover window to click", async () => {
    const { useSettingsStore } = await import("../../src/stores/settingsStore");
    useSettingsStore.getState().setPaneFocusMode("hover");
    localStorage.setItem("mycmux-settings", JSON.stringify({ version: 7, state: { notificationsEnabled: false } }));
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().paneFocusMode).toBe("click");
    expect(useSettingsStore.getState().notificationsEnabled).toBe(false);
  });

  it("S04 renders a live native radio group independent of notifications", async () => {
    const { useSettingsStore } = await import("../../src/stores/settingsStore");
    const { NotificationsLayoutTab } = await import("../../src/components/settings/tabs/NotificationsLayoutTab");
    useSettingsStore.getState().setNotificationsEnabled(false);
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    await act(async () => { root.render(createElement(NotificationsLayoutTab)); });
    const fieldset = host.querySelector("fieldset")!;
    expect(fieldset.querySelector("legend")?.textContent).toBe("タブのフォーカス");
    const radios = [...fieldset.querySelectorAll<HTMLInputElement>("input[type=radio]")];
    expect(radios).toHaveLength(2);
    expect(radios.map((r) => r.closest("label")!.textContent)).toEqual([
      "クリックで切り替える (標準)", "マウスを乗せたら切り替える",
    ]);
    expect(radios[0].name).toBe(radios[1].name);
    expect(radios.every((r) => !r.disabled && r.tabIndex === 0 && !r.hasAttribute("onkeydown"))).toBe(true);
    radios[0].focus();
    for (const key of ["Tab", "ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"]) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      expect(radios[0].dispatchEvent(event)).toBe(true);
      expect(event.defaultPrevented).toBe(false); // Native group navigation remains available.
    }
    expect(document.getElementById(fieldset.getAttribute("aria-describedby")!)!.textContent).toContain("戻るときはクリック");
    await act(async () => { radios[1].click(); });
    expect(useSettingsStore.getState().paneFocusMode).toBe("hover");
    expect(radios[1].checked).toBe(true);
    await act(async () => { useSettingsStore.getState().setPaneFocusMode("click"); });
    expect(radios[0].checked).toBe(true);
    await act(async () => { root.unmount(); });
  });
});
