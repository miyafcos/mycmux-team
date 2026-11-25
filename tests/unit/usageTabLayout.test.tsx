// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClaudeSetupTokenEvent, CliAccountProfile, CliAccountsSnapshot, CliLaunchTokenStatus, CliLoginSession, SwitchableCliProvider,
} from "../../src/lib/ipc";

import type { AccountListChange } from "../../src/lib/tabAccounts";
import { registerAccountManagementSettings } from "../../src/lib/mainDashboardRequests";

// 設定 → アカウント・使用量, rendered with the real stores. Only the Tauri
// boundary is mocked, so this checks how the pieces are put together.
const ipc = vi.hoisted(() => ({
  snapshot: null as unknown, capture: null as unknown, orphan: null as unknown,
  setupSnapshot: null as ClaudeSetupTokenEvent | null, setupStart: null as ClaudeSetupTokenEvent | null,
  tokens: [] as CliLaunchTokenStatus[], homeLogin: null as CliLoginSession | null,
  listListeners: new Set<(event?: { payload: AccountListChange }) => void>(),
}));
vi.mock("../../src/lib/appConfirmation", () => ({ cancelAppConfirmations: vi.fn(() => false), confirm: vi.fn(async () => false) }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn(async () => {}) }));
vi.mock("../../src/components/layout/WindowControls", () => ({ WindowControls: () => null }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "C:\\Users\\test") }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, notify: (event?: { payload: AccountListChange }) => void) => {
    if (name === "tab-account-evidence-updated") ipc.listListeners.add(notify);
    return () => { ipc.listListeners.delete(notify); };
  }),
  emit: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === "list_cli_accounts") return structuredClone(ipc.snapshot);
    if (command === "capture_cli_account") return ipc.capture;
    if (command === "resolve_cli_account_orphan") return ipc.orphan;
    if (command === "get_cli_launch_tokens") return ipc.tokens;
    if (command === "list_cli_account_homes" || command === "crsm_list_sessions") return [];
    if (command === "get_claude_setup_token_state") return ipc.setupSnapshot;
    if (command === "start_claude_setup_token") return ipc.setupStart;
    if (command === "begin_cli_login") return ipc.homeLogin;
    return null;
  }),
  Channel: class {},
}));

import { UsageTab } from "../../src/components/settings/tabs/UsageTab";
import { useAccountAutoSwitchStore } from "../../src/stores/accountAutoSwitchStore";
import { __resetCliAccountStoreForTests, useCliAccountStore } from "../../src/stores/cliAccountStore";
import { useCliLoginStore } from "../../src/stores/cliLoginStore";
import { useClaudeSetupTokenStore } from "../../src/stores/claudeSetupTokenStore";
import { OVERLAY_EXIT_MS } from "../../src/hooks/useDeferredUnmount";
import { __resetUsageStoreForTests, useUsageStore } from "../../src/stores/usageStore";
import SettingsDialog from "../../src/components/settings/SettingsDialog";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import { useUiStore } from "../../src/stores/uiStore";
import { __resetToastStoreForTests, useToastStore } from "../../src/stores/toastStore";
import LauncherPane from "../../src/components/workspace/LauncherPane";
import AgentSelector from "../../src/components/setup/AgentSelector";
import TitleBar from "../../src/components/layout/TitleBar";
import { launcherStrings } from "../../src/components/workspace/launcherStrings";
import { geminiSignedOut } from "./fixtures/geminiSignedOut";

function profile(id: string, provider: SwitchableCliProvider): CliAccountProfile {
  return { id, provider, label: `label-${id}`, email: `${id}@example.test`, identity_key: id, plan: null,
    org_name: null, captured_at: "2026-09-01T00:00:00Z", last_switched_at: null, needs_relogin: false };
}

