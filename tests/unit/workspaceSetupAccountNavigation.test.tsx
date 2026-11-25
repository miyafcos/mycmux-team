// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getAllWindows } from "@tauri-apps/api/window";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { geminiSignedOut } from "./fixtures/geminiSignedOut";

const ipc = vi.hoisted(() => ({
  homes: [] as Array<{ provider: string; profile_id: string; state: string }>,
  nextHomeRead: undefined as Promise<unknown> | undefined,
  windowLabel: "main",
  windowLabels: ["main"],
  denyFocus: false,
  accountResults: new Set<(event: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  isTauri: () => false,
  convertFileSrc: (file: string) => file,
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === "list_cli_accounts") return {
      profiles: [
        { id: "grok-a", provider: "grok", label: "Grok fixture", captured_at: "" },
        { id: "grok-b", provider: "grok", label: "Other Grok fixture", captured_at: "" },
      ], live: [], active: { claude: null, codex: null, grok: null }, orphans: [],
    };
    if (command === "list_cli_account_homes") {
      const response = ipc.nextHomeRead ?? ipc.homes;
      ipc.nextHomeRead = undefined;
      return response;
    }
    if (command === "begin_cli_login") return { login_id: "fixture-login", provider: "claude", command: "claude", args: [] };
    if (command === "load_wallpaper_cache") return { entries: [] };
    if (command === "get_window_tab_index") return ipc.windowLabels.map(window_label =>
      ({
        window_label, pending: false, workspaces: [], account_management_ready: true,
        account_management_subscription: { publication_id: "", subscription_id: "fixture-main-listener" },
      }));
    if (command === "publish_window_fragment" && args?.readAccountManagementDocument) return 0;
    if (command === "focus_window" && ipc.denyFocus) {
      throw ipc.windowLabels.includes(String(args?.label)) ? "window_focus_refused" : "Application window is unavailable";
    }
    if (command.startsWith("list_") || command === "crsm_list_sessions" || command === "get_cli_launch_tokens") return [];
    return null;
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, notify: (event: { payload: unknown }) => void) => {
    if (name === "mycmux://account-management-result") ipc.accountResults.add(notify);
    return () => { ipc.accountResults.delete(notify); };
  }),
  emit: vi.fn(async () => {}),
  emitTo: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/window", async importOriginal => ({
  ...await importOriginal<typeof import("@tauri-apps/api/window")>(),
  getAllWindows: vi.fn(async () => ipc.windowLabels.map(label => ({ label }))),
  getCurrentWindow: () => ({
    label: ipc.windowLabel, setTitle: async () => {}, listen: async () => () => {},
    isMaximized: async () => false, onResized: async () => () => {}, onMoved: async () => () => {},
  }),
}));
vi.mock("../../src/lib/windowContext", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/lib/windowContext")>(),
  windowLabel: () => ipc.windowLabel,
  isMainWindow: () => ipc.windowLabel === "main",
}));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/fixture/home") }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/webview", async original => ({
  ...await original<object>(),
  getCurrentWebview: () => ({ label: "main", listen: vi.fn(async () => () => {}) }),
}));
vi.mock("../../src/components/layout/WindowControls", () => ({ WindowControls: () => null }));
vi.mock("../../src/components/layout/SocketListener", () => ({ default: () => null }));
vi.mock("allotment", () => {
  const Frame = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return { Allotment: Object.assign(Frame, { Pane: Frame }) };
});
vi.mock("../../src/components/terminal/XTermWrapper", async original => ({
  ...await original<object>(), default: () => <div className="xterm" />,
}));
vi.mock("../../src/components/dashboard/DashboardView", () => ({ DashboardView: () => <div data-dashboard-fixture tabIndex={-1} /> }));

import AppShell from "../../src/components/layout/AppShell";
import DetachedPaneShell from "../../src/components/layout/DetachedPaneShell";
import { createWorkspaceAtCwd } from "../../src/lib/workspaceBootstrap";
import { OPEN_DASHBOARD_EVENT } from "../../src/lib/ipc";
import { ACCOUNT_MANAGEMENT_RESULT_EVENT, ACCOUNT_MANAGEMENT_TIMEOUT_MS } from "../../src/lib/mainDashboardRequests";
import { isPreparingLayoutQuit, resetLayoutQuitForTests, stopNewLayoutOperations } from "../../src/lib/layoutQuit";
import { titleBarStrings } from "../../src/components/layout/titleBarStrings";
import { setupStrings } from "../../src/components/setup/setupStrings";
import { launcherStrings } from "../../src/components/workspace/launcherStrings";
import { dashboardStrings } from "../../src/components/dashboard/dashboardStrings";
import { OVERLAY_EXIT_MS } from "../../src/hooks/useDeferredUnmount";
import { __resetCliLoginStoreForTests } from "../../src/stores/cliLoginStore";
import { __resetUsageStoreForTests, useUsageStore } from "../../src/stores/usageStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useDashboardViewStore } from "../../src/stores/dashboardViewStore";

let host: HTMLElement;
let root: Root;
let first: string;
let second: string;
const requestSettingsTab = useUiStore.getState().requestSettingsTab;
const settingsRequests = vi.fn(requestSettingsTab);

