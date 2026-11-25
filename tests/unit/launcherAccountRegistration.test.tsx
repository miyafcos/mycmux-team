// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WindowTabIndex } from "../../src/lib/ipc";
import { DELEGATION_QUERY_TIMEOUT_MS } from "../../src/components/dashboard/delegationModel";

const mocks = vi.hoisted(() => ({
  list: vi.fn(), tokens: vi.fn(), homes: vi.fn(), begin: vi.fn(), home: vi.fn(),
  window: "main", emitTo: vi.fn(), focusWindow: vi.fn(),
  getAllWindows: vi.fn(), getWindowFragments: vi.fn(), getWindowTabIndex: vi.fn<() => Promise<WindowTabIndex[]>>(),
  listeners: new Set<() => void>(),
  replies: new Set<(event: { payload: unknown }) => void>(),
  reply: "opened" as string | null,
  settings: { launcherHiddenIds: [], crsmShowClaude: true, crsmShowCodex: true, crsmShowClaudeCodex: true, hideSessionsWithoutUserMessages: true },
  dirs: { view: null, load: async () => {} },
  layout: { addTabToPaneWithOptions: vi.fn(), addWebTabToPane: vi.fn(), removeTabFromPane: vi.fn() },
  ui: { setActivePaneId: vi.fn(), requestSettingsTab: vi.fn() },
}));
vi.mock("../../src/lib/ipc", () => ({
  crsmListSessions: async () => [], launcherRecordDirMru: async () => {},
  listCliAccounts: mocks.list, getCliLaunchTokens: mocks.tokens, listCliAccountHomes: mocks.homes,
  startClaudeSetupToken: mocks.begin, focusWindow: mocks.focusWindow, OPEN_DASHBOARD_EVENT: "mycmux://open-dashboard",
  getWindowFragments: mocks.getWindowFragments, getWindowTabIndex: mocks.getWindowTabIndex,
}));
vi.mock("@tauri-apps/api/window", async importOriginal => ({
  ...await importOriginal<typeof import("@tauri-apps/api/window")>(),
  getAllWindows: mocks.getAllWindows,
}));
vi.mock("@tauri-apps/api/event", () => ({
  emitTo: mocks.emitTo,
  listen: vi.fn(async (name: string, notify: (event: { payload: unknown }) => void) => {
    if (name === "mycmux://account-management-result") {
      mocks.replies.add(notify);
      return () => { mocks.replies.delete(notify); };
    }
    const change = () => notify({ payload: undefined });
    if (name === "tab-account-evidence-updated") mocks.listeners.add(change);
    return () => { mocks.listeners.delete(change); };
  }),
}));
vi.mock("../../src/lib/windowContext", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/lib/windowContext")>(),
  windowLabel: () => mocks.window,
}));
vi.mock("../../src/stores/settingsStore", () => ({ useSettingsStore: (select: (s: typeof mocks.settings) => unknown) => select(mocks.settings) }));
vi.mock("../../src/stores/launcherDirsStore", () => ({ useLauncherDirsStore: (select: (s: typeof mocks.dirs) => unknown) => select(mocks.dirs) }));
vi.mock("../../src/stores/workspaceLayoutStore", () => ({ useWorkspaceLayoutStore: (select: (s: typeof mocks.layout) => unknown) => select(mocks.layout) }));
vi.mock("../../src/stores/uiStore", () => ({ useUiStore: Object.assign((select: (s: typeof mocks.ui) => unknown) => select(mocks.ui), { getState: () => mocks.ui, subscribe: () => () => {} }) }));
vi.mock("../../src/stores/cliLoginStore", () => ({
  useCliLoginStore: { getState: () => ({ startAccountHome: mocks.home }) },
}));
vi.mock("../../src/lib/claudeCodexModels", () => ({ useLaunchModels: () => [] }));