function snapshot(): CliAccountsSnapshot {
  return {
    profiles: [profile("a", "claude"), profile("b", "claude"), profile("c", "claude"), profile("x", "codex")],
    live: [
      { provider: "claude", present: true, email: "a@example.test", identity_key: "a", matched_profile_id: "a", plan: null, org_name: null, error: null },
      { provider: "codex", present: true, email: "x@example.test", identity_key: "x", matched_profile_id: "x", plan: null, org_name: null, error: null },
      { provider: "grok", present: false, email: null, identity_key: null, matched_profile_id: null, plan: null, org_name: null, error: null },
    ],
    active: { claude: "a", codex: "x", grok: null },
    orphans: [],
    backup_root: "C:\\backup",
    generated_at: "2026-09-25T00:00:00Z",
  };
}

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = () => {};
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  __resetToastStoreForTests();
  useUiStore.getState().clearRequestedSettingsTab();
  ipc.snapshot = snapshot();
  ipc.capture = null;
  ipc.orphan = null;
  ipc.setupSnapshot = null;
  ipc.setupStart = null;
  ipc.homeLogin = null;
  ipc.tokens = [];
  useClaudeSetupTokenStore.setState({
    event: null, retiredLoginIds: [], pendingProfileId: null, codeSubmission: null,
    failure: null, failureProfileId: null, browserOpenFailed: false,
  });
  __resetUsageStoreForTests();
  __resetCliAccountStoreForTests();
  localStorage.clear();
  useAccountAutoSwitchStore.setState({ enabled: { claude: false, codex: false, grok: false },
    excludedTargets: { claude: [], codex: [], grok: [] }, attempts: {}, status: {} });
  useCliLoginStore.setState({ byProvider: { claude: null, codex: null, grok: null } });
  useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null, lastActivePaneByWorkspace: {} });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<UsageTab />);
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function block(title: string): HTMLElement {
  const found = host.querySelector<HTMLElement>(`section[aria-label="${title}"]`);
  if (!found) throw new Error(`no block for ${title}`);
  return found;
}

describe("L12b account management", () => {
  it("retains a Gemini login action for the actual signed-out usage row", async () => {
    await act(async () => useUsageStore.setState({ accounts: [geminiSignedOut] }));
    const gemini = block("Gemini");
    expect([...gemini.querySelectorAll("button")].some(button => button.textContent === "ログイン")).toBe(true);
    await act(async () => useUsageStore.setState({ accounts: [] }));
  });

  it("rereads the visible Grok list when live sync notifies after saving", async () => {
    const pending = snapshot();
    pending.live[2] = { ...pending.live[2], present: true, identity_key: "grok-owner" };
    ipc.snapshot = pending;
    vi.useFakeTimers();
    try {
      await act(async () => useCliAccountStore.getState().fetch());
      ipc.snapshot = {
        ...pending, profiles: [...pending.profiles, profile("grok-owner", "grok")],
        live: pending.live.map(login => login.provider === "grok" ? { ...login, matched_profile_id: "grok-owner" } : login),
      };
      await act(async () => { for (const notify of ipc.listListeners) notify(); });
      expect(block("Grok Build").textContent).toContain("label-grok-owner");
    } finally { vi.useRealTimers(); }
  });
});

