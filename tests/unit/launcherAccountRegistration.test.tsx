// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(), tokens: vi.fn(), homes: vi.fn(), begin: vi.fn(), cancel: vi.fn(), home: vi.fn(),
  accountState: { profiles: [], loading: false, fetch: vi.fn(async () => {}) },
  settings: { launcherHiddenIds: [], crsmShowClaude: true, crsmShowCodex: true, crsmShowClaudeCodex: true, hideSessionsWithoutUserMessages: true },
  dirs: { view: null, load: async () => {} },
  layout: { addTabToPaneWithOptions: vi.fn(), addWebTabToPane: vi.fn(), removeTabFromPane: vi.fn() },
  ui: { setActivePaneId: vi.fn(), requestSettingsTab: vi.fn() },
}));
vi.mock("../../src/lib/ipc", () => ({
  CLI_LOGIN_TIMEOUT_MS: 600000, crsmListSessions: async () => [], launcherRecordDirMru: async () => {},
  listCliAccounts: mocks.list, getCliLaunchTokens: mocks.tokens, listCliAccountHomes: mocks.homes,
  startClaudeSetupToken: mocks.begin, getClaudeSetupTokenState: async () => null,
  onClaudeSetupToken: async () => () => {}, cancelClaudeSetupToken: mocks.cancel, submitClaudeSetupCode: async () => {},
}));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
vi.mock("../../src/stores/settingsStore", () => ({ useSettingsStore: (select: (s: typeof mocks.settings) => unknown) => select(mocks.settings) }));
vi.mock("../../src/stores/launcherDirsStore", () => ({ useLauncherDirsStore: (select: (s: typeof mocks.dirs) => unknown) => select(mocks.dirs) }));
vi.mock("../../src/stores/workspaceLayoutStore", () => ({ useWorkspaceLayoutStore: (select: (s: typeof mocks.layout) => unknown) => select(mocks.layout) }));
vi.mock("../../src/stores/uiStore", () => ({ useUiStore: Object.assign((select: (s: typeof mocks.ui) => unknown) => select(mocks.ui), { getState: () => mocks.ui, subscribe: () => () => {} }) }));
vi.mock("../../src/stores/cliAccountStore", () => ({ useCliAccountStore: Object.assign((select: (s: typeof mocks.accountState) => unknown) => select(mocks.accountState), { getState: () => mocks.accountState }) }));
vi.mock("../../src/stores/cliLoginStore", async () => {
  const { create } = await import("zustand");
  return { useCliLoginStore: create(() => ({ byProvider: { claude: null, codex: null, grok: null }, startAccountHome: mocks.home })) };
});

vi.mock("../../src/lib/claudeCodexModels", () => ({ useLaunchModels: () => [] }));

import LauncherPane from "../../src/components/workspace/LauncherPane";
import { useCliLoginStore } from "../../src/stores/cliLoginStore";
import type { ClaudeSetupTokenEvent } from "../../src/lib/ipc";
import type { CliLoginEntry } from "../../src/stores/cliLoginStore";
import { useClaudeSetupTokenStore } from "../../src/stores/claudeSetupTokenStore";
import { launcherStrings as L } from "../../src/components/workspace/launcherStrings";
import { setupTokenStrings as S } from "../../src/components/layout/tabAccountStrings";
import { getCatalogEntry } from "../../src/lib/agentCatalog";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView = () => {};
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue({ profiles: ["claude", "codex", "grok"].map(provider => ({ id: provider + "-missing", provider, label: provider + " fixture" })) });
  mocks.tokens.mockResolvedValue([]); mocks.homes.mockResolvedValue([]);
  mocks.begin.mockResolvedValue({ login_id: "fixture-login", profile_id: "claude-missing", state: "starting" });
  mocks.home.mockResolvedValue(undefined); mocks.cancel.mockResolvedValue(undefined);
  useCliLoginStore.setState({ byProvider: { claude: null, codex: null, grok: null } });
  useClaudeSetupTokenStore.setState({ registrationOrigins: { claude: null, codex: null, grok: null }, completionOrigin: null, resultFocus: null, homeStartPending: { claude: false, codex: false, grok: false }, completedLoginIds: [] });
  useClaudeSetupTokenStore.setState({ event: null, endedEvents: [], retiredLoginIds: [], pendingProfileId: null, failure: null, failureProfileId: null });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const buttons = () => [...host.querySelectorAll<HTMLButtonElement>("button")];
