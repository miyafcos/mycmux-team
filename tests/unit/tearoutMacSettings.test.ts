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
  it("is on by default on the Mac since 0.83.0 (owner's decision 2026-10-04)", () => {
    expect(useSettingsStore.getInitialState().macNativePaneTearoutEnabled).toBe(true);
  });
  it("switches a Mac saved by 0.82.0 (its experimental default off) on once", async () => {
    platform("MacIntel");
    useSettingsStore.setState({ macNativePaneTearoutEnabled: false, nativePaneTearoutEnabled: false });
    localStorage.setItem("mycmux-settings", JSON.stringify({
      state: { nativePaneTearoutEnabled: false, macNativePaneTearoutEnabled: false }, version: 6,
    }));
    await useSettingsStore.persist.rehydrate();
    const state = useSettingsStore.getState();
    expect(state.macNativePaneTearoutEnabled).toBe(true);
    expect(state.nativePaneTearoutEnabled).toBe(true);
    expect(nativePaneTearoutEnabled(state.nativePaneTearoutEnabled)).toBe(true);
  });
  it("keeps a Mac off chosen after the version 7 migration", async () => {
    platform("MacIntel");
    localStorage.setItem("mycmux-settings", JSON.stringify({
      state: { nativePaneTearoutEnabled: true, macNativePaneTearoutEnabled: false }, version: 7,
    }));
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
    // The Windows switch never writes the Mac's own field.
    useSettingsStore.setState({ macNativePaneTearoutEnabled: false });
    useSettingsStore.getState().setNativePaneTearoutEnabled(false);
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().nativePaneTearoutEnabled).toBe(false);
    useSettingsStore.getState().setNativePaneTearoutEnabled(true);
    expect(nativePaneTearoutEnabled(true)).toBe(true);
    expect(useSettingsStore.getState().macNativePaneTearoutEnabled).toBe(false);
  });
});