describe("account management controls", () => {
  it("guides an unidentified Grok login without polling its account list", async () => {
    const pending = snapshot();
    pending.live[2] = { ...pending.live[2], present: true, identity_key: null };
    ipc.snapshot = pending;
    await act(async () => useCliAccountStore.getState().fetch());
    expect(block("Grok Build").textContent).toContain("Grok でログインし直してください");
    const reads = vi.mocked(invoke).mock.calls.filter(([command]) => command === "list_cli_accounts").length;
    vi.useFakeTimers();
    try {
      await act(async () => vi.advanceTimersByTimeAsync(6500));
      expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "list_cli_accounts")).toHaveLength(reads);
    } finally { vi.useRealTimers(); }
  });

  it.each([false, true])("offers tab registration only after a new capture (%s)", async isNew => {
    const added = profile(isNew ? "new-account" : "a", "claude");
    const next = snapshot();
    if (isNew) next.profiles.push(added);
    ipc.snapshot = next;
    ipc.capture = added;
    const capture = [...block("Claude Code").querySelectorAll("button")].find(button => button.textContent === "現在のログインを登録/更新")!;
    await act(async () => capture.click());
    const row = host.querySelector(`[data-cli-account-row="${added.id}"]`)!;
    expect(row.textContent?.includes("このアカウントをタブ用にも登録")).toBe(isNew);
  });

  it("offers to register a newly imported saved account for tabs", async () => {
    const added = profile("from-saved", "claude");
    const before = snapshot();
    before.orphans = [{ id: "orphan-fixture", provider: "claude", email: "saved@example.test",
      identity_key: "saved", captured_at: null, plan: null, org_name: null, needs_relogin: false, error: null }];
    ipc.snapshot = before;
    await act(async () => useCliAccountStore.getState().fetch());
    const register = [...host.querySelectorAll("button")].find(button => button.textContent === "登録する")!;
    ipc.snapshot = { ...before, profiles: [...before.profiles, added], orphans: [] };
    ipc.orphan = added;
    await act(async () => register.click());
    expect(host.querySelector('[data-cli-account-row="from-saved"]')?.textContent).toContain("このアカウントをタブ用にも登録");
  });

  it("opens an agy tab and calls close after creation succeeds", async () => {
    useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null });
    const onLoginOpened = vi.fn();
    await act(async () => root.render(<UsageTab onLoginOpened={onLoginOpened} />));
    await act(async () => useUsageStore.setState({ accounts: [geminiSignedOut] }));
    const login = [...block("Gemini").querySelectorAll("button")].find(button => button.textContent === "ログイン")!;
    await act(async () => login.click());
    expect(onLoginOpened).toHaveBeenCalledOnce();
    const pane = useWorkspaceListStore.getState().workspaces[0].panes[0];
    expect(pane.tabs.find(tab => tab.id === pane.activeTabId)?.launchEnv).toEqual({ MYCMUX_LAUNCH_TARGET: "agy" });
  });

  it("reopens the requested provider even after another settings item is displayed", async () => {
    const render = async (provider: SwitchableCliProvider) => act(async () => root.render(
      <SettingsDialog initialTab="usage" accountSection={{ provider }} onClose={() => {}} onOpenOnlinePanel={() => {}} />,
    ));
    await render("claude");
    const appearance = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "外観")!;
    expect(appearance).toBeDefined();
    await act(async () => appearance.click());
    expect(document.querySelector('[data-account-provider="grok"]')).toBeNull();
    await render("grok");
    expect(document.activeElement).toBe(document.querySelector('[data-account-provider="grok"]'));
  });
});