beforeEach(async () => {
  vi.useFakeTimers();
  ipc.homes = [];
  ipc.nextHomeRead = undefined;
  ipc.windowLabel = "main";
  ipc.windowLabels = ["main"];
  ipc.denyFocus = false;
  vi.mocked(getAllWindows).mockClear();
  vi.mocked(invoke).mockClear();
  settingsRequests.mockClear();
  useUiStore.setState({ requestSettingsTab: settingsRequests });
  resetLayoutQuitForTests();
  vi.mocked(listen).mockClear();
  ipc.accountResults.clear();
  vi.mocked(emitTo).mockReset().mockImplementation(answerManagementRequest);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1100, 700));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  Element.prototype.scrollIntoView = () => {};
  __resetCliLoginStoreForTests();
  __resetUsageStoreForTests();
  useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null, lastActivePaneByWorkspace: {} });
  useDashboardViewStore.getState().close();
  useUiStore.getState().clearRequestedSettingsTab();
  useUiStore.getState().setWorkspaceSetupVisible(false);
  first = createWorkspaceAtCwd("/fixture/first", { name: "First", activate: true });
  second = createWorkspaceAtCwd("/fixture/second", { name: "Second", activate: false });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<AppShell />));
});

afterEach(async () => {
  resetLayoutQuitForTests();
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  useUiStore.setState({ requestSettingsTab });
  vi.unstubAllGlobals();
});

function button(label: string, scope: ParentNode = host) {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(node =>
    node.textContent === label || node.getAttribute("title") === label || node.getAttribute("aria-label") === label);
  expect(found, label).toBeDefined();
  return found!;
}
async function click(label: string, scope?: ParentNode) {
  await act(async () => button(label, scope).click());
}
async function pressEnter(target: HTMLElement) {
  const key = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true });
  await act(async () => {
    target.focus();
    expect(document.activeElement).toBe(target);
    // Fall through to the button activation that jsdom does not emulate.
    if (target.dispatchEvent(key) && target instanceof HTMLButtonElement) target.click();
  });
  return key;
}
async function selectGrok() {
  const select = [...host.querySelectorAll("select")].find(select => [...select.options].some(option => option.value === "grok"))!;
  expect(select).toBeDefined();
  await act(async () => {
    select.value = "grok";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  return select;
}
const tabs = () => useWorkspaceListStore.getState().workspaces.flatMap(workspace => workspace.panes.flatMap(pane => pane.tabs));

const inputs = () => [...host.querySelectorAll<HTMLInputElement>("input")]
  .filter(input => !input.closest("[hidden]"));

const grokHome = { provider: "grok", profile_id: "grok-a", state: "ready" };
const workspaceCount = () => useWorkspaceListStore.getState().workspaces.length;
const setupPanel = () => inputs().find(input => input.placeholder === setupStrings.folderPlaceholder)!
  .closest("[data-cmux-native-webview-occluder]")!;
async function showGrokDraft() {
  ipc.homes = [grokHome];
  await click(titleBarStrings.newWorkspaceAdvanced);
  await selectGrok();
  await click("Grok fixture");
}
function holdNextHomeRead() {
  let resolve!: (result: typeof ipc.homes) => void;
  ipc.nextHomeRead = new Promise(result => { resolve = result; });
  return (homes: typeof ipc.homes) => {
    expect(ipc.nextHomeRead).toBeUndefined();
    return act(async () => resolve(homes));
  };
}
async function changeDraftInput(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(input.value).toBe(value);
}

describe("workspace creation stays available after account login", () => {
  it.each(["Claude Code", "Gemini"])("restores the AppShell draft in another workspace with the %s login tab still open", async provider => {
    await click(titleBarStrings.newWorkspaceAdvanced);
    const input = inputs().find(item => item.placeholder === "first")!;
    expect(input).toBeDefined();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "saved draft");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(input.value).toBe("saved draft");

    if (provider === "Gemini") {
      await click(dashboardStrings.buttonTitle);
      expect(host.querySelector("[data-dashboard-fixture]")).not.toBeNull();
      await act(async () => useUsageStore.setState({ accounts: [geminiSignedOut] }));
    }
    await click(titleBarStrings.settings);
    const accountNavigation = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] nav button')]
      .find(button => button.textContent?.startsWith("アカウント・使用量"));
    expect(accountNavigation).toBeDefined();
    await act(async () => accountNavigation!.click());
    if (provider === "Gemini") {
      await click("ログイン", document.querySelector('section[aria-label="Gemini"]')!);
    } else {
      await click("Claude Code のアカウントを追加", document);
    }
    const login = () => useWorkspaceListStore.getState().getWorkspace(first)?.panes.flatMap(pane => pane.tabs).find(tab =>
      provider === "Gemini" ? tab.launchEnv?.MYCMUX_LAUNCH_TARGET === "agy" : tab.launchEnv?.MYCMUX_CLI_LOGIN_ID === "fixture-login");
    expect(login()?.ephemeral).toBe(true);
    expect(inputs().some(item => item.value === "saved draft")).toBe(false);
    expect(host.querySelector("[data-dashboard-fixture]")).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(OVERLAY_EXIT_MS));

    await act(async () => useWorkspaceListStore.getState().setActiveWorkspace(second));
    await click(titleBarStrings.newWorkspaceAdvanced);
    const restored = inputs().find(item => item.value === "saved draft");
    expect(restored?.placeholder).toBe("first");
    expect(inputs().find(item => item.placeholder === setupStrings.folderPlaceholder)?.value).toBe("/fixture/first");
    expect(login()).toBeDefined();
  });
});

