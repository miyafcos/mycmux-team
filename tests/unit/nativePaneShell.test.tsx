// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pane } from "../../src/types";

const mocks = vi.hoisted(() => ({
  panes: [] as Pane[],
  invoke: vi.fn(async (_command: string, _args?: unknown) => {}),
  fragments: vi.fn<() => Promise<Array<{ window_label: string }>>>(),
  confirm: vi.fn(async (_body: string, _options: Record<string, unknown>) => true),
  close: vi.fn(async () => {}),
  minimize: vi.fn(async () => {}), toggle: vi.fn(async () => {}),
  maximized: false, resize: (() => {}) as () => void,
  regrab: vi.fn(async (_record: unknown, onEnd?: (sample: { moved: boolean }) => void) => { onEnd?.({ moved: false }); }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ startDragging: vi.fn(async () => {}),
  minimize: mocks.minimize, toggleMaximize: mocks.toggle, isMaximized: async () => mocks.maximized,
  listen: async () => () => {},
  onResized: async (callback: () => void) => { mocks.resize = callback; return () => {}; }, onMoved: async () => () => {},
}) }));
vi.mock("../../src/lib/appConfirmation", () => ({ cancelAppConfirmations: vi.fn(() => false), confirm: mocks.confirm }));
vi.mock("../../src/lib/ipc", () => ({ getWindowFragments: mocks.fragments }));
vi.mock("../../src/lib/windowContext", () => ({ windowLabel: () => "mycmux-native" }));
vi.mock("../../src/stores/paneMetadataStore", () => ({
  usePaneMetadataStore: { getState: () => ({ metadata: {}, volatileMetadata: {} }) },
}));
vi.mock("../../src/stores/workspaceListStore", () => ({
  useWorkspaceListStore: (select: (state: unknown) => unknown) => select({ workspaces: [{ panes: mocks.panes }] }),
}));
vi.mock("../../src/stores/themeStore", () => ({ useThemeStore: () => ({ themeTweaks: { background: "#000" } }) }));
vi.mock("../../src/components/layout/themeVars", () => ({ buildThemeVars: () => ({}) }));
vi.mock("../../src/components/workspace/WorkspaceView", () => ({ default: () => null }));
vi.mock("../../src/components/workspace/PaneDragOverlay", () => ({ default: () => null }));
vi.mock("../../src/components/layout/SocketListener", () => ({ closeWindowWorkspacesAndDestroy: mocks.close }));
vi.mock("../../src/lib/tearout/runtime", () => ({ useTearoutStore: vi.fn(), regrabTearoutWindow: mocks.regrab }));

import { useSettingsStore } from "../../src/stores/settingsStore";
import { titleBarStrings } from "../../src/components/layout/titleBarStrings";
import { tearoutStrings } from "../../src/components/layout/tearoutStrings";
import * as operation from "../../src/lib/tearout/operation";
const { default: NativePaneShell } = await import("../../src/components/layout/NativePaneShell");
let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  operation.endTearoutOperation();
  mocks.regrab.mockImplementation(async (_record, onEnd) => { onEnd?.({ moved: false }); });
  mocks.maximized = false;
  Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
  useSettingsStore.setState({ nativePaneTearoutEnabled: true });
  mocks.confirm.mockResolvedValue(true);
  mocks.fragments.mockResolvedValue([{ window_label: "main" }, { window_label: "mycmux-native" }]);
  mocks.panes = [{ id: "pane", agentId: "shell", activeTabId: "a", tabs: [
    { id: "a", agentId: "shell", sessionId: "session-a" },
    { id: "b", agentId: "shell", sessionId: "session-b" },
  ] }];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<NativePaneShell />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  operation.endTearoutOperation();
});
async function close() {
  await act(async () => Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(button => button.getAttribute("aria-label") === tearoutStrings.close)!.click());
}