describe("アカウント・使用量 tab", () => {
  it("keeps each provider's switch, candidates and accounts in one block", () => {
    const claude = block("Claude Code");
    expect(claude.querySelectorAll('input[role="switch"]')).toHaveLength(1);
    const ticks = claude.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:not([role="switch"])');
    // The address keeps two accounts renamed alike apart for a screen reader.
    expect([...ticks].map((tick) => tick.getAttribute("aria-label"))).toEqual([
      "「label-a」(a@example.test) を自動切り替えの候補にする",
      "「label-b」(b@example.test) を自動切り替えの候補にする",
      "「label-c」(c@example.test) を自動切り替えの候補にする",
    ]);
    expect(claude.querySelector('button[aria-label="Claude Code のアカウントを追加"]')?.textContent).toBe("+ アカウントを追加");

    // One account: nowhere to switch to. None: nothing to list either.
    const codexSwitch = block("Codex").querySelector<HTMLInputElement>('input[role="switch"]');
    expect(codexSwitch?.disabled).toBe(true);
    expect(block("Codex").textContent).toContain("アカウントを 2 つ以上登録すると使えます。");
    expect(block("Grok Build").textContent).toContain("登録済みアカウントはありません");

    // The old stand-alone section is gone; its caveat lives in the intro.
    expect(host.textContent).not.toContain("アカウントの自動切り替え");
    expect(host.textContent).toContain("新しく起動するセッションから反映");
  });

  it("shows Gemini quota and one-account help without adding a switching control", async () => {
    const toggles = host.querySelectorAll('input[role="switch"]').length;
    await act(async () => useUsageStore.setState({ accounts: [{
      profile_id: "live:gemini", provider: "gemini", label: "Gemini", email: "agy@example.test", plan: null,
      registered: false, is_active: false, needs_relogin: false, state: "ok",
      five_hour: null, seven_day: null, seven_day_sonnet: null, seven_day_opus: null,
      model_windows: [{ key: "Pro", window: { pct: 25, resets_at: "" } }],
      error_code: null, retry_at: null, fetched_at: "2026-11-18T15:00:00Z",
    }] }));
    expect(host.querySelector("table")?.textContent).toContain("Gemini");
    expect(host.querySelector("table")?.textContent).toContain("agy@example.test");
    const quota = [...host.querySelectorAll("table span")].find((span) => span.textContent?.startsWith("Pro "));
    expect(quota?.textContent).toBe("Pro 25%");
    const gemini = block("Gemini");
    expect([...gemini.querySelectorAll("button")].some(button => button.textContent === "ログイン")).toBe(false);
    await act(async () => gemini.querySelector("button")!.click());
    expect(gemini.textContent).toContain("Gemini は 1 つのアカウントだけ使えます。切り替えは agy でログインし直します");
    expect(host.querySelectorAll('input[role="switch"]')).toHaveLength(toggles);
    await act(async () => useUsageStore.setState({ accounts: [] }));
  });

  it("changes only the ticked provider's candidates", async () => {
    const tick = block("Claude Code").querySelectorAll<HTMLInputElement>('input[type="checkbox"]:not([role="switch"])')[1];
    await act(async () => tick.click());
    expect(useAccountAutoSwitchStore.getState().excludedTargets).toEqual({ claude: ["b"], codex: [], grok: [] });
  });

  it("gives every candidate tick its own name, even for look-alike accounts", async () => {
    const twin = (id: string) => ({ ...profile(id, "claude"), label: "仕事用", email: null });
    const next = snapshot();
    next.profiles = [profile("a", "claude"), twin("t1"), twin("t2")];
    ipc.snapshot = next;
    await act(async () => useCliAccountStore.getState().fetch());
    const names = [...block("Claude Code").querySelectorAll('input[type="checkbox"]:not([role="switch"])')]
      .map((tick) => tick.getAttribute("aria-label"));
    expect(names).toEqual([
      "「label-a」(a@example.test) を自動切り替えの候補にする",
      "「仕事用」(2 件目) を自動切り替えの候補にする",
      "「仕事用」(3 件目) を自動切り替えの候補にする",
    ]);
  });

  it("keeps the in-use tag while that account is being renamed", async () => {
    const row = host.querySelector<HTMLElement>('[data-cli-account-row="a"]');
    expect(row?.textContent).toContain("使用中");
    const rename = [...row!.querySelectorAll("button")].find((button) => button.textContent === "名前");
    await act(async () => rename?.click());
    expect(row!.querySelector("input:not([type])")).not.toBeNull();
    expect(row!.textContent).toContain("使用中");
  });

  it("puts every piece of text on the settings type scale", async () => {
    // The complaint this guards: the auto-switch labels carried no size and
    // fell through to the browser's 16px while the rest of the dialog is 12px.
    // A login in progress is included: its line and 中止 button live here too.
    await act(async () => {
      useCliLoginStore.setState({ byProvider: { claude: { stage: "waiting", loginId: "login-1", mode: "new",
        startedAt: Date.now(), sessionId: null, tabId: null }, codex: null, grok: null } });
    });
    expect(block("Claude Code").textContent).toContain("中止");
    const allowed = new Set(["12px", "var(--cmux-font-size-xs)"]);
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    const offenders: string[] = [];
    let checked = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim();
      if (!text) continue;
      checked += 1;
      let element: HTMLElement | null = node.parentElement;
      let size = "";
      while (element && element !== host) {
        size = element.style.fontSize;
        if (size && size !== "inherit") break;
        element = element.parentElement;
      }
      if (!element || element === host || !allowed.has(size)) offenders.push(`${text.slice(0, 20)} -> ${size || "(unsized)"}`);
    }
    expect(checked).toBeGreaterThan(40);
    expect(offenders).toEqual([]);
  });
});

