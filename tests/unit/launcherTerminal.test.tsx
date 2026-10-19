// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: { launcherHiddenIds: [] as string[], crsmShowClaude: true, crsmShowCodex: true, crsmShowClaudeCodex: true, hideSessionsWithoutUserMessages: true },
  dirs: { view: null, load: async () => {} },
  layout: { addTabToPaneWithOptions: vi.fn(), addWebTabToPane: vi.fn() },
  ui: { setActivePaneId: vi.fn(), requestSettingsTab: vi.fn() },
  visible: vi.fn((_target: string) => true), close: vi.fn(),
}));
vi.mock("../../src/lib/ipc", () => ({ crsmListSessions: async () => [], launcherRecordDirMru: async () => {} }));
vi.mock("../../src/hooks/useAgentServiceVisibility", () => ({ useAgentServiceVisibility: () => mocks.visible }));
vi.mock("../../src/hooks/usePaneHoverFocus", () => ({ usePaneHoverFocus: () => false }));
vi.mock("../../src/lib/paneCloseOperation", () => ({ closePaneOperation: mocks.close }));
vi.mock("../../src/stores/settingsStore", () => ({ useSettingsStore: (select: (s: typeof mocks.settings) => unknown) => select(mocks.settings) }));
vi.mock("../../src/stores/launcherDirsStore", () => ({ useLauncherDirsStore: (select: (s: typeof mocks.dirs) => unknown) => select(mocks.dirs) }));
vi.mock("../../src/stores/workspaceLayoutStore", () => ({ useWorkspaceLayoutStore: (select: (s: typeof mocks.layout) => unknown) => select(mocks.layout) }));
vi.mock("../../src/stores/workspaceListStore", () => ({ useWorkspaceListStore: (select: (s: { workspaces: never[]; activeWorkspaceId: string }) => unknown) => select({ workspaces: [], activeWorkspaceId: "ws" }) }));
vi.mock("../../src/stores/uiStore", () => ({ useUiStore: Object.assign((select: (s: typeof mocks.ui) => unknown) => select(mocks.ui), { getState: () => mocks.ui, subscribe: () => () => {} }) }));
vi.mock("../../src/lib/claudeCodexModels", () => ({ useLaunchModels: (entry?: { models: unknown[] }) => entry?.models ?? [] }));

import LauncherPane from "../../src/components/workspace/LauncherPane";
import { launcherStrings as S } from "../../src/components/workspace/launcherStrings";
import { resolveTerminalCommandEnv } from "../../src/lib/terminalShellCommand";
import { launchItems, searchItems } from "../../src/components/workspace/launcherModel";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView = () => {};
let host: HTMLDivElement, root: Root;

beforeEach(() => {
  vi.clearAllMocks(); mocks.visible.mockReturnValue(true); mocks.settings.launcherHiddenIds = [];
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
async function render() { await act(async () => root.render(<LauncherPane workspaceId="ws" paneId="pane" tabId="tab" sessionId="session" isActive cwd="C:/work dir" />)); }
const input = () => host.querySelector("input")!;
async function query(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function key(key: string, options: KeyboardEventInit = {}) {
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...options })));
}
async function click(text: string) {
  const button = [...host.querySelectorAll("button")].find(button => button.textContent === text)!;
  expect(button).toBeDefined(); await act(async () => button.click());
}
const launched = () => mocks.layout.addTabToPaneWithOptions.mock.calls.at(-1)?.[2];
const rows = () => [...host.querySelectorAll("[data-nav]")];

