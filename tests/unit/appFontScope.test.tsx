// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mode: "main",
  crash: false,
  loaded: Promise.resolve() as Promise<void>,
  detachedWorkspace: { id: "fixture" },
  getTerminalConfig: vi.fn(async () => ({})),
}));
vi.mock("../../src/components/layout/SocketListener", () => ({
  useWorkspacePersist: () => {},
  get persistLoaded() { return mocks.loaded; },
}));
vi.mock("../../src/components/layout/AppShell", () => ({ default: () => {
  if (mocks.crash) throw new Error("Fixture shell failure");
  return <section data-cmux-themed-root="true" data-fixture-shell="main" />;
} }));
vi.mock("../../src/components/layout/DetachedPaneShell", () => ({ default: () => <section data-cmux-themed-root="true" data-fixture-shell="detached" /> }));
vi.mock("../../src/components/layout/NativePaneShell", () => ({ default: () => <section data-cmux-themed-root="true" data-fixture-shell="native" />, TearoutSourceGap: () => null }));
vi.mock("../../src/lib/windowContext", () => ({ isMainWindow: () => mocks.mode === "main", windowLabel: () => mocks.mode === "main" ? "main" : "mycmux-w1", useWindowRole: () => false }));
vi.mock("../../src/lib/detachedPane", async (original) => ({ ...await original<object>(), detachedWorkspaceForWindow: () => mocks.mode === "detached" ? mocks.detachedWorkspace : null }));
vi.mock("../../src/lib/tearout/runtime", () => ({ isTearoutChild: () => mocks.mode === "native", markTearoutChildReady: vi.fn(async () => {}) }));
vi.mock("../../src/lib/multiWindowDev", () => ({ installChildWindowDevHook: () => {} }));
vi.mock("../../src/lib/agents", async (original) => ({ ...await original<object>(), initDefaultShell: vi.fn(async () => {}) }));
vi.mock("../../src/hooks/useAgentDormancy", () => ({ useAgentDormancy: () => {} }));
vi.mock("../../src/lib/liveAgentMetadata", async (original) => ({ ...await original<object>(), connectLiveAgentHydration: () => () => {} }));
vi.mock("../../src/stores/sessionAttentionStore", async (original) => ({ ...await original<object>(), connectSessionAttentionStore: vi.fn(async () => () => {}) }));
vi.mock("../../src/stores/stallStore", async (original) => ({ ...await original<object>(), connectStallStore: () => () => {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: vi.fn(async () => () => {}) }) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "mycmux-w1", show: vi.fn(async () => {}), setFocus: vi.fn(async () => {}) }) }));
vi.mock("../../src/lib/ipc", async (original) => ({
  ...await original<object>(),
  preloadTerminalConfig: () => {},
  getTerminalConfig: mocks.getTerminalConfig,
  onPtyMetadata: vi.fn(async () => () => {}),
  onPtyWorkDone: vi.fn(async () => () => {}),
  readAgentSessionMappings: vi.fn(async () => ({})),
  getLaunchCwd: vi.fn(async () => null),
  takePendingOpenPaths: vi.fn(async () => []),
  revealMainWindow: vi.fn(async () => {}),
}));

import App from "../../src/App";
import { AppFontScope } from "../../src/components/common/ErrorBoundary";
import { useThemeStore } from "../../src/stores/themeStore";
import { __resetToastStoreForTests, useToastStore } from "../../src/stores/toastStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { cancelAppConfirmations, confirm } from "../../src/lib/appConfirmation";