describe("front account controls own their Enter key", () => {
  it.each(["Gemini login", "account management", "workspace account link"] as const)(
    "leaves Enter with the front %s instead of the active Claude launcher", async entry => {
      const pane = useWorkspaceListStore.getState().getWorkspace(first)!.panes[0];
      await act(async () => useUiStore.getState().setActivePaneId(pane.tabs[0].sessionId));
      const border = host.querySelector<HTMLElement>(".terminal-pane-border")!;
      expect(border).not.toBeNull();
      await act(async () => border.focus());
      await click(launcherStrings.specTooltip("Claude Code"), border);
      expect(border.querySelector("[data-launcher-spec]")).not.toBeNull();
      const before = new Set(tabs().map(tab => tab.id));

      let target: HTMLButtonElement;
      if (entry === "workspace account link") {
        await click(titleBarStrings.newWorkspaceAdvanced);
        const selector = await selectGrok();
        target = button(launcherStrings.accountManagement, selector.parentElement!);
      } else {
        await act(async () => useUsageStore.setState({ accounts: [geminiSignedOut] }));
        const trigger = host.querySelector<HTMLButtonElement>('[aria-controls="accounts-panel"]')!;
        await act(async () => trigger.click());
        const panel = document.getElementById("accounts-panel")!;
        expect(panel).not.toBeNull();
        target = button(entry === "Gemini login" ? "ログイン" : "アカウント管理", panel);
      }
      expect(useUiStore.getState().activePaneId).toBe(pane.tabs[0].sessionId);
      expect(border.contains(target)).toBe(false);
      const press = await pressEnter(target);
      await act(async () => vi.advanceTimersByTimeAsync(80));
      const addedTargets = () => tabs().filter(tab => !before.has(tab.id)).map(tab => tab.launchEnv?.MYCMUX_LAUNCH_TARGET);
      expect(addedTargets()).toEqual(entry === "Gemini login" ? ["agy"] : []);
      expect(press.defaultPrevented).toBe(false);
      if (entry === "Gemini login") return;

      const manager = document.querySelector('[role="dialog"][aria-modal="true"]')!;
      expect(manager).not.toBeNull();
      if (entry === "workspace account link") {
        expect(document.activeElement).toBe(manager.querySelector('[data-account-provider="grok"]'));
      }
      await click("設定を閉じる", manager);
      if (entry === "workspace account link") await click(setupStrings.cancel, setupPanel());
      await act(async () => vi.advanceTimersByTimeAsync(OVERLAY_EXIT_MS));
      await pressEnter(border);
      expect(addedTargets()).toEqual(["claude"]);
    },
  );
});

it.each(["workspace creation", "usage panel"] as const)("keeps Enter from the launcher immediately after opening %s", async overlay => {
  const pane = useWorkspaceListStore.getState().getWorkspace(first)!.panes[0];
  await act(async () => useUiStore.getState().setActivePaneId(pane.tabs[0].sessionId));
  const border = host.querySelector<HTMLElement>(".terminal-pane-border")!;
  await click(launcherStrings.specTooltip("Claude Code"), border);
  expect(border.querySelector("[data-launcher-spec]")).not.toBeNull();
  await act(async () => border.focus());
  expect(document.activeElement).toBe(border);
  const before = new Set(tabs().map(tab => tab.id));

  const usageTrigger = host.querySelector<HTMLButtonElement>('[aria-controls="accounts-panel"]')!;
  if (overlay === "workspace creation") {
    await act(async () => border.dispatchEvent(new KeyboardEvent("keydown", {
      key: "n", code: "KeyN", ctrlKey: true, shiftKey: true, altKey: true, bubbles: true, cancelable: true,
    })));
    expect(useUiStore.getState().workspaceSetupVisible).toBe(true);
  } else {
    await act(async () => usageTrigger.click());
    expect(document.getElementById("accounts-panel")).not.toBeNull();
  }
  // In particular, do not move focus off the old border before Enter.
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Enter", code: "Enter", bubbles: true, cancelable: true,
  })));
  const added = () => tabs().filter(tab => !before.has(tab.id)).map(tab => tab.launchEnv?.MYCMUX_LAUNCH_TARGET);
  expect(added()).toEqual([]);
  expect(border.closest("[inert]")).not.toBeNull();

  if (overlay === "workspace creation") await click(setupStrings.cancel, setupPanel());
  else await act(async () => usageTrigger.click());
  await act(async () => vi.advanceTimersByTimeAsync(OVERLAY_EXIT_MS));
  expect(border.closest("[inert]")).toBeNull();
  await pressEnter(border);
  expect(added()).toEqual(["claude"]);
});

it("drops a Grok draft check started after its display reload and before the cleared home is displayed", async () => {
  await showGrokDraft();
  const finishDisplay = holdNextHomeRead();
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(ipc.nextHomeRead).toBeUndefined();
  expect(button("Grok fixture").getAttribute("aria-pressed")).toBe("true");
  const finishCheck = holdNextHomeRead();
  const before = workspaceCount();
  await click(setupStrings.launch);
  expect(ipc.nextHomeRead).toBeUndefined();

  ipc.homes = [];
  await finishDisplay([]);
  expect(host.querySelector('[data-launch-account-choice="grok-a"]')).toBeNull();
  await finishCheck([grokHome]);
  expect(workspaceCount()).toBe(before);
  await click(setupStrings.launch);
  expect(workspaceCount()).toBe(before);
  await click(launcherStrings.specDefault);
  await click(setupStrings.launch);
  expect(workspaceCount()).toBe(before + 1);
  expect(tabs().some(tab => tab.launchEnv?.MYCMUX_LAUNCH_ACCOUNT === "grok-a")).toBe(false);
});