import LauncherPane from "../../src/components/workspace/LauncherPane";
import { launcherStrings as S } from "../../src/components/workspace/launcherStrings";
import { getCatalogEntry } from "../../src/lib/agentCatalog";
import { ACCOUNT_MANAGEMENT_TIMEOUT_MS, registerAccountManagementSettings } from "../../src/lib/mainDashboardRequests";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView = () => {};
let host: HTMLDivElement;
let root: Root;
let stopSettings: () => void;
const claude = { id: "claude-fixture", provider: "claude", label: "Claude fixture" };
const token = { profile_id: claude.id, expires_at: "2099-01-01T00:00:00Z", owner_check: "verified" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.window = "main";
  stopSettings = registerAccountManagementSettings();
  mocks.replies.clear();
  mocks.reply = "opened";
  mocks.list.mockResolvedValue({ profiles: [claude, ...["codex", "grok"].map(provider => ({
    id: provider + "-fixture", provider, label: provider + " fixture",
  }))] });
  mocks.tokens.mockResolvedValue([]);
  mocks.homes.mockResolvedValue([]);
  mocks.focusWindow.mockResolvedValue(undefined);
  mocks.emitTo.mockImplementation(async (target: { label: string }, event: string, payload: { requestId: string }) => {
    if (event !== "mycmux://open-dashboard" || mocks.reply === null) return;
    for (const notify of mocks.replies) {
      notify({ payload: { requestId: payload.requestId, fromWindow: target.label, reason: mocks.reply } });
    }
  });
  mocks.getAllWindows.mockResolvedValue([{ label: "main" }, { label: "mycmux-w-fixture" }]);
  mocks.getWindowFragments.mockResolvedValue([]);
  mocks.getWindowTabIndex.mockResolvedValue([windowIndex("main", true)]);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); stopSettings(); host.remove(); vi.useRealTimers(); });

const fixtureSubscription = { publication_id: "fixture-generation", subscription_id: "fixture-listener" };

function windowIndex(window_label: string, account_management_ready: boolean, pending = false): WindowTabIndex {
  return {
    window_label, pending, workspaces: [], account_management_ready,
    account_management_subscription: account_management_ready
      ? fixtureSubscription : undefined,
  };
}

function button(label: string) {
  const found = [...host.querySelectorAll<HTMLButtonElement>("button")]
    .find(node => node.textContent === label || node.getAttribute("aria-label") === label);
  expect(found, label).toBeDefined();
  return found!;
}
async function click(label: string) { await act(async () => button(label).click()); }
async function key(value: string) {
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })));
}
async function render(tabId = "tab", paneId = "pane", focused = true) {
  await act(async () => root.render(<LauncherPane workspaceId="ws" paneId={paneId} tabId={tabId} sessionId={tabId} isActive={focused} />));
}
async function show(provider: string) {
  await click(S.specTooltip(getCatalogEntry(provider)!.label));
}
async function changed() {
  await act(async () => { for (const notify of mocks.listeners) notify(); });
}