const button = (label: string) => buttons().find(b => b.textContent === label || b.getAttribute("aria-label") === label)!;
async function key(value: string, shiftKey = false, target: EventTarget = document.activeElement ?? document) {
  await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true })); });
}
async function openByKeyboard(provider: string) {
  await act(async () => root.render(<LauncherPane workspaceId="ws" paneId="pane" tabId="tab" sessionId="session" isActive />));
  const label = getCatalogEntry(provider)!.label;
  for (let attempt = 0; attempt < 20; attempt++) {
    await key("Enter", true);
    const spec = host.querySelector("[data-launcher-spec]");
    if (spec?.firstElementChild?.textContent === label) return;
    await key("Escape"); await key("ArrowDown");
  }
  throw new Error("could not open provider with keys");
}
describe("launcher account registration keyboard and focus boundary", () => {
  it("opens Claude registration with only keys, focuses Begin, and blocks launcher Enter while focus is outside the flow", async () => {
    await openByKeyboard("claude");
    await key("ArrowRight");
    expect(button("claude fixture").getAttribute("aria-pressed")).toBe("false");
    await key("Enter");
    expect(button(S.begin)).toBeDefined();
    expect(document.activeElement).toBe(button(S.begin));
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(mocks.layout.addTabToPaneWithOptions).not.toHaveBeenCalled();
    document.body.focus(); button(S.begin).blur();
    await key("Enter", false, document.body);
    expect(mocks.layout.addTabToPaneWithOptions).not.toHaveBeenCalled();
    await act(async () => button(S.begin).click());
    await key("Enter", false, document.body);
    expect(mocks.layout.addTabToPaneWithOptions).not.toHaveBeenCalled();
    expect(mocks.begin).toHaveBeenCalledExactlyOnceWith("claude-missing");
  });
  it.each(["codex", "grok"])("opens unavailable %s registration with keys without launching the default account", async provider => {
    await openByKeyboard(provider);
    await key("ArrowRight"); await key("Enter");
    expect(mocks.home).toHaveBeenCalledExactlyOnceWith(provider, provider + "-missing");
    await key("Enter", false, document.body);
    expect(mocks.layout.addTabToPaneWithOptions).not.toHaveBeenCalled();
  });
  it("moves mouse-triggered Claude confirmation focus to Begin and guards Enter after focus is lost", async () => {
    await openByKeyboard("claude");
    await act(async () => { button(S.useInTab).focus(); button(S.useInTab).click(); });
    expect(document.activeElement).toBe(button(S.begin));
    button(S.begin).blur(); await key("Enter", false, document.body);
    expect(mocks.layout.addTabToPaneWithOptions).not.toHaveBeenCalled();
  });
});