it("drops a held Grok draft after opening and closing management from the title bar", async () => {
  await showGrokDraft();
  const name = inputs().find(input => input.placeholder === "first")!;
  await changeDraftInput(name, "title bar draft");
  const finishCheck = holdNextHomeRead();
  const before = workspaceCount();
  await click(setupStrings.launch);
  const trigger = host.querySelector<HTMLButtonElement>('[aria-controls="accounts-panel"]')!;
  await act(async () => trigger.click());
  await click("アカウント管理", document.getElementById("accounts-panel")!);
  await act(async () => vi.advanceTimersByTimeAsync(80));
  const manager = document.querySelector('[role="dialog"][aria-modal="true"]')!;
  expect(manager).not.toBeNull();
  expect(name.closest("[inert]")).not.toBeNull();
  await click("設定を閉じる", manager);
  await act(async () => vi.advanceTimersByTimeAsync(OVERLAY_EXIT_MS));
  expect(name.closest("[inert]")).toBeNull();

  await finishCheck([grokHome]);
  expect(workspaceCount()).toBe(before);
  expect(name.value).toBe("title bar draft");
  expect(button("Grok fixture").getAttribute("aria-pressed")).toBe("true");
  await click(setupStrings.launch);
  expect(workspaceCount()).toBe(before + 1);
  expect(useWorkspaceListStore.getState().getActiveWorkspace()?.name).toBe("title bar draft");
});

it.each(["name", "folder", "folder picker"] as const)(
  "lets the edited %s launch while the obsolete Grok draft read is still held", async field => {
    await showGrokDraft();
    const finishOld = holdNextHomeRead();
    const before = workspaceCount();
    await click(setupStrings.launch);
    expect(button(setupStrings.launch).disabled).toBe(true);
    const folder = inputs().find(input => input.placeholder === setupStrings.folderPlaceholder)!;
    if (field === "name") {
      await changeDraftInput(inputs().find(input => input.placeholder === "first")!, "updated draft");
    } else if (field === "folder") {
      await changeDraftInput(folder, "/fixture/updated");
    } else {
      vi.mocked(openFolderDialog).mockResolvedValueOnce("/fixture/updated");
      await click(setupStrings.browse);
      expect(folder.value).toBe("/fixture/updated");
    }

    expect(button(setupStrings.launch).disabled).toBe(false);
    const finishNew = holdNextHomeRead();
    await click(setupStrings.launch);
    expect(button(setupStrings.launch).disabled).toBe(true);
    await finishOld([grokHome]);
    expect(workspaceCount()).toBe(before);
    expect(button(setupStrings.launch).disabled).toBe(true);
    await finishNew([grokHome]);
    expect(workspaceCount()).toBe(before + 1);
    expect(useWorkspaceListStore.getState().getActiveWorkspace()?.name).toBe(field === "name" ? "updated draft" : "updated");
    expect(tabs().filter(tab => tab.launchEnv?.MYCMUX_LAUNCH_ACCOUNT === "grok-a")).toHaveLength(1);
  },
);

it("drops an in-flight workspace creation when its account management opens and preserves the draft", async () => {
  const grokHome = { provider: "grok", profile_id: "grok-a", state: "ready" };
  ipc.homes = [grokHome];
  await click(titleBarStrings.newWorkspaceAdvanced);
  const name = inputs().find(input => input.placeholder === "first")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "held draft");
    name.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await selectGrok();
  await click("Grok fixture");
  let resolveCheck!: (result: typeof ipc.homes) => void;
  ipc.nextHomeRead = new Promise(resolve => { resolveCheck = resolve; });
  const before = useWorkspaceListStore.getState().workspaces.length;
  await click(setupStrings.launch);
  expect(ipc.nextHomeRead).toBeUndefined();
  expect(button(setupStrings.launch).disabled).toBe(true);

  await click(launcherStrings.accountManagement);
  const manager = document.querySelector('[role="dialog"]')!;
  expect(manager).not.toBeNull();
  expect(name.closest("[inert]")).not.toBeNull();
  const released = !button(setupStrings.launch).disabled;
  await act(async () => resolveCheck([grokHome]));
  expect(useWorkspaceListStore.getState().workspaces).toHaveLength(before);
  expect(released).toBe(true);
  expect(name.value).toBe("held draft");

  await click("設定を閉じる", manager);
  await act(async () => vi.advanceTimersByTimeAsync(OVERLAY_EXIT_MS));
  expect(inputs()).toContain(name);
  expect(button("Grok fixture").getAttribute("aria-pressed")).toBe("true");
  await click(setupStrings.launch);
  expect(useWorkspaceListStore.getState().workspaces).toHaveLength(before + 1);
  expect(useWorkspaceListStore.getState().getActiveWorkspace()?.name).toBe("held draft");
});

