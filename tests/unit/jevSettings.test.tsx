// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));
import { JevSettingsSection } from "../../src/components/settings/tabs/JevSettingsSection";
import {
  DEFAULT_JEV_SETTINGS, loadJevSettings, saveJevSettings, testJevConnection, useJevSettingsStore,
} from "../../src/stores/jevSettingsStore";

let host: HTMLDivElement;
let root: Root;
const config = { ...DEFAULT_JEV_SETTINGS, enabled: true, hasApiKey: true, revision: "saved" };
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useJevSettingsStore.setState({ ...DEFAULT_JEV_SETTINGS, loaded: false, error: null }, true);
  bridge.invoke.mockReset();
  bridge.invoke.mockResolvedValue(config);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("Jev settings", () => {
  it("loads metadata once and never retains a key returned by an unexpected bridge response", async () => {
    bridge.invoke.mockResolvedValue({ ...config, apiKey: "must-not-retain" });
    await Promise.all([loadJevSettings(), loadJevSettings()]);
    expect(bridge.invoke).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(useJevSettingsStore.getState())).not.toContain("must-not-retain");
  });
  it("preserves the saved key when the replacement field is blank", async () => {
    await saveJevSettings(true, " typesafe/jev-1.13 ", " ");
    expect(bridge.invoke).toHaveBeenCalledWith("save_jev_settings", {
      enabled: true, model: "typesafe/jev-1.13", apiKey: null,
    });
    expect(useJevSettingsStore.getState().hasApiKey).toBe(true);
  });
  it("tests a draft key without writing settings", async () => {
    bridge.invoke.mockResolvedValue({ ok: true, elapsedMs: 650 });
    expect(await testJevConnection("typesafe/jev-1.13", "draft-test-only")).toBe(650);
    expect(bridge.invoke).toHaveBeenCalledWith("test_jev_connection", {
      model: "typesafe/jev-1.13", apiKey: "draft-test-only",
    });
    expect(useJevSettingsStore.getState().loaded).toBe(false);
  });
  it("renders a saved-key placeholder with an empty password field and saves without exposing it", async () => {
    await act(async () => { root.render(<JevSettingsSection aiEnabled />); });
    const key = host.querySelector<HTMLInputElement>('input[type="password"]')!;
    expect(key.value).toBe("");
    expect(key.placeholder).toContain("登録済み");
    const save = [...host.querySelectorAll("button")].find((b) => b.textContent === "Jev設定を保存")!;
    await act(async () => { save.click(); });
    expect(bridge.invoke).toHaveBeenLastCalledWith("save_jev_settings", {
      enabled: true, model: "typesafe/jev-1.13", apiKey: null,
    });
    expect(host.querySelector('[role="status"]')?.textContent).toContain("次のペイン再配置からJev");
  });
  it("shows a useful authentication failure and keeps the form available", async () => {
    await act(async () => { root.render(<JevSettingsSection aiEnabled />); });
    bridge.invoke.mockRejectedValue("authentication");
    const test = [...host.querySelectorAll("button")].find((b) => b.textContent === "接続テスト")!;
    await act(async () => { test.click(); });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("認証に失敗");
    expect(test.disabled).toBe(false);
  });
  it("does not enable Jev when the global AI switch is off", async () => {
    await act(async () => { root.render(<JevSettingsSection aiEnabled={false} />); });
    expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled).toBe(true);
  });
});