describe("native pane window close confirmation", () => {
  it("asks to close this window when other windows remain, excluding itself and duplicate fragments", async () => {
    mocks.fragments.mockResolvedValue([
      { window_label: "main" }, { window_label: "main" },
      { window_label: "mycmux-peer" }, { window_label: "mycmux-native" }, { window_label: "" },
    ]);
    await close();
    expect(mocks.confirm).toHaveBeenCalledOnce();
    const [body, options] = mocks.confirm.mock.calls[0];
    expect(options.title).toBe("このウィンドウを閉じます");
    expect(body).toContain("他の 2 個のウィンドウ");
    expect(body).not.toContain("次に起動したときに、いまの状態から再開できます。");
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it("uses the last-window wording only when no peer window remains", async () => {
    mocks.fragments.mockResolvedValue([{ window_label: "mycmux-native" }]);
    await close();
    expect(mocks.confirm.mock.calls[0][1].title).toBe("mycmux を終了します");
  });
  it("does not close the window when the confirmation is canceled", async () => {
    mocks.confirm.mockResolvedValue(false);
    await close();
    expect(mocks.close).not.toHaveBeenCalled();
    expect(Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(button => button.getAttribute("aria-label") === tearoutStrings.close)!.disabled).toBe(false);
  });
  it("does not mislabel an unknown peer count as quitting the app", async () => {
    mocks.fragments.mockRejectedValue(new Error("registry unavailable"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    await close();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
    expect(container.querySelector("[role=alert]")).not.toBeNull();
    warning.mockRestore();
  });
  it("keeps the existing one-pane close behavior without querying other windows", async () => {
    mocks.panes[0].tabs = [mocks.panes[0].tabs![0]];
    await act(async () => root.render(<NativePaneShell />));
    await close();
    expect(mocks.fragments).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});

function band() { return container.querySelector<HTMLElement>("[data-native-pane-band]")!; }
function press(x = 30, y = 10) {
  const event = new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: x, clientY: y });
  Object.defineProperty(event, "pointerId", { value: 1 });
  band().dispatchEvent(event);
}
describe("Windows native band controls and immediate OS movement", () => {
  it("shares the title bar controls and invokes minimize and maximize", async () => {
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
    expect(buttons.map(button => button.getAttribute("aria-label")))
      .toEqual([titleBarStrings.minimize, titleBarStrings.maximize, tearoutStrings.close]);
    expect(buttons.every(button => button.classList.contains("cmux-title-btn"))).toBe(true);
    await act(async () => { buttons[0].click(); buttons[1].click(); });
    expect(mocks.minimize).toHaveBeenCalledOnce(); expect(mocks.toggle).toHaveBeenCalledOnce();
    mocks.maximized = true;
    await act(async () => mocks.resize());
    expect(buttons[1].getAttribute("aria-label")).toBe(titleBarStrings.restore);
    expect(buttons[1].querySelector("path")).not.toBeNull();
  });
  it("starts Windows movement on pointerdown and toggles on an unmoved second press", async () => {
    await act(async () => press());
    expect(mocks.regrab).toHaveBeenCalledOnce();
    await act(async () => press());
    expect(mocks.regrab).toHaveBeenCalledOnce(); expect(mocks.toggle).toHaveBeenCalledOnce();
  });
  it("supports a native double-click event without a preceding move", async () => {
    await act(async () => band().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(mocks.toggle).toHaveBeenCalledOnce();
  });
  it("never toggles after a moved gesture, and buttons never start dragging", async () => {
    mocks.regrab.mockImplementationOnce(async (_record, onEnd) => { onEnd?.({ moved: true }); });
    await act(async () => press());
    await act(async () => band().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(mocks.toggle).not.toHaveBeenCalled();
    const event = new MouseEvent("pointerdown", { bubbles: true, button: 0 });
    await act(async () => container.querySelector("button")!.dispatchEvent(event));
    expect(mocks.regrab).toHaveBeenCalledOnce();
  });
  it.each([["MacIntel", true], ["Win32", false]] as const)("keeps the old band on %s with enabled=%s", async (platform, enabled) => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
    useSettingsStore.setState({ nativePaneTearoutEnabled: enabled, macNativePaneTearoutEnabled: true });
    await act(async () => root.render(<NativePaneShell />));
    expect(container.querySelectorAll("button")).toHaveLength(1);
    await act(async () => press());
    expect(mocks.regrab).not.toHaveBeenCalled();
    await act(async () => band().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(mocks.toggle).not.toHaveBeenCalled();
  });
});


describe("overlapping band presses (E1/E2/E4)", () => {
  it.each(["Win32", "MacIntel"])("keeps the accepted %s move and ignores repeated presses", async (platform) => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
    useSettingsStore.setState({ macNativePaneTearoutEnabled: true });
    await act(async () => root.render(<NativePaneShell />));
    let end: ((sample: { moved: boolean }) => void) | undefined;
    mocks.regrab.mockImplementation(async (_record, onEnd) => { end = onEnd; });
    const move = (x = 45) => {
      const event = new MouseEvent("pointermove", { clientX: x, clientY: 10 });
      Object.defineProperty(event, "pointerId", { value: 1 });
      window.dispatchEvent(event);
    };
    await act(async () => { press(); if (platform === "MacIntel") move(); });
    for (let i = 0; i < 3; i++) await act(async () => { press(); if (platform === "MacIntel") move(); });
    expect(mocks.regrab).toHaveBeenCalledOnce();
    expect(mocks.toggle).not.toHaveBeenCalled();
    expect(container.querySelector("[role=alert]")).toBeNull();
    expect(mocks.invoke.mock.calls.filter(([cmd, args]) => cmd === "tearout_log_record"
      && (args as { record: { result: string } }).record.result === "rejected_busy")).toHaveLength(3);
    await act(async () => end?.({ moved: true }));
    await act(async () => { press(60); if (platform === "MacIntel") move(75); });
    expect(mocks.regrab).toHaveBeenCalledTimes(2);
  });
  it("does not turn a captured moving refusal into a red failure after the owner ends", async () => {
    const refusal = new operation.LocalTearoutRefusal("moving");
    let reject = (_error: Error) => {};
    mocks.regrab.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    await act(async () => press());
    await act(async () => reject(refusal));
    expect(container.querySelector("[role=alert]")).toBeNull();
    expect(mocks.toggle).not.toHaveBeenCalled();
  });
  it("shows a genuine band double-click maximize failure", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.toggle.mockRejectedValueOnce(new Error("maximize failed"));
    await act(async () => band().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(container.querySelector("[role=alert]")).not.toBeNull();
    warning.mockRestore();
  });
  it("still shows actual native start failures, including raw backend busy", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.regrab.mockRejectedValueOnce(new Error("tearout_move_busy"));
    await act(async () => press());
    expect(container.querySelector("[role=alert]")).not.toBeNull();
    warning.mockRestore();
  });
});