async function showChildAppShell(mainExists = false) {
  await act(async () => root.unmount());
  vi.mocked(listen).mockClear();
  ipc.windowLabel = "mycmux-w2";
  ipc.windowLabels = mainExists ? ["main", ipc.windowLabel] : [ipc.windowLabel];
  root = createRoot(host);
  await act(async () => root.render(<AppShell />));
}

async function answerManagementRequest(target: Parameters<typeof emitTo>[0], name: string, payload: unknown) {
  if (name !== OPEN_DASHBOARD_EVENT || !target || typeof target !== "object" || !("label" in target)) return;
  const { requestId } = payload as { requestId: string };
  for (const notify of ipc.accountResults) {
    notify({ payload: { requestId, fromWindow: target.label, reason: "opened" } });
  }
}

function currentManagementSubscription() {
  const call = vi.mocked(invoke).mock.calls.findLast(([name, args]) => name === "publish_window_fragment"
    && args && "accountManagementReady" in args && args.accountManagementReady === true);
  expect(call?.[1]).toMatchObject({ accountManagementSubscriptionId: expect.any(String) });
  return (call![1] as { accountManagementSubscriptionId: string }).accountManagementSubscriptionId;
}

function expectGrokManagementOnce() {
  const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
  expect(dialogs).toHaveLength(1);
  expect(document.activeElement).toBe(dialogs[0].querySelector('[data-account-provider="grok"]'));
}

it("opens the company section once in the surviving launcher window after main closes", async () => {
  await showChildAppShell();
  const pane = useWorkspaceListStore.getState().getWorkspace(first)!.panes[0];
  await act(async () => useUiStore.getState().setActivePaneId(pane.tabs[0].sessionId));
  const border = host.querySelector<HTMLElement>(".terminal-pane-border")!;
  await click(launcherStrings.specTooltip("Grok Build"), border);
  const before = tabs().map(tab => tab.id);
  await click(launcherStrings.accountManagement, border);

  expectGrokManagementOnce();
  expect(emitTo).not.toHaveBeenCalled();
  expect(tabs().map(tab => tab.id)).toEqual(before);
});

it("requests management and raises main when it still exists alongside the launcher window", async () => {
  await showChildAppShell(true);
  const pane = useWorkspaceListStore.getState().getWorkspace(first)!.panes[0];
  await act(async () => useUiStore.getState().setActivePaneId(pane.tabs[0].sessionId));
  const border = host.querySelector<HTMLElement>(".terminal-pane-border")!;
  await click(launcherStrings.specTooltip("Grok Build"), border);
  await click(launcherStrings.accountManagement, border);

  expect(emitTo).toHaveBeenCalledExactlyOnceWith(
    { kind: "Webview", label: "main" }, OPEN_DASHBOARD_EVENT, {
      accountProvider: "grok", targetWindow: "main", sourceWindow: ipc.windowLabel,
      publicationId: "", subscriptionId: "fixture-main-listener",
      requestId: expect.any(String), expiresAt: expect.any(Number),
    },
  );
  expect(invoke).toHaveBeenCalledWith("focus_window", expect.objectContaining({ label: "main" }));
  expect(document.querySelector('[role="dialog"][aria-modal="true"]')).toBeNull();

  // Deliver the captured event to an actual main AppShell in this test webview.
  const [, event, payload] = vi.mocked(emitTo).mock.calls[0];
  await act(async () => root.unmount());
  vi.mocked(listen).mockClear();
  ipc.windowLabel = "main";
  root = createRoot(host);
  await act(async () => root.render(<AppShell />));
  const request = vi.mocked(listen).mock.calls.find(([name, , options]) => name === event
    && typeof options?.target === "object" && "label" in options.target && options.target.label === "main");
  expect(request).toBeDefined();
  const before = settingsRequests.mock.calls.length;
  await act(async () => request![1]({
    event, id: 1, payload: { ...payload as Record<string, unknown>, subscriptionId: currentManagementSubscription() },
  }));
  expectGrokManagementOnce();
  expect(settingsRequests.mock.calls.slice(before)).toEqual([[
    "usage", "grok", undefined, (payload as { requestId: string }).requestId,
  ]]);
});

it.each(["before delivery", "before focus"] as const)(
  "makes exactly one routing decision when main closes %s", async when => {
    await showChildAppShell(true);
    vi.mocked(emitTo).mockImplementationOnce(async (...request) => {
      if (when === "before delivery") {
        ipc.windowLabels = [ipc.windowLabel];
        throw new Error("fixture main closed");
      }
      const reply = answerManagementRequest(...request);
      ipc.windowLabels = [ipc.windowLabel];
      ipc.denyFocus = true;
      return reply;
    });
    const pane = useWorkspaceListStore.getState().getWorkspace(first)!.panes[0];
    await act(async () => useUiStore.getState().setActivePaneId(pane.tabs[0].sessionId));
    const border = host.querySelector<HTMLElement>(".terminal-pane-border")!;
    await click(launcherStrings.specTooltip("Grok Build"), border);
    const settingsStart = settingsRequests.mock.calls.length;
    const focusStart = vi.mocked(invoke).mock.calls.length;
    await click(launcherStrings.accountManagement, border);

    expect(vi.mocked(invoke).mock.calls.slice(focusStart)
      .filter(([name, args]) => name === "focus_window" && args && "label" in args && args.label === "main"))
      .toHaveLength(Number(when === "before focus"));
    expect(emitTo).toHaveBeenCalledExactlyOnceWith(
      { kind: "Webview", label: "main" }, OPEN_DASHBOARD_EVENT, {
        accountProvider: "grok", targetWindow: "main", sourceWindow: ipc.windowLabel,
        publicationId: "", subscriptionId: "fixture-main-listener",
        requestId: expect.any(String), expiresAt: expect.any(Number),
      },
    );
    expect(settingsRequests.mock.calls.slice(settingsStart)
      .filter(([tab, provider]) => tab === "usage" && provider === "grok")).toHaveLength(1);
    expectGrokManagementOnce();
    expect(border.querySelector('[role="alert"]')).toBeNull();
    expect(getAllWindows).toHaveBeenCalledTimes(2);
  },
);