const css = readFileSync("src/global.css", "utf8");
const UI = '"Fixture Font", "Segoe UI", "Hiragino Sans", "Yu Gothic UI", "Meiryo", "Roboto", -apple-system, BlinkMacSystemFont, sans-serif';
const MONO = '"Fixture Font", "UDEV Gothic NF", "UDEV Gothic", "SFMono-Regular", "JetBrains Mono", "Consolas", ui-monospace, monospace';
const initialTheme = useThemeStore.getState();
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  mocks.mode = "main";
  mocks.crash = false;
  mocks.loaded = Promise.resolve();
  mocks.getTerminalConfig.mockReset().mockResolvedValue({});
  vi.spyOn(console, "error").mockImplementation(() => {});
  useThemeStore.setState(initialTheme);
  useSettingsStore.setState({ notificationsEnabled: true, toastUserActionEnabled: true });
  __resetToastStoreForTests();
  host = document.createElement("div");
  document.body.append(host);
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  root = createRoot(host);
});
afterEach(async () => {
  cancelAppConfirmations();
  await act(async () => root.unmount());
  host.remove();
  document.head.querySelectorAll("style").forEach((style) => style.remove());
  __resetToastStoreForTests();
  useThemeStore.setState(initialTheme);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("F4: real confirmation placement after shell failure", () => {
  it("uses App's surviving font scope for the title, body, and both buttons", async () => {
    mocks.crash = true;
    useThemeStore.setState({ fontFamily: '"Fixture Font", monospace' });
    await act(async () => root.render(<App />));
    await vi.waitFor(() => expect(host.textContent).toContain("画面の表示が停止しました"), { timeout: 1000, interval: 10 });
    const scope = host.querySelector<HTMLElement>("[data-cmux-app-font-scope]")!;
    const answer = confirm("Fixture confirmation body", {
      title: "Fixture confirmation title", okLabel: "Proceed", cancelLabel: "Keep",
    });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.parentElement?.parentElement).toBe(scope);
    expect(dialog.querySelector("h2")?.textContent).toBe("Fixture confirmation title");
    expect(dialog.querySelector("p")?.textContent).toBe("Fixture confirmation body");
    expect([...dialog.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Keep", "Proceed"]);
    const text = dialog.querySelectorAll("h2, p, button");
    expect(text).toHaveLength(4);
    for (const element of text) expect(getComputedStyle(element).fontFamily).toBe(UI);
    expect(host.querySelectorAll("[data-cmux-themed-root]")).toHaveLength(0);
    dialog.querySelector<HTMLButtonElement>("button")!.click();
    await expect(answer).resolves.toBe(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("continues to prefer the themed root when App also has a font scope", async () => {
    await act(async () => root.render(<App />));
    await vi.waitFor(() => expect(host.querySelector("[data-fixture-shell]")).not.toBeNull(), { timeout: 1000, interval: 10 });
    const shell = host.querySelector("[data-cmux-themed-root]")!;
    const scope = host.querySelector("[data-cmux-app-font-scope]")!;
    expect(scope.contains(shell)).toBe(true);
    const answer = confirm("Fixture normal confirmation");
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.parentElement?.parentElement).toBe(shell);
    expect(host.querySelectorAll("[data-cmux-themed-root]")).toHaveLength(1);
    dialog.querySelectorAll<HTMLButtonElement>("button")[1].click();
    await expect(answer).resolves.toBe(true);
  });
});

describe("R1: app surfaces outside the shell", () => {
  it.each(["main", "detached", "native"])("themes actual App/ToastHost siblings in the %s window", async (mode) => {
    mocks.mode = mode;
    useThemeStore.setState({ fontFamily: '"Fixture Font", monospace' });
    useToastStore.getState().pushToast("Fixture notice", "info", { label: "Fixture action", run: vi.fn() });
    await act(async () => root.render(<App />));
    await vi.waitFor(() => expect(host.querySelector(`[data-fixture-shell="${mode}"]`)).not.toBeNull(), { timeout: 1000, interval: 10 });
    const shell = host.querySelector("[data-cmux-themed-root]")!;
    const toast = host.querySelector<HTMLElement>('[role="status"]')!;
    expect(shell.contains(toast)).toBe(false);
    expect(host.querySelectorAll("[data-cmux-themed-root]")).toHaveLength(1);
    expect(getComputedStyle(toast).fontFamily).toBe(UI);
    expect(getComputedStyle(toast.querySelector("span")!).fontFamily).toBe(UI);
    expect(getComputedStyle(toast.querySelector("button")!).fontFamily).toBe(UI);
    await act(async () => useThemeStore.setState({ fontFamily: '"New Fixture Font", monospace' }));
    expect(getComputedStyle(toast).fontFamily).toBe(UI.replace('"Fixture Font"', '"New Fixture Font"'));
    expect(document.querySelector("[data-cmux-themed-root]")).toBe(shell);
  });

  it("keeps the outer ErrorBoundary message and retry button themed after its shell unmounts", async () => {
    mocks.crash = true;
    useThemeStore.setState({ fontFamily: '"Fixture Font", monospace' });
    await act(async () => root.render(<App />));
    await vi.waitFor(() => expect(host.textContent).toContain("画面の表示が停止しました"), { timeout: 1000, interval: 10 });
    expect(host.querySelector("[data-cmux-themed-root]")).toBeNull();
    const retry = host.querySelector<HTMLButtonElement>("button")!;
    expect(getComputedStyle(retry).fontFamily).toBe(UI);
    expect(getComputedStyle(retry.previousElementSibling!).fontFamily).toBe(UI);
    await act(async () => useThemeStore.setState({ fontFamily: '"New Fixture Font", monospace' }));
    expect(getComputedStyle(retry).fontFamily).toBe(UI.replace('"Fixture Font"', '"New Fixture Font"'));
    mocks.crash = false;
    await act(async () => retry.click());
    expect(host.querySelector("[data-cmux-themed-root]")).not.toBeNull();
  });

  it("renders child IPC failure before settings hydration succeeds, with UI and mono font routes", async () => {
    mocks.mode = "detached";
    mocks.loaded = new Promise(() => {});
    mocks.getTerminalConfig.mockRejectedValue(new Error("Fixture IPC failure"));
    useThemeStore.setState({ fontFamily: '"Fixture Font", monospace' });
    await act(async () => root.render(<App />));
    await vi.waitFor(() => expect(host.textContent).toContain("バックエンドに接続できません"), { timeout: 1000, interval: 10 });
    expect(host.querySelector("[data-cmux-themed-root]")).toBeNull();
    const scope = host.querySelector<HTMLElement>("[data-cmux-app-font-scope]")!;
    expect(scope.style.fontFamily).toBe(UI);
    expect(scope.style.getPropertyValue("--cmux-font-mono")).toBe(MONO);
    expect(getComputedStyle(scope.querySelector("div")!).fontFamily).toBe(UI);
    expect(scope.querySelectorAll("code")).toHaveLength(2);
    expect(scope.querySelector("pre")?.textContent).toBe("Fixture IPC failure");
    // jsdom cannot resolve this custom-property font declaration; pin the real CSS route.
    expect(css).toMatch(/:where\(\[data-cmux-app-font-scope\]\) :where\(code, pre, kbd, samp\)\s*\{\s*font-family: var\(--cmux-font-mono\);\s*\}/);
  });

  it("uses the store default without needing IPC to render a font scope", async () => {
    await act(async () => root.render(<AppFontScope><span>Default recovery</span></AppFontScope>));
    const scope = host.querySelector<HTMLElement>("[data-cmux-app-font-scope]")!;
    expect(scope.style.getPropertyValue("--cmux-font-ui")).toBe("'UDEV Gothic NF', 'BIZ UDGothic', 'MS Gothic', " + UI.slice(UI.indexOf('"Segoe UI"')));
    expect(getComputedStyle(scope.querySelector("span")!).fontFamily).toContain("UDEV Gothic NF");
    expect(host.querySelector("[data-cmux-themed-root]")).toBeNull();
  });
});