describe("Launch Menu terminal", () => {
  it("U1 appends the shell to new launches and preserves agent keyboard order", async () => {
    await render();
    const expected = launchItems().filter(item => item.kind === "agent").map(item => item.short);
    expect(rows().slice(0, expected.length + 1).map(row => row.querySelector("button")?.textContent)).toEqual([...expected, S.terminal]);
    expect(rows()[0].getAttribute("data-nav")).toBe("0");
    for (let i = 0; i < expected.length; i++) await key("ArrowDown");
    await key("Enter");
    expect(launched()).toEqual({ agentId: "shell-starter", cwd: "C:/work dir", launchEnv: { MYCMUX_LAUNCH_TARGET: "shell" } });
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
  it("U1 stays visible with all services hidden and honors launcherHiddenIds", async () => {
    mocks.visible.mockReturnValue(false); await render();
    expect(host.textContent).toContain(S.terminal);
    expect(host.textContent).not.toContain("Claude Code");
    mocks.settings.launcherHiddenIds = ["shell"]; await render();
    expect(host.textContent).not.toContain(S.terminal);
  });
  it("U2 opens a menu-free shell in the selected cwd", async () => {
    await render(); await click(S.terminal);
    expect(mocks.layout.addTabToPaneWithOptions).toHaveBeenCalledWith("ws", "pane", {
      agentId: "shell-starter", cwd: "C:/work dir", launchEnv: { MYCMUX_LAUNCH_TARGET: "shell" },
    });
    expect(mocks.layout.addWebTabToPane).not.toHaveBeenCalled();
  });
  it("U3 unmatched input is the sole row and Enter passes the exact line once", async () => {
    await render(); const command = "  npm run dev -- --name='a b' | cat; echo $value # \u65e5\u672c\u8a9e  ";
    await query(command);
    expect(rows()).toHaveLength(1); expect(rows()[0].textContent).toBe(S.runInTerminal(command));
    await key("Enter"); await key("Enter");
    expect(mocks.layout.addTabToPaneWithOptions).toHaveBeenCalledTimes(1);
    expect(launched().cwd).toBe("C:/work dir");
    expect(JSON.stringify(launched())).not.toContain(command);
    expect(resolveTerminalCommandEnv(launched().launchEnv)).toEqual({ MYCMUX_LAUNCH_TARGET: "shell", MYCMUX_LAUNCH_COMMAND: command });
  });
  it("U3 matching Enter still starts the first agent; Down reaches the last command row", async () => {
    await render(); await query("claude");
    expect(rows().at(-1)?.textContent).toBe(S.runInTerminal("claude"));
    await key("Enter"); expect(launched().launchEnv).toEqual({ MYCMUX_LAUNCH_TARGET: searchItems(launchItems(), "claude")[0].target });
    mocks.layout.addTabToPaneWithOptions.mockClear();
    for (let i = 1; i < rows().length; i++) await key("ArrowDown");
    await key("Enter");
    expect(resolveTerminalCommandEnv(launched().launchEnv)?.MYCMUX_LAUNCH_COMMAND).toBe("claude");
  });
  it("U4 ignores composition Enter and the legacy 229 key code", async () => {
    await render(); await query("npm run dev");
    await key("Enter", { isComposing: true }); await key("Enter", { keyCode: 229 });
    expect(mocks.layout.addTabToPaneWithOptions).not.toHaveBeenCalled();
    await key("Enter"); expect(mocks.layout.addTabToPaneWithOptions).toHaveBeenCalledTimes(1);
  });
  it.each(["claude\n", "echo a\necho b", "echo a\recho b", "echo\ta", "echo\x1ba", "echo\x85a", "echo\u2028a", "echo\u2029a", "x".repeat(4097)])("U4 rejects invalid pasted input %# with a visible reason", async command => {
    await render();
    await act(async () => {
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: { getData: () => command } });
      input().dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
    });
    expect(host.querySelector("[role=alert]")?.textContent).toBe(command.length > 4096 ? S.commandTooLong : S.commandSingleLine);
    await key("Enter");
    await act(async () => (host.querySelector("[data-terminal-command]") as HTMLButtonElement).click());
    expect(mocks.layout.addTabToPaneWithOptions).not.toHaveBeenCalled();
  });
  it.each(["Tab", "Shift+Enter"])("preserves %s model selection", async shortcut => {
    await render(); await key(shortcut === "Tab" ? "Tab" : "Enter", { shiftKey: shortcut !== "Tab" });
    expect(host.querySelector("[data-launcher-spec]")).not.toBeNull();
    expect(mocks.layout.addTabToPaneWithOptions).not.toHaveBeenCalled();
  });
});