it("rechecks the settings mount when the launcher becomes detached while enumerating windows", async () => {
  await showChildAppShell();
  const ws = useWorkspaceListStore.getState().getWorkspace(first)!;
  const pane = ws.panes[0];
  await act(async () => useUiStore.getState().setActivePaneId(pane.tabs[0].sessionId));
  const border = host.querySelector<HTMLElement>(".terminal-pane-border")!;
  await click(launcherStrings.specTooltip("Grok Build"), border);
  const open = settingsRequests;
  let finishList!: (rows: Awaited<ReturnType<typeof getAllWindows>>) => void;
  vi.mocked(getAllWindows).mockReturnValueOnce(new Promise(resolve => { finishList = resolve; }));
  await click(launcherStrings.accountManagement, border);
  expect(getAllWindows).toHaveBeenCalledOnce();
  await act(async () => root.render(<DetachedPaneShell workspace={{ ...ws, detached: true }} />));
  await act(async () => finishList([]));
  expect(open).not.toHaveBeenCalled();
  expect(vi.mocked(invoke).mock.calls.filter(([name]) => name === "focus_window")).toHaveLength(0);
});

it("does not open local settings when quit preparation precedes the pending index response", async () => {
  await showChildAppShell(true);
  const pane = useWorkspaceListStore.getState().getWorkspace(first)!.panes[0];
  await act(async () => useUiStore.getState().setActivePaneId(pane.tabs[0].sessionId));
  const border = host.querySelector<HTMLElement>(".terminal-pane-border")!;
  await click(launcherStrings.specTooltip("Grok Build"), border);

  let finishIndex!: (rows: unknown[]) => void;
  const held = new Promise(resolve => { finishIndex = resolve; });
  const original = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((name, args, options) => name === "get_window_tab_index"
    ? held as ReturnType<typeof invoke> : original(name, args, options));
  try {
    const open = settingsRequests;
    await click(launcherStrings.accountManagement, border);
    expect(invoke).toHaveBeenCalledWith("get_window_tab_index", { includeQuitState: true });
    await stopNewLayoutOperations();
    await act(async () => finishIndex([{ window_label: "main", pending: false, workspaces: [], account_management_ready: false }]));
    expect(open).not.toHaveBeenCalled();
    expect(emitTo).not.toHaveBeenCalled();
    expect(vi.mocked(invoke).mock.calls.filter(([name]) => name === "focus_window")).toHaveLength(0);
  } finally {
    vi.mocked(invoke).mockImplementation(original);
  }
});

it("keeps one delivery and no local dialog when the OS refuses to focus a live main", async () => {
  await showChildAppShell(true);
  ipc.denyFocus = true;
  const pane = useWorkspaceListStore.getState().getWorkspace(first)!.panes[0];
  await act(async () => useUiStore.getState().setActivePaneId(pane.tabs[0].sessionId));
  const border = host.querySelector<HTMLElement>(".terminal-pane-border")!;
  await click(launcherStrings.specTooltip("Grok Build"), border);
  const settingsStart = settingsRequests.mock.calls.length;
  const focusStart = vi.mocked(invoke).mock.calls.length;
  await click(launcherStrings.accountManagement, border);

  expect(settingsRequests.mock.calls.slice(settingsStart)).toHaveLength(0);
  expect(vi.mocked(invoke).mock.calls.slice(focusStart)
    .filter(([name, args]) => name === "focus_window" && args && "label" in args && args.label === "main")).toHaveLength(1);

  expect(emitTo).toHaveBeenCalledExactlyOnceWith(
    { kind: "Webview", label: "main" }, OPEN_DASHBOARD_EVENT, {
      accountProvider: "grok", targetWindow: "main", sourceWindow: ipc.windowLabel,
      publicationId: "", subscriptionId: "fixture-main-listener",
      requestId: expect.any(String), expiresAt: expect.any(Number),
    },
  );
  expect(getAllWindows).toHaveBeenCalledOnce();
  expect(document.querySelector('[role="dialog"][aria-modal="true"]')).toBeNull();
  expect(border.querySelector('[role="alert"]')).toBeNull();
});