describe("L12b round 2 settings and the launch fields", () => {
  function button(label: string, scope: ParentNode = document): HTMLButtonElement {
    const match = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(button =>
      button.textContent === label || button.getAttribute("aria-label") === label);
    expect(match, label).toBeDefined();
    return match!;
  }

  const launcher = <LauncherPane workspaceId="fixture" paneId="pane" tabId="tab" sessionId="session" isActive />;
  function LauncherWithSettings() {
    useLayoutEffect(registerAccountManagementSettings, []);
    const request = useUiStore(state => state.requestedAccountProvider);
    return <>
      {launcher}
      {request && <SettingsDialog initialTab="usage" accountSection={{ provider: request }}
        onClose={() => useUiStore.getState().clearRequestedSettingsTab()} onOpenOnlinePanel={() => {}} />}
    </>;
  }
  async function press(target: EventTarget, key: string) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    await act(async () => {
      // jsdom lacks the browser's default Enter button activation.
      if (target.dispatchEvent(event) && key === "Enter" && target instanceof HTMLButtonElement) target.click();
    });
    return event;
  }
  const providerCases = [
    { provider: "claude", name: "Claude Code", id: "a" },
    { provider: "codex", name: "Codex", id: "x" },
    { provider: "grok", name: "Grok Build", id: "grok-fixture" },
  ] as const;
  const registrationCases = providerCases.flatMap(entry => ["pointer", "keyboard"].map(entryPoint => ({ ...entry, entryPoint })));

  it.each(registrationCases)("leaves Enter on the $provider registration button to settings opened by $entryPoint", async ({ provider, name, id, entryPoint }) => {
    const accounts = snapshot();
    accounts.profiles.push(profile("grok-fixture", "grok"));
    ipc.snapshot = accounts;
    if (provider !== "claude") ipc.homeLogin = {
      login_id: "home-fixture", provider, command: "", args: [], env: {}, staging_dir: "",
    };
    const add = vi.spyOn(useWorkspaceLayoutStore.getState(), "addTabToPaneWithOptions");
    try {
      await act(async () => root.render(<LauncherWithSettings />));
      await act(async () => button(launcherStrings.specTooltip(name)).click());
      if (entryPoint === "keyboard") {
        await press(document, "ArrowRight");
        await press(document, "Enter");
      } else {
        await act(async () => button(launcherStrings.accountManagement).click());
      }
      const register = button("タブ用に登録", document.querySelector(`[data-cli-account-row="${id}"]`)!);
      await act(async () => register.focus());
      const enter = await press(register, "Enter");
      expect(enter.defaultPrevented).toBe(false);
      expect(add.mock.calls.filter(call => call[2]?.launchEnv?.MYCMUX_LAUNCH_TARGET)).toHaveLength(0);
      if (provider === "claude") expect(document.activeElement).toBe(button("始める"));
      else expect(useCliLoginStore.getState().byProvider[provider]?.loginId).toBe("home-fixture");
    } finally { add.mockRestore(); }
  });

  const approval = (profileId: string): ClaudeSetupTokenEvent => ({
    login_id: "setup-fixture", profile_id: profileId, state: "code_available",
    url: "https://claude.ai/oauth/authorize?state=fixture",
  });

  it("keeps Enter on the Claude confirmation and cancel controls in front of the launcher", async () => {
    ipc.setupStart = approval("a");
    const add = vi.spyOn(useWorkspaceLayoutStore.getState(), "addTabToPaneWithOptions");
    try {
      await act(async () => root.render(<LauncherWithSettings />));
      await act(async () => button(launcherStrings.specTooltip("Claude Code")).click());
      await act(async () => button(launcherStrings.accountManagement).click());
      const target = document.querySelector('[data-cli-account-row="a"]')!;
      await act(async () => button("タブ用に登録", target).click());
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
      await act(async () => dialog.focus());
      await press(dialog, "Enter");
      expect(add).not.toHaveBeenCalled();
      const begin = button("始める");
      await act(async () => begin.focus());
      await press(begin, "Enter");
      const code = document.querySelector('[aria-label="承認コード"]');
      expect(document.activeElement).toBe(code);
      const cancel = button("中止", target);
      await act(async () => cancel.focus());
      await press(cancel, "Enter");
      expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "cancel_claude_setup_token")).toHaveLength(1);
      expect(add).not.toHaveBeenCalled();
    } finally { add.mockRestore(); }
  });

  it("resumes Claude approval after opening a Codex home login closes the same settings", async () => {
    vi.useFakeTimers();
    ipc.setupStart = approval("a");
    ipc.homeLogin = { login_id: "codex-home-fixture", provider: "codex", command: "", args: [], env: {}, staging_dir: "" };
    await act(async () => root.render(<TitleBar onOpenOnlinePanel={() => {}} />));
    const show = (provider: SwitchableCliProvider) => act(async () => useUiStore.getState().requestSettingsTab("usage", provider));
    await show("claude");
    await act(async () => button("タブ用に登録", document.querySelector('[data-cli-account-row="a"]')!).click());
    await act(async () => button("始める").click());
    expect(document.querySelector('[aria-label="承認コード"]')).not.toBeNull();
    ipc.setupSnapshot = ipc.setupStart;

    await act(async () => button("タブ用に登録", document.querySelector('[data-cli-account-row="x"]')!).click());
    expect(useCliLoginStore.getState().byProvider.codex?.loginId).toBe("codex-home-fixture");
    await act(async () => vi.advanceTimersByTimeAsync(OVERLAY_EXIT_MS));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await show("claude");
    expect(document.querySelector('[aria-label="承認コード"]')).not.toBeNull();
    const calls = (name: string) => vi.mocked(invoke).mock.calls.filter(([command]) => command === name).length;
    const beforeTokens = calls("get_cli_launch_tokens");
    const beforeHomes = calls("list_cli_account_homes");
    const status: CliLaunchTokenStatus = {
      profile_id: "a", registered_at: "", expires_at: "2099-01-01T00:00:00Z", owner_check: "verified", fingerprint: "fixture",
    };
    ipc.tokens = [status];
    const saved: ClaudeSetupTokenEvent = { ...ipc.setupStart!, state: "saved", status };
    await act(async () => {
      for (const notify of ipc.listListeners) notify({
        payload: { profile_id: saved.profile_id, claude_setup_login_id: saved.login_id },
      });
    });
    await act(async () => useClaudeSetupTokenStore.getState().handleEvent(saved));
    await act(async () => useClaudeSetupTokenStore.getState().handleEvent(saved));
    expect(calls("get_cli_launch_tokens")).toBe(beforeTokens + 1);
    expect(calls("list_cli_account_homes")).toBe(beforeHomes + 1);
    expect(useCliLoginStore.getState().byProvider.codex?.loginId).toBe("codex-home-fixture");
  });

  const busyCases = providerCases.flatMap(entry => (["new", "reauth"] as const).map(mode => ({ ...entry, mode })));
  it.each(busyCases)("keeps the three $provider launch controls usable during a global $mode login", async ({ provider, name, id, mode }) => {
    ipc.homeLogin = { login_id: "global-fixture", provider, command: "", args: [], env: {}, staging_dir: "" };
    await act(async () => { await useCliLoginStore.getState().start(provider, mode, mode === "reauth" ? id : undefined); });
    const add = vi.spyOn(useWorkspaceLayoutStore.getState(), "addTabToPaneWithOptions");
    try {
      await act(async () => root.render(launcher));
      const search = host.querySelector<HTMLInputElement>(`input[placeholder="${launcherStrings.searchPlaceholder}"]`)!;
      const change = async (value: string) => act(async () => {
        search.focus();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, value);
        search.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await change(name);
      await press(search, "Enter");
      expect(add.mock.calls.at(-1)?.[2].launchEnv?.MYCMUX_LAUNCH_TARGET).toBe(provider);
      expect(add).toHaveBeenCalledTimes(1);
      await change("");
      await act(async () => button(launcherStrings.specTooltip(name)).click());
      const manual = [...host.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === launcherStrings.modelManual);
      if (manual) await act(async () => manual.click());
      const model = host.querySelector<HTMLInputElement>('[data-launcher-spec] input')!;
      expect(model).not.toBeNull();
      await act(async () => model.focus());
      await press(model, "Enter");
      expect(add).toHaveBeenCalledTimes(2);
      await act(async () => button(launcherStrings.launchButton).click());
      expect(add).toHaveBeenCalledTimes(3);
      expect(add.mock.calls.every(([, , options]) => options.launchEnv?.MYCMUX_LAUNCH_TARGET === provider)).toBe(true);
      expect(useCliLoginStore.getState().byProvider[provider]?.loginId).toBe("global-fixture");
    } finally { add.mockRestore(); }
  });

  it.each(["saved", "failed", "cancelled", "timeout", "mismatch"] as const)("keeps the selected launch account and settings focus through %s, then launches after close", async state => {
    const selected = profile("claude-selected", "claude");
    const accounts = snapshot();
    accounts.profiles.push(selected);
    ipc.snapshot = accounts;
    ipc.tokens = [{ profile_id: selected.id, registered_at: "", expires_at: "2099-01-01T00:00:00Z",
      owner_check: "verified", fingerprint: "fixture" }];
    ipc.setupStart = approval("a");
    const add = vi.spyOn(useWorkspaceLayoutStore.getState(), "addTabToPaneWithOptions");
    try {
      await act(async () => root.render(<LauncherWithSettings />));
      await act(async () => button(launcherStrings.specTooltip("Claude Code")).click());
      const selectedButton = button(selected.label);
      await act(async () => selectedButton.click());
      // The launcher keeps its search focus when the mouse opens management.
      const opener = host.querySelector<HTMLInputElement>(`input[placeholder="${launcherStrings.searchPlaceholder}"]`)!;
      await act(async () => opener.focus());
      await act(async () => button(launcherStrings.accountManagement).click());
      const row = document.querySelector('[data-cli-account-row="a"]')!;
      await act(async () => button("タブ用に登録", row).click());
      await press(button("始める"), "Enter");
      expect(document.querySelector('[aria-label="承認コード"]')).not.toBeNull();
      const close = button("設定を閉じる");
      await act(async () => close.focus());
      await act(async () => useClaudeSetupTokenStore.getState().handleEvent({ ...ipc.setupStart!, state }));
      expect(document.activeElement).toBe(close);
      expect(selectedButton.getAttribute("aria-pressed")).toBe("true");
      expect(add).not.toHaveBeenCalled();
      await press(close, "Escape");
      expect(document.activeElement).toBe(opener);
      await act(async () => button(launcherStrings.launchButton).click());
      expect(add.mock.calls.at(-1)?.[2].launchEnv?.MYCMUX_LAUNCH_ACCOUNT).toBe(selected.id);
      expect(add).toHaveBeenCalledTimes(1);
    } finally { add.mockRestore(); }
  });

  it.each(["launcher", "setup"])("rereads saved accounts when focus returns from settings to the same-window %s", async surface => {
    const view = (settings: boolean) => <>
      {surface === "launcher" ? <LauncherPane workspaceId="fixture" paneId="pane" tabId="tab" sessionId="session" isActive />
        : <AgentSelector slotIndex={0} value={{ target: "claude" }} onChange={() => {}} />}
      {settings && <SettingsDialog initialTab="usage" onClose={() => {}} onOpenOnlinePanel={() => {}} />}
    </>;
    await act(async () => root.render(view(false)));
    if (surface === "launcher") await act(async () => button(launcherStrings.specTooltip("Claude Code")).click());
    const field = button(launcherStrings.accountManagement, host);
    await act(async () => field.focus());
    await act(async () => root.render(view(true)));
    expect(document.activeElement).toBe(document.querySelector('[role="dialog"]'));
    const reads = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === "get_cli_launch_tokens").length;
    const before = reads();
    await act(async () => root.render(view(false)));
    // No OS window focus event or account-change notification is sent.
    expect(document.activeElement).toBe(field);
    expect(reads()).toBeGreaterThan(before);
  });

  it("focuses the requested provider on the first opening", async () => {
    await act(async () => root.render(<SettingsDialog initialTab="usage" accountSection={{ provider: "grok" }}
      onClose={() => {}} onOpenOnlinePanel={() => {}} />));
    const grok = document.querySelector('[data-account-provider="grok"]');
    expect(grok).not.toBeNull();
    expect(document.activeElement).toBe(grok);
  });

  it("moves the continuation from the notification's account to an account added in the open manager", async () => {
    const fromLogin = profile("claude-from-login", "claude");
    const fromCapture = profile("claude-from-capture", "claude");
    const next = snapshot();
    next.profiles.push(fromLogin);
    ipc.snapshot = next;
    await act(async () => {
      useCliLoginStore.setState({ byProvider: { claude: { stage: "waiting", loginId: "fixture-login", mode: "new",
        startedAt: Date.now(), sessionId: null, tabId: null }, codex: null, grok: null } });
      await useCliLoginStore.getState().handleCompleted({ login_id: "fixture-login", profile: fromLogin, updated_existing: false });
    });
    const continueLabel = "このアカウントをタブ用にも登録";
    const notice = useToastStore.getState().toasts.find(toast => toast.action?.label === continueLabel);
    expect(notice?.message).toContain(fromLogin.label);
    await act(async () => root.render(<TitleBar onOpenOnlinePanel={() => {}} />));
    await act(async () => notice!.action!.run());
    const row = document.querySelector('[data-cli-account-row="claude-from-login"]')!;
    expect(row.textContent).toContain(continueLabel);

    ipc.snapshot = { ...next, profiles: [...next.profiles, fromCapture] };
    ipc.capture = fromCapture;
    await act(async () => button("現在のログインを登録/更新", document.querySelector('[data-account-provider="claude"]')!).click());
    const added = document.querySelector('[data-cli-account-row="claude-from-capture"]')!;
    expect(added).not.toBeNull();
    expect(button(continueLabel, added)).toBeDefined();
    expect(row.textContent).not.toContain(continueLabel);
  });

  it("launches Claude and then default Codex while the same Codex private home login remains open", async () => {
    ipc.homeLogin = { login_id: "codex-home-fixture", provider: "codex", command: "", args: [], env: {}, staging_dir: "" };
    await act(async () => {
      expect(await useCliLoginStore.getState().startAccountHome("codex", "x")).toBe(true);
    });
    const original = useCliLoginStore.getState().byProvider.codex!;
    expect(original).toMatchObject({ loginId: "codex-home-fixture", purpose: { kind: "account_home", profile_id: "x" } });
    const workspace = useWorkspaceListStore.getState().getActiveWorkspace()!;
    const pane = workspace.panes.find(candidate => candidate.tabs.some(tab => tab.id === original.tabId))!;
    const renderLauncher = async (id: string) => act(async () => root.render(
      <LauncherPane workspaceId={workspace.id} paneId={pane.id} tabId={id} sessionId={id} isActive />,
    ));
    const add = vi.spyOn(useWorkspaceLayoutStore.getState(), "addTabToPaneWithOptions");
    try {
      await renderLauncher("first-launcher");
      await act(async () => button(launcherStrings.specTooltip("Codex")).click());
      await act(async () => button(launcherStrings.specTooltip("Claude Code")).click());
      await act(async () => button(launcherStrings.launchButton).click());
      expect(useCliLoginStore.getState().byProvider.codex).toBe(original);

      await renderLauncher("second-launcher");
      await act(async () => button(launcherStrings.specTooltip("Codex")).click());
      await act(async () => button(launcherStrings.specDefault).click());
      await act(async () => button(launcherStrings.launchButton).click());
      expect(add.mock.calls.map(([, , options]) => options.launchEnv)).toEqual([
        { MYCMUX_LAUNCH_TARGET: "claude" },
        { MYCMUX_LAUNCH_TARGET: "codex" },
      ]);
      expect(useCliLoginStore.getState().byProvider.codex).toBe(original);
      expect(useWorkspaceListStore.getState().getWorkspace(workspace.id)?.panes.flatMap(item => item.tabs))
        .toContainEqual(expect.objectContaining({ id: original.tabId, launchEnv: { MYCMUX_CLI_LOGIN_ID: original.loginId } }));
    } finally { add.mockRestore(); }
  });

  it("continues registration in the account named by the notification after a different account is added", async () => {
    const fromLogin = profile("claude-from-login", "claude");
    const fromCapture = profile("claude-from-capture", "claude");
    const next = snapshot();
    next.profiles.push(fromLogin);
    ipc.snapshot = next;
    await act(async () => {
      useCliLoginStore.setState({ byProvider: { claude: { stage: "waiting", loginId: "fixture-login", mode: "new",
        startedAt: Date.now(), sessionId: null, tabId: null }, codex: null, grok: null } });
      await useCliLoginStore.getState().handleCompleted({ login_id: "fixture-login", profile: fromLogin, updated_existing: false });
    });
    const notice = useToastStore.getState().toasts.find(toast => toast.action?.label === "このアカウントをタブ用にも登録");
    expect(notice?.message).toContain(fromLogin.label);
    ipc.snapshot = { ...next, profiles: [...next.profiles, fromCapture] };
    ipc.capture = fromCapture;
    await act(async () => button("現在のログインを登録/更新", block("Claude Code")).click());
    expect(host.querySelector('[data-cli-account-row="claude-from-capture"]')?.textContent).toContain("このアカウントをタブ用にも登録");
    await act(async () => root.render(<TitleBar onOpenOnlinePanel={() => {}} />));
    await act(async () => notice!.action!.run());
    const row = document.querySelector('[data-cli-account-row="claude-from-login"]')!;
    expect(row.textContent).toContain("このアカウントをタブ用にも登録");
    expect(document.activeElement).toBe(row);
    expect(document.querySelector('[data-cli-account-row="claude-from-capture"]')?.textContent)
      .not.toContain("このアカウントをタブ用にも登録");
  });
});