const search = () => host.querySelector<HTMLInputElement>("input[aria-label='" + L.searchPlaceholder + "']")!;
const loginEntry = (mode: "add" | "reauth", profileId?: string): CliLoginEntry => ({
  stage: "waiting", loginId: "global-fixture", mode, startedAt: 1, sessionId: "login-session", tabId: "login-tab",
  ...(profileId ? { purpose: { kind: "account_home" as const, profile_id: profileId } } : {}),
});
async function emitSetup(state: ClaudeSetupTokenEvent["state"]) {
  await act(async () => useClaudeSetupTokenStore.getState().handleEvent({
    login_id: "fixture-login", profile_id: "claude-missing", state,
  }));
}
async function activateFocused() {
  const node = document.activeElement as HTMLElement;
  await key("Enter", false, node);
  // jsdom does not supply a browser's default keyboard activation.
  if (node instanceof HTMLButtonElement) await act(async () => node.click());
}
describe("registration completion and unrelated global logins", () => {
  it.each(["claude", "codex", "grok"] as const)("keeps every %s launch control working during global add and reauth", async provider => {
    await openByKeyboard(provider);
    for (const mode of ["add", "reauth"] as const) {
      await act(async () => useCliLoginStore.setState({ byProvider: {
        claude: null, codex: null, grok: null, [provider]: loginEntry(mode),
      } }));
      expect(button(S.useInTab).disabled).toBe(true);
      const modelInput = host.querySelector<HTMLInputElement>("input[aria-label='" + L.modelLabel + "']")!;
      for (const method of ["details", "model", "button"]) {
        mocks.layout.addTabToPaneWithOptions.mockClear();
        if (method === "button") await act(async () => button(L.launchButton).click());
        else {
          const input = method === "model" ? modelInput : search();
          await act(async () => input.focus()); await key("Enter", false, input);
        }
        expect(mocks.layout.addTabToPaneWithOptions, mode + "/" + method).toHaveBeenCalledTimes(1);
      }
    }
  });
  it.each(["dismissed", "failed", "cancelled", "timeout"] as const)("restores the registration button after %s and allows Enter and Launch", async outcome => {
    await openByKeyboard("claude"); await key("ArrowRight"); await key("Enter");
    if (outcome !== "dismissed") {
      await act(async () => button(S.begin).click()); await emitSetup(outcome);
    }
    await act(async () => button(S.dismiss).click());
    expect(document.activeElement).toBe(button(S.useInTab));
    mocks.layout.addTabToPaneWithOptions.mockClear();
    await act(async () => button(L.launchButton).click());
    expect(mocks.layout.addTabToPaneWithOptions).toHaveBeenCalledTimes(1);
    mocks.layout.addTabToPaneWithOptions.mockClear();
    await act(async () => search().focus()); await key("Tab"); await key("Enter");
    expect(mocks.layout.addTabToPaneWithOptions).toHaveBeenCalledTimes(1);
  });
  it("selects the saved account, restores the launcher input, and launches that account with Enter and Launch", async () => {
    await openByKeyboard("claude"); await key("ArrowRight"); await key("Enter");
    await act(async () => button(S.begin).click());
    mocks.tokens.mockResolvedValue([{ profile_id: "claude-missing", expires_at: "2099-01-01", owner_check: "verified" }]);
    await emitSetup("saved");
    expect(button("claude fixture").getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(search());
    await key("Enter");
    expect(mocks.layout.addTabToPaneWithOptions).toHaveBeenCalledWith("ws", "pane",
      expect.objectContaining({ launchEnv: expect.objectContaining({ MYCMUX_LAUNCH_ACCOUNT: "claude-missing" }) }));
    mocks.layout.addTabToPaneWithOptions.mockClear();
    await act(async () => button(L.launchButton).click());
    expect(mocks.layout.addTabToPaneWithOptions).toHaveBeenCalledWith("ws", "pane",
      expect.objectContaining({ launchEnv: expect.objectContaining({ MYCMUX_LAUNCH_ACCOUNT: "claude-missing" }) }));
  });
  it.each(["codex", "grok"] as const)("blocks launching while this row's %s home login is still running", async provider => {
    mocks.home.mockImplementation(async () => useCliLoginStore.setState({ byProvider: {
      claude: null, codex: null, grok: null, [provider]: loginEntry("reauth", provider + "-missing"),
    } }));
    await openByKeyboard(provider); await key("ArrowRight"); await key("Enter");
    await act(async () => button(L.launchButton).click());
    expect(mocks.layout.addTabToPaneWithOptions).not.toHaveBeenCalled();
    await act(async () => useCliLoginStore.setState({ byProvider: { claude: null, codex: null, grok: null } }));
    await act(async () => button(L.launchButton).click());
    expect(mocks.layout.addTabToPaneWithOptions).toHaveBeenCalledTimes(1);
  });
  it("moves back to and selects the default account after visiting an unavailable account", async () => {
    mocks.list.mockResolvedValue({ profiles: [
      { id: "claude-ready", provider: "claude", label: "Ready fixture" },
      { id: "claude-missing", provider: "claude", label: "Missing fixture" },
    ] });
    mocks.tokens.mockResolvedValue([{ profile_id: "claude-ready", expires_at: "2099-01-01", owner_check: "verified" }]);
    await openByKeyboard("claude"); await key("ArrowRight");
    expect(button("Ready fixture").getAttribute("aria-pressed")).toBe("true");
    await key("ArrowRight");
    expect(button("Missing fixture").getAttribute("aria-current")).toBe("true");
    await key("ArrowRight");
    const defaults = buttons().filter(b => b.textContent === L.specDefault);
    expect(defaults[0].getAttribute("aria-pressed")).toBe("true");
    expect(button("Ready fixture").getAttribute("aria-pressed")).toBe("false");
    await key("Enter");
    expect(mocks.layout.addTabToPaneWithOptions).toHaveBeenCalledWith("ws", "pane",
      expect.objectContaining({ launchEnv: expect.not.objectContaining({ MYCMUX_LAUNCH_ACCOUNT: "claude-ready" }) }));
  });
  it("keeps keyboard focus inside the launcher flow from Begin through code to Cancel", async () => {
    await openByKeyboard("claude"); await key("ArrowRight"); await key("Enter"); await activateFocused();
    const flow = host.querySelector<HTMLElement>("[data-claude-setup-token]")!;
    expect(flow.tabIndex).toBe(-1); expect(document.activeElement).toBe(flow);
    await emitSetup("code_available");
    const code = host.querySelector<HTMLInputElement>("input[aria-label='" + S.codeLabel + "']")!;
    expect(document.activeElement).toBe(code);
    await key("Tab"); expect(document.activeElement).toBe(button(S.sendCode));
    await key("Tab"); expect(document.activeElement).toBe(button(S.cancel));
    await activateFocused();
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith("fixture-login");
    expect(mocks.layout.addTabToPaneWithOptions).not.toHaveBeenCalled();
  });
});

import * as setupIpc from "../../src/lib/ipc";

describe("launcher setup-token retry and result focus", () => {
  it("shows the launcher's code field and URL when the same account retries after timeout", async () => {
    await openByKeyboard("claude"); await key("ArrowRight"); await key("Enter");
    await activateFocused(); await emitSetup("timeout");
    await act(async () => button(S.dismiss).click());
    const previous: ClaudeSetupTokenEvent = { login_id: "fixture-login", profile_id: "claude-missing", state: "timeout" };
    const current = vi.spyOn(setupIpc, "getClaudeSetupTokenState").mockResolvedValue(previous);
    try {
      mocks.begin.mockResolvedValue({ ...previous, login_id: "retry-login", state: "starting" });
      await act(async () => button(S.useInTab).click());
      await activateFocused();
      const url = "https://example.test/oauth/authorize?state=launcher-retry";
      await act(async () => useClaudeSetupTokenStore.getState().handleEvent({
        login_id: "retry-login", profile_id: "claude-missing", state: "code_available", url,
      }));
      const code = host.querySelector<HTMLInputElement>("input[aria-label='" + S.codeLabel + "']");
      expect(code).not.toBeNull();
      expect(document.activeElement).toBe(code);
      expect(host.textContent).toContain(url);
      expect(mocks.begin).toHaveBeenCalledTimes(2);
      expect(mocks.layout.addTabToPaneWithOptions).not.toHaveBeenCalled();
    } finally { current.mockRestore(); }
  });

  it("focuses the launcher's result dismissal when its code field times out", async () => {
    await openByKeyboard("claude"); await key("ArrowRight"); await key("Enter");
    await activateFocused(); await emitSetup("code_available");
    expect(document.activeElement).toBe(host.querySelector("input[aria-label='" + S.codeLabel + "']"));
    await emitSetup("timeout");
    expect(document.activeElement).toBe(button(S.dismiss));
    expect(mocks.layout.addTabToPaneWithOptions).not.toHaveBeenCalled();
  });
});