it("retries one failed window enumeration and still opens management in the live main", async () => {
  await showChildAppShell(true);
  vi.mocked(getAllWindows).mockRejectedValueOnce(new Error("fixture window list unavailable"));
  const pane = useWorkspaceListStore.getState().getWorkspace(first)!.panes[0];
  await act(async () => useUiStore.getState().setActivePaneId(pane.tabs[0].sessionId));
  const border = host.querySelector<HTMLElement>(".terminal-pane-border")!;
  await click(launcherStrings.specTooltip("Grok Build"), border);
  const settingsStart = settingsRequests.mock.calls.length;
  const focusStart = vi.mocked(invoke).mock.calls.length;
  await click(launcherStrings.accountManagement, border);

  expect(emitTo).toHaveBeenCalledExactlyOnceWith(
    { kind: "Webview", label: "main" }, OPEN_DASHBOARD_EVENT, {
      accountProvider: "grok", targetWindow: "main", sourceWindow: ipc.windowLabel,
      publicationId: "", subscriptionId: "fixture-main-listener",
      requestId: expect.any(String), expiresAt: expect.any(Number),
    },
  );
  expect(invoke).toHaveBeenCalledWith("focus_window", expect.objectContaining({ label: "main" }));
  expect(getAllWindows).toHaveBeenCalledTimes(2);
  expect(settingsRequests.mock.calls.slice(settingsStart)
    .filter(([tab, provider]) => tab === "usage" && provider === "grok")).toHaveLength(0);
  expect(vi.mocked(invoke).mock.calls.slice(focusStart).filter(([name, args]) => name === "focus_window"
    && args && "label" in args && args.label === "main")).toHaveLength(1);
  expect(document.querySelector('[role="dialog"][aria-modal="true"]')).toBeNull();
});

it("opens the company section once on a management request addressed to a surviving AppShell", async () => {
  await showChildAppShell();
  const request = vi.mocked(listen).mock.calls.find(([name, , options]) => name === OPEN_DASHBOARD_EVENT
    && typeof options?.target === "object" && "label" in options.target && options.target.label === ipc.windowLabel);
  expect(request).toBeDefined();
  const before = tabs().map(tab => tab.id);
  await act(async () => request![1]({ event: OPEN_DASHBOARD_EVENT, id: 1, payload: {
    accountProvider: "grok", sourceWindow: "mycmux-w9", targetWindow: ipc.windowLabel,
    requestId: "fixture-request", expiresAt: Date.now() + ACCOUNT_MANAGEMENT_TIMEOUT_MS,
    publicationId: "", subscriptionId: currentManagementSubscription(),
  } }));

  expectGrokManagementOnce();
  expect(useDashboardViewStore.getState().open).toBe(false);
  expect(emitTo).toHaveBeenCalledExactlyOnceWith({ kind: "Webview", label: "mycmux-w9" },
    ACCOUNT_MANAGEMENT_RESULT_EVENT, { requestId: "fixture-request", fromWindow: ipc.windowLabel, reason: "opened" });
  expect(tabs().map(tab => tab.id)).toEqual(before);
});

it("discards a held launcher check under the dashboard and launches only after a new press", async () => {
  ipc.homes = [grokHome];
  const pane = useWorkspaceListStore.getState().getWorkspace(first)!.panes[0];
  await act(async () => useUiStore.getState().setActivePaneId(pane.tabs[0].sessionId));
  const border = host.querySelector<HTMLElement>(".terminal-pane-border")!;
  await click(launcherStrings.specTooltip("Grok Build"), border);
  await click("Grok fixture", border);
  const added = () => tabs().filter(tab => tab.launchEnv?.MYCMUX_LAUNCH_ACCOUNT === grokHome.profile_id);
  const finishCheck = holdNextHomeRead();
  await click(launcherStrings.launchButton, border);
  expect(button(launcherStrings.launchButton, border).disabled).toBe(true);
  expect(added()).toHaveLength(0);

  const dashboardButton = button(dashboardStrings.buttonTitle);
  await act(async () => { dashboardButton.focus(); dashboardButton.click(); });
  const dashboard = host.querySelector<HTMLElement>("[data-dashboard-fixture]")!;
  expect(dashboard).not.toBeNull();
  await act(async () => dashboard.focus());
  expect(document.activeElement).toBe(dashboard);
  expect(getComputedStyle(border).visibility).toBe("hidden");
  await finishCheck([grokHome]);
  expect(useDashboardViewStore.getState().open).toBe(true);
  expect(added()).toHaveLength(0);
  expect(border.closest("[inert]")).not.toBeNull();

  await click(dashboardStrings.buttonTitle);
  expect(useDashboardViewStore.getState().open).toBe(false);
  expect(border.closest("[inert]")).toBeNull();
  expect(added()).toHaveLength(0);
  expect(button("Grok fixture", border).getAttribute("aria-pressed")).toBe("true");
  expect(button(launcherStrings.launchButton, border).disabled).toBe(false);
  await click(launcherStrings.launchButton, border);
  expect(added()).toHaveLength(1);
});

