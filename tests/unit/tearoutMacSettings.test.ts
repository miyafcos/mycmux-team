// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { nativePaneTearoutEnabled } from "../../src/lib/tearout/feature";

const original = Object.getOwnPropertyDescriptor(navigator, "platform");
const platform = (value: string) => Object.defineProperty(navigator, "platform", { configurable: true, value });
afterEach(() => {
  if (original) Object.defineProperty(navigator, "platform", original);
  else Reflect.deleteProperty(navigator, "platform");
  localStorage.removeItem("mycmux-settings");
  useSettingsStore.setState(useSettingsStore.getInitialState());
});

describe("separate Mac consent for native tear-out", () => {
  it("does not interpret a pre-0.82 Mac's Windows-default true as consent", async () => {
    platform("MacIntel");
    useSettingsStore.setState({ macNativePaneTearoutEnabled: false });
    localStorage.setItem("mycmux-settings", JSON.stringify({ state: { nativePaneTearoutEnabled: true }, version: 0 }));
    await useSettingsStore.persist.rehydrate();
    const state = useSettingsStore.getState();
    expect(state.macNativePaneTearoutEnabled).toBe(false);
    expect(state.nativePaneTearoutEnabled).toBe(false);
    expect(nativePaneTearoutEnabled(state.nativePaneTearoutEnabled)).toBe(false);
  });
  it("persists an explicit Mac ON, then OFF, through the existing layout switch", async () => {
    platform("MacIntel");
    useSettingsStore.getState().setNativePaneTearoutEnabled(true);
    expect(nativePaneTearoutEnabled(true)).toBe(true);
    expect(JSON.parse(localStorage.getItem("mycmux-settings")!).state.macNativePaneTearoutEnabled).toBe(true);
    await useSettingsStore.persist.rehydrate();
    expect(nativePaneTearoutEnabled(useSettingsStore.getState().nativePaneTearoutEnabled)).toBe(true);
    useSettingsStore.getState().setNativePaneTearoutEnabled(false);
    expect(useSettingsStore.getState().macNativePaneTearoutEnabled).toBe(false);
    expect(nativePaneTearoutEnabled(false)).toBe(false);
  });
  it("retains the Windows default and its persisted OFF route", async () => {
    platform("Win32");
    expect(useSettingsStore.getInitialState().nativePaneTearoutEnabled).toBe(true);
    useSettingsStore.getState().setNativePaneTearoutEnabled(false);
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().nativePaneTearoutEnabled).toBe(false);
    useSettingsStore.getState().setNativePaneTearoutEnabled(true);
    expect(nativePaneTearoutEnabled(true)).toBe(true);
    expect(useSettingsStore.getState().macNativePaneTearoutEnabled).toBe(false);
  });
});