describe("launcher management navigation", () => {
  it.each(["claude", "codex", "grok"])("opens the %s section by keyboard without starting registration or a tab", async provider => {
    await render();
    await show(provider);
    await key("ArrowRight");
    expect(button(S.accountManagement).getAttribute("aria-current")).toBe("true");
    await key("Enter");
    expect(mocks.ui.requestSettingsTab).toHaveBeenCalledExactlyOnceWith("usage", provider);
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(mocks.home).not.toHaveBeenCalled();
    expect(mocks.layout.addTabToPaneWithOptions).not.toHaveBeenCalled();
    expect(host.querySelector("[data-claude-setup-token]")).toBeNull();
  });

  it.each([false, true])("uses a one-way detached navigation even when focusing fails (%s)", async noFocus => {
    mocks.window = "mycmux-w-fixture";
    if (noFocus) mocks.focusWindow.mockRejectedValue("window_focus_refused");
    await render();
    await show("claude");
    await click(S.accountManagement);
    expect(mocks.emitTo).toHaveBeenCalledExactlyOnceWith({ kind: "Webview", label: "main" }, "mycmux://open-dashboard", {
      accountProvider: "claude", sourceWindow: mocks.window, targetWindow: "main",
      publicationId: "fixture-generation", subscriptionId: "fixture-listener",
      requestId: expect.any(String), expiresAt: expect.any(Number),
    });
    expect(mocks.focusWindow).toHaveBeenCalledExactlyOnceWith("main", { accountManagementSubscription: fixtureSubscription });
    mocks.tokens.mockResolvedValue([token]);
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(button(claude.label).getAttribute("aria-pressed")).toBe("false");
    expect(button(S.specDefault).getAttribute("aria-pressed")).toBe("true");
    await click(claude.label);
    await click(S.launchButton);
    expect(mocks.layout.addTabToPaneWithOptions.mock.calls[0][2].launchEnv).toEqual({
      MYCMUX_LAUNCH_TARGET: "claude", MYCMUX_LAUNCH_ACCOUNT: claude.id,
    });
  });

  it("routes a detached launcher to one live window with settings after main closes", async () => {
    mocks.window = "mycmux-w1";
    mocks.getAllWindows.mockResolvedValue(["mycmux-w1", "mycmux-w2", "mycmux-w3", "mycmux-w5", "mycmux-w6"]
      .map(label => ({ label })));
    mocks.getWindowTabIndex.mockResolvedValue([
      windowIndex("mycmux-w1", false), windowIndex("mycmux-w2", false), windowIndex("mycmux-w3", true, true),
      windowIndex("mycmux-w4", true), windowIndex("mycmux-w5", true), windowIndex("mycmux-w6", true),
    ]);
    await render();
    await show("claude");
    await click(S.accountManagement);
    expect(mocks.emitTo).toHaveBeenCalledExactlyOnceWith(
      { kind: "Webview", label: "mycmux-w5" }, "mycmux://open-dashboard", {
      accountProvider: "claude", sourceWindow: mocks.window, targetWindow: "mycmux-w5",
      publicationId: "fixture-generation", subscriptionId: "fixture-listener",
      requestId: expect.any(String), expiresAt: expect.any(Number),
    },
    );
    expect(mocks.focusWindow).toHaveBeenCalledExactlyOnceWith("mycmux-w5", { accountManagementSubscription: fixtureSubscription });
    expect(mocks.ui.requestSettingsTab).not.toHaveBeenCalled();
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(mocks.home).not.toHaveBeenCalled();
    expect(mocks.layout.addTabToPaneWithOptions).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("shows a management error in the detached launcher when no live window has settings", async () => {
    mocks.window = "mycmux-w1";
    mocks.getAllWindows.mockResolvedValue([{ label: "mycmux-w1" }, { label: "mycmux-w2" }]);
    mocks.getWindowTabIndex.mockResolvedValue([
      { window_label: "mycmux-w2", pending: false, workspaces: [] },
      windowIndex("mycmux-w3", true),
    ]);
    await render();
    await show("claude");
    await click(S.accountManagement);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(S.accountManagementFailed);
    expect(mocks.emitTo).not.toHaveBeenCalled();
    expect(mocks.focusWindow).not.toHaveBeenCalled();
    expect(mocks.ui.requestSettingsTab).not.toHaveBeenCalled();
  });

  it("reports that the management window closed during delivery", async () => {
    mocks.window = "mycmux-w1";
    const peer = "mycmux-w2";
    mocks.getAllWindows.mockResolvedValueOnce(["main", mocks.window, peer].map(label => ({ label })))
      .mockResolvedValue([mocks.window, peer].map(label => ({ label })));
    mocks.getWindowTabIndex.mockResolvedValue([windowIndex("main", true), windowIndex(peer, true)]);
    mocks.focusWindow.mockRejectedValueOnce(new Error("window closed"));
    await render();
    await show("claude");
    await click(S.accountManagement);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(S.accountManagementFailed);
    expect(mocks.emitTo).toHaveBeenCalledOnce();
    expect(mocks.focusWindow).toHaveBeenCalledExactlyOnceWith("main", { accountManagementSubscription: fixtureSubscription });
    expect(mocks.ui.requestSettingsTab).not.toHaveBeenCalled();
  });

  it("chooses the next ready window once when main disappears before delivery from a detached launcher", async () => {
    mocks.window = "mycmux-w1";
    const peer = "mycmux-w2";
    mocks.getAllWindows.mockResolvedValueOnce(["main", mocks.window, peer].map(label => ({ label })))
      .mockResolvedValue([mocks.window, peer].map(label => ({ label })));
    mocks.getWindowTabIndex.mockResolvedValueOnce([windowIndex("main", true), windowIndex(peer, true)])
      .mockResolvedValue([windowIndex(peer, true)]);
    mocks.emitTo.mockRejectedValueOnce(new Error("fixture main disappeared"));
    await render();
    await show("claude");
    await click(S.accountManagement);

    expect(mocks.emitTo.mock.calls.map(([target]) => target.label)).toEqual(["main", peer]);
    expect(mocks.focusWindow).toHaveBeenCalledExactlyOnceWith(peer, { accountManagementSubscription: fixtureSubscription });
    expect(mocks.getWindowTabIndex).toHaveBeenCalledTimes(2);
    expect(mocks.ui.requestSettingsTab).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("uses the first index response when it arrives before the deadline", async () => {
    mocks.window = "mycmux-w1";
    await render();
    await show("claude");
    vi.useFakeTimers();
    let resolveIndex!: (rows: WindowTabIndex[]) => void;
    mocks.getWindowTabIndex.mockReturnValueOnce(new Promise(resolve => { resolveIndex = resolve; }));
    await click(S.accountManagement);
    await act(async () => vi.advanceTimersByTimeAsync(DELEGATION_QUERY_TIMEOUT_MS - 1));
    expect(mocks.emitTo).not.toHaveBeenCalled();
    await act(async () => resolveIndex([windowIndex("main", true)]));
    expect(mocks.getWindowTabIndex).toHaveBeenCalledOnce();
    expect(mocks.emitTo).toHaveBeenCalledOnce();
    expect(mocks.focusWindow).toHaveBeenCalledExactlyOnceWith("main", { accountManagementSubscription: fixtureSubscription });
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("retries a hung window enumeration once and ignores its late result", async () => {
    mocks.window = "mycmux-w1";
    await render();
    await show("claude");
    vi.useFakeTimers();
    let resolveList!: (rows: { label: string }[]) => void;
    mocks.getAllWindows.mockReturnValueOnce(new Promise(resolve => { resolveList = resolve; }))
      .mockResolvedValueOnce([{ label: "main" }]);
    await click(S.accountManagement);
    expect(mocks.getWindowTabIndex).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(DELEGATION_QUERY_TIMEOUT_MS));
    await act(async () => resolveList([]));
    expect(mocks.getAllWindows).toHaveBeenCalledTimes(2);
    expect(mocks.getWindowTabIndex).toHaveBeenCalledOnce();
    expect(mocks.emitTo).toHaveBeenCalledOnce();
    expect(mocks.focusWindow).toHaveBeenCalledExactlyOnceWith("main", { accountManagementSubscription: fixtureSubscription });
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("discards hung index reads and their late results across three registration presses", async () => {
    mocks.window = "mycmux-w1";
    await render();
    await show("claude");
    vi.useFakeTimers();
    let resolveLate!: (rows: WindowTabIndex[]) => void;
    mocks.getWindowTabIndex.mockReturnValue(new Promise(resolve => { resolveLate = resolve; }));

    await click(S.accountManagement);
    await click(S.accountManagement);
    await click(S.accountManagement);
    expect(mocks.getWindowTabIndex).toHaveBeenCalledTimes(3);
    await act(async () => vi.advanceTimersByTimeAsync(2 * DELEGATION_QUERY_TIMEOUT_MS));
    expect(mocks.getWindowTabIndex).toHaveBeenCalledTimes(6);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(S.accountManagementFailed);

    await act(async () => resolveLate([windowIndex("main", true)]));
    expect(mocks.emitTo).not.toHaveBeenCalled();
    expect(mocks.focusWindow).not.toHaveBeenCalled();
    expect(mocks.ui.requestSettingsTab).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(S.accountManagementFailed);
  });

  it("shows an error when a hidden main cannot be shown after management opens", async () => {
    stopSettings();
    mocks.window = "mycmux-w-fixture";
    stopSettings = registerAccountManagementSettings();
    mocks.focusWindow.mockRejectedValueOnce("window_restore_failed");
    await render();
    await show("claude");
    await click(S.accountManagement);
    expect(mocks.emitTo).toHaveBeenCalledOnce();
    expect(mocks.focusWindow).toHaveBeenCalledExactlyOnceWith("main", { accountManagementSubscription: fixtureSubscription });
    expect(mocks.ui.requestSettingsTab).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(S.accountManagementFailed);
  });

  it("shows an error when the live windows cannot be re-read after focus fails", async () => {
    stopSettings();
    mocks.window = "mycmux-w-fixture";
    stopSettings = registerAccountManagementSettings();
    mocks.getAllWindows.mockResolvedValueOnce([{ label: "main" }, { label: mocks.window }])
      .mockRejectedValue(new Error("fixture window list unavailable"));
    mocks.focusWindow.mockRejectedValueOnce(new Error("fixture main closed"));
    await render();
    await show("claude");
    await click(S.accountManagement);
    expect(mocks.getAllWindows).toHaveBeenCalledTimes(3);
    expect(mocks.emitTo).toHaveBeenCalledOnce();
    expect(mocks.focusWindow).toHaveBeenCalledExactlyOnceWith("main", { accountManagementSubscription: fixtureSubscription });
    expect(mocks.ui.requestSettingsTab).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(S.accountManagementFailed);
  });

  it.each([null, "invalid-result"])("does not retry delivery when the reply is uncertain (%s)", async reply => {
    mocks.window = "mycmux-w1";
    mocks.reply = reply;
    mocks.getAllWindows.mockResolvedValue(["main", mocks.window, "mycmux-w2"].map(label => ({ label })));
    mocks.getWindowTabIndex.mockResolvedValue([windowIndex("main", true), windowIndex("mycmux-w2", true)]);
    await render();
    await show("claude");
    vi.useFakeTimers();
    await click(S.accountManagement);
    await act(async () => vi.advanceTimersByTimeAsync(ACCOUNT_MANAGEMENT_TIMEOUT_MS));
    expect(mocks.emitTo).toHaveBeenCalledOnce();
    expect(mocks.getAllWindows).toHaveBeenCalledOnce();
    expect(mocks.focusWindow).not.toHaveBeenCalled();
    expect(mocks.ui.requestSettingsTab).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(S.accountManagementFailed);
  });

  it("never selects a legacy ready row missing its subscription mark", async () => {
    mocks.window = "mycmux-w1";
    mocks.getWindowTabIndex.mockResolvedValue([{ ...windowIndex("main", true), account_management_subscription: undefined }]);
    await render();
    await show("claude");
    await click(S.accountManagement);
    expect(mocks.emitTo).not.toHaveBeenCalled();
    expect(mocks.focusWindow).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(S.accountManagementFailed);
  });

  it("reads a single display index and never fetches workspace fragments to choose a recipient", async () => {
    mocks.window = "mycmux-w1";
    mocks.getAllWindows.mockResolvedValue([{ label: mocks.window }, { label: "mycmux-w2" }]);
    mocks.getWindowFragments.mockResolvedValue([{ window_label: "mycmux-w2", workspaces: [], settings_available: true }]);
    mocks.getWindowTabIndex.mockResolvedValue([windowIndex("mycmux-w2", true)]);
    await render();
    await show("claude");
    await click(S.accountManagement);
    expect(mocks.getWindowFragments).not.toHaveBeenCalled();
    expect(mocks.getWindowTabIndex).toHaveBeenCalledOnce();
    expect(mocks.emitTo).toHaveBeenCalledExactlyOnceWith(
      { kind: "Webview", label: "mycmux-w2" }, "mycmux://open-dashboard", {
      accountProvider: "claude", sourceWindow: mocks.window, targetWindow: "mycmux-w2",
      publicationId: "fixture-generation", subscriptionId: "fixture-listener",
      requestId: expect.any(String), expiresAt: expect.any(Number),
    },
    );
  });

  it("retries a failed window index once and sends to exactly one ready window", async () => {
    mocks.window = "mycmux-w1";
    mocks.getAllWindows.mockResolvedValue([{ label: mocks.window }, { label: "mycmux-w2" }]);
    mocks.getWindowTabIndex.mockRejectedValueOnce(new Error("fixture index unavailable"))
      .mockResolvedValue([windowIndex("mycmux-w2", true)]);
    await render();
    await show("claude");
    await click(S.accountManagement);
    expect(mocks.getWindowTabIndex).toHaveBeenCalledTimes(2);
    expect(mocks.getAllWindows).toHaveBeenCalledOnce();
    expect(mocks.emitTo).toHaveBeenCalledExactlyOnceWith(
      { kind: "Webview", label: "mycmux-w2" }, "mycmux://open-dashboard", {
      accountProvider: "claude", sourceWindow: mocks.window, targetWindow: "mycmux-w2",
      publicationId: "fixture-generation", subscriptionId: "fixture-listener",
      requestId: expect.any(String), expiresAt: expect.any(Number),
    },
    );
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it.each(["windows", "index"] as const)("shows an error after two failures reading %s", async list => {
    mocks.window = "mycmux-w1";
    const read = list === "windows" ? mocks.getAllWindows : mocks.getWindowTabIndex;
    const error = new Error("fixture list unavailable");
    read.mockRejectedValueOnce(error).mockRejectedValueOnce(error);
    await render();
    await show("claude");
    await click(S.accountManagement);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(S.accountManagementFailed);
    expect(read).toHaveBeenCalledTimes(2);
    expect(mocks.emitTo).not.toHaveBeenCalled();
    expect(mocks.focusWindow).not.toHaveBeenCalled();
    expect(mocks.ui.requestSettingsTab).not.toHaveBeenCalled();
  });

  it("keeps an explicit choice through management visits and another account's save", async () => {
    mocks.list.mockResolvedValue({ profiles: [claude, { ...claude, id: "other", label: "Other fixture" }] });
    mocks.tokens.mockResolvedValue([token]);
    await render();
    await show("claude");
    await click(claude.label);
    await click(S.accountManagement);
    await click(S.accountManagement);
    mocks.tokens.mockResolvedValue([token, { ...token, profile_id: "other" }]);
    await changed();
    expect(button(claude.label).getAttribute("aria-pressed")).toBe("true");
    expect(button("Other fixture").getAttribute("aria-pressed")).toBe("false");
    await click(S.launchButton);
    expect(mocks.layout.addTabToPaneWithOptions.mock.calls[0][2].launchEnv.MYCMUX_LAUNCH_ACCOUNT).toBe(claude.id);
  });

  it("reads saved choices after a tab switch and move without delivering a selection", async () => {
    await render("A");
    await show("claude");
    await click(S.accountManagement);
    await render("B");
    await show("claude");
    mocks.tokens.mockResolvedValue([token]);
    await changed();
    expect(button(claude.label).getAttribute("aria-pressed")).toBe("false");
    await render("A", "right");
    await show("claude");
    expect(button(claude.label).getAttribute("aria-pressed")).toBe("false");
    expect(button(S.specDefault).getAttribute("aria-pressed")).toBe("true");
  });

  it("rereads a visible account list even when another tab owns focus", async () => {
    await render("visible", "left", false);
    await show("claude");
    expect(button(S.accountManagement)).toBeDefined();
    mocks.tokens.mockResolvedValue([token]);
    await changed();
    expect(button(claude.label).getAttribute("aria-pressed")).toBe("false");
    await render("visible", "left", true);
    expect(button(claude.label).disabled).toBe(false);
  });

  it("disables an open Claude chip at expiry and refuses the previous selection", async () => {
    vi.useFakeTimers();
    mocks.tokens.mockResolvedValue([{ ...token, expires_at: new Date(Date.now() + 1000).toISOString() }]);
    await render();
    await show("claude");
    await click(claude.label);
    await act(async () => vi.advanceTimersByTimeAsync(1001));
    expect(button(claude.label).disabled).toBe(true);
    await click(S.launchButton);
    expect(mocks.layout.addTabToPaneWithOptions).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("期限切れ");
  });
});

it("shows a saved Claude choice in two visible launchers without moving focus or selecting it", async () => {
  const added = { ...claude, id: "claude-new", label: "New account" };
  mocks.list.mockResolvedValue({ profiles: [claude, added] });
  mocks.tokens.mockResolvedValue([token]);
  await act(async () => root.render(<>
    <div data-fixture-pane="first"><LauncherPane workspaceId="ws" paneId="first" tabId="one" sessionId="one" isActive /></div>
    <div data-fixture-pane="second"><LauncherPane workspaceId="ws" paneId="second" tabId="two" sessionId="two" isActive={false} /></div>
  </>));
  const first = host.querySelector('[data-fixture-pane="first"]')!;
  const second = host.querySelector('[data-fixture-pane="second"]')!;
  const scoped = (pane: Element, label: string) => [...pane.querySelectorAll<HTMLButtonElement>("button")]
    .find(node => node.getAttribute("aria-label") === label || node.textContent === label)!;

  for (const pane of [first, second]) await act(async () => scoped(pane, S.specTooltip("Claude Code")).click());
  const firstChoice = scoped(first, claude.label);
  await act(async () => { firstChoice.click(); firstChoice.focus(); });
  mocks.tokens.mockResolvedValue([token, { ...token, profile_id: added.id }]);
  await changed();
  expect(document.activeElement).toBe(firstChoice);
  expect(firstChoice.getAttribute("aria-pressed")).toBe("true");
  expect(scoped(second, S.specDefault).getAttribute("aria-pressed")).toBe("true");
  for (const pane of [first, second]) expect(scoped(pane, added.label).getAttribute("aria-pressed")).toBe("false");
});

it.each(["opened", "refused"])("F3-09 ignores a matching %s response at the deadline before its timer runs", async reason => {
  mocks.window = "mycmux-w1";
  mocks.reply = null;
  mocks.getAllWindows.mockResolvedValue(["main", mocks.window, "mycmux-w2"].map(label => ({ label })));
  mocks.getWindowTabIndex.mockResolvedValue([windowIndex("main", true), windowIndex("mycmux-w2", true)]);
  await render();
  await show("claude");
  vi.useFakeTimers();
  const start = Date.now();
  await click(S.accountManagement);
  expect(mocks.emitTo).toHaveBeenCalledOnce();
  const request = mocks.emitTo.mock.calls[0][2];
  expect(request.expiresAt).toBe(start + ACCOUNT_MANAGEMENT_TIMEOUT_MS);

  vi.setSystemTime(request.expiresAt);
  await act(async () => {
    for (const notify of mocks.replies) {
      notify({ payload: { requestId: request.requestId, fromWindow: "main", reason } });
    }
  });
  expect(mocks.focusWindow).not.toHaveBeenCalled();
  expect(mocks.getAllWindows).toHaveBeenCalledOnce();
  expect(mocks.emitTo).toHaveBeenCalledOnce();
  expect(host.querySelector('[role="alert"]')).toBeNull();

  await act(async () => vi.advanceTimersByTimeAsync(ACCOUNT_MANAGEMENT_TIMEOUT_MS));
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(S.accountManagementFailed);
  expect(mocks.focusWindow).not.toHaveBeenCalled();
  expect(mocks.emitTo).toHaveBeenCalledOnce();
});

it("F3-11 keeps the latest successful press clear when the first press times out", async () => {
  mocks.window = "mycmux-w1";
  await render();
  await show("claude");
  vi.useFakeTimers();

  mocks.reply = null;
  await click(S.accountManagement);
  expect(mocks.emitTo).toHaveBeenCalledOnce();
  expect(mocks.focusWindow).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(1));

  mocks.reply = "opened";
  await click(S.accountManagement);
  expect(mocks.emitTo).toHaveBeenCalledTimes(2);
  expect(mocks.focusWindow).toHaveBeenCalledOnce();
  expect(host.querySelector('[role="alert"]')).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(ACCOUNT_MANAGEMENT_TIMEOUT_MS - 1));
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(mocks.focusWindow).toHaveBeenCalledOnce();
});

it("F3-02 opens locally once if settings become available before focus rejects a replaced destination", async () => {
  mocks.window = "mycmux-w1";
  const child = "mycmux-w2";
  mocks.getAllWindows.mockResolvedValue([mocks.window, child].map(label => ({ label })));
  mocks.getWindowTabIndex.mockResolvedValue([windowIndex(child, true)]);
  mocks.focusWindow.mockImplementationOnce(async () => {
    stopSettings();
    stopSettings = registerAccountManagementSettings();
    throw "window_generation_mismatch";
  });
  await render();
  await show("claude");
  await click(S.accountManagement);
  expect(mocks.ui.requestSettingsTab).toHaveBeenCalledExactlyOnceWith("usage", "claude");
  expect(mocks.focusWindow).toHaveBeenCalledExactlyOnceWith(child, { accountManagementSubscription: fixtureSubscription });
  expect(mocks.emitTo).toHaveBeenCalledOnce();
  expect(mocks.getAllWindows).toHaveBeenCalledOnce();
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