it.each(["workspace creation", "usage panel", "account management", "shortcut and Enter"] as const)(
  "releases a held launcher check across %s and accepts only the next press", async overlay => {
    ipc.homes = [grokHome];
    const pane = useWorkspaceListStore.getState().getWorkspace(first)!.panes[0];
    await act(async () => useUiStore.getState().setActivePaneId(pane.tabs[0].sessionId));
    const border = host.querySelector<HTMLElement>(".terminal-pane-border")!;
    await click(launcherStrings.specTooltip("Grok Build"), border);
    await click("Grok fixture", border);
    const added = () => tabs().filter(tab => tab.launchEnv?.MYCMUX_LAUNCH_ACCOUNT === "grok-a");
    const finishOld = holdNextHomeRead();
    await click(launcherStrings.launchButton, border);
    expect(button(launcherStrings.launchButton, border).disabled).toBe(true);

    const usageTrigger = host.querySelector<HTMLButtonElement>('[aria-controls="accounts-panel"]')!;
    if (overlay === "shortcut and Enter") {
      await act(async () => {
        border.focus();
        border.dispatchEvent(new KeyboardEvent("keydown", {
          key: "n", code: "KeyN", ctrlKey: true, shiftKey: true, altKey: true, bubbles: true, cancelable: true,
        }));
      });
    } else if (overlay === "workspace creation") {
      await click(titleBarStrings.newWorkspaceAdvanced);
    } else {
      await act(async () => usageTrigger.click());
      const panel = document.getElementById("accounts-panel")!;
      expect(panel).not.toBeNull();
      if (overlay === "account management") await click("アカウント管理", panel);
    }

    if (overlay === "account management") await act(async () => vi.advanceTimersByTimeAsync(80));
    expect(border.closest("[inert]")).not.toBeNull();
    if (overlay === "workspace creation" || overlay === "shortcut and Enter") {
      const cancel = button(setupStrings.cancel, setupPanel());
      if (overlay === "shortcut and Enter") await pressEnter(cancel);
      else await act(async () => cancel.click());
    } else if (overlay === "account management") {
      const manager = document.querySelector('[role="dialog"][aria-modal="true"]')!;
      expect(manager).not.toBeNull();
      await click("設定を閉じる", manager);
    } else {
      await act(async () => usageTrigger.click());
    }
    await act(async () => vi.advanceTimersByTimeAsync(OVERLAY_EXIT_MS));
    expect(border.closest("[inert]")).toBeNull();
    expect(button(launcherStrings.launchButton, border).disabled).toBe(false);
    await finishOld([grokHome]);
    expect(added()).toHaveLength(0);
    expect(button("Grok fixture", border).getAttribute("aria-pressed")).toBe("true");
    await click(launcherStrings.launchButton, border);
    expect(added()).toHaveLength(1);
  },
);

it("F3-06 suppresses the local fallback when Rust is quitting before the prepare event is delivered", async () => {
  await showChildAppShell(true);
  const pane = useWorkspaceListStore.getState().getWorkspace(first)!.panes[0];
  await act(async () => useUiStore.getState().setActivePaneId(pane.tabs[0].sessionId));
  const border = host.querySelector<HTMLElement>(".terminal-pane-border")!;
  await click(launcherStrings.specTooltip("Grok Build"), border);

  let answerIndex!: () => void;
  const held = new Promise<void>(resolve => { answerIndex = resolve; });
  const original = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((name, args, options) => {
    if (name !== "get_window_tab_index") return original(name, args, options);
    return held.then(() => {
      const windows = [{ window_label: "main", pending: false, workspaces: [], account_management_ready: false }];
      return args && "includeQuitState" in args && args.includeQuitState
        ? { windows, quitting: true } : windows;
    }) as ReturnType<typeof invoke>;
  });
  try {
    await click(launcherStrings.accountManagement, border);
    expect(vi.mocked(invoke).mock.calls.filter(([name]) => name === "get_window_tab_index")).toHaveLength(1);
    expect(isPreparingLayoutQuit()).toBe(false);
    await act(async () => answerIndex());
    expect(isPreparingLayoutQuit()).toBe(false);
    expect(settingsRequests).not.toHaveBeenCalled();
    expect(host.querySelector('[role="dialog"][aria-modal="true"]')).toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(emitTo).not.toHaveBeenCalled();
    expect(vi.mocked(invoke).mock.calls.filter(([name]) => name === "focus_window")).toHaveLength(0);
  } finally {
    vi.mocked(invoke).mockImplementation(original);
  }
});

it("F4-06 reports failure when the index rejects both reads after main closes", async () => {
  await showChildAppShell();
  expect(ipc.windowLabels).toEqual([ipc.windowLabel]);
  const pane = useWorkspaceListStore.getState().getWorkspace(first)!.panes[0];
  await act(async () => useUiStore.getState().setActivePaneId(pane.tabs[0].sessionId));
  const border = host.querySelector<HTMLElement>(".terminal-pane-border")!;
  await click(launcherStrings.specTooltip("Grok Build"), border);

  const invokeBase = vi.mocked(invoke).getMockImplementation()!;
  const readIndex = vi.fn().mockRejectedValue(new Error("fixture index unavailable"));
  vi.mocked(invoke).mockImplementation((name, args, options) =>
    name === "get_window_tab_index" ? readIndex(args) : invokeBase(name, args, options));
  try {
    await click(launcherStrings.accountManagement, border);
    expect(readIndex.mock.calls).toEqual([[{ includeQuitState: true }], [{ includeQuitState: true }]]);
    expect(emitTo).not.toHaveBeenCalled();
    expect(vi.mocked(invoke).mock.calls.filter(([name]) => name === "focus_window")).toHaveLength(0);
    expect.soft(settingsRequests).not.toHaveBeenCalled();
    expect.soft(host.querySelectorAll('[data-account-provider="grok"]')).toHaveLength(0);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(launcherStrings.accountManagementFailed);
  } finally {
    vi.mocked(invoke).mockImplementation(invokeBase);
  }
});
