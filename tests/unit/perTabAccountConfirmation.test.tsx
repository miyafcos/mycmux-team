// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), handlers: new Set<(event: { payload: { profile_id: string } }) => void>() }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async (name: string, handler: (event: { payload: { profile_id: string } }) => void) => {
    if (name === "tab-account-evidence-updated") mocks.handlers.add(handler);
    return () => { mocks.handlers.delete(handler); };
  }),
}));
vi.mock("../../src/lib/appConfirmation", () => ({ confirm: vi.fn(async () => true) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "mycmux-w1", setTitle: vi.fn(async () => {}) }) }));
vi.mock("../../src/hooks/usePaneDragSource", () => ({ usePaneDragSource: () => ({ beginPointerDrag: vi.fn(), shouldSuppressClick: () => false }) }));
vi.mock("../../src/components/terminal/XTermWrapper", () => ({
  default: () => <div />, evictTerminalCache: vi.fn(), TERMINAL_SEARCH_EVENT: "fixture-search",
}));
import { TabAccountSettings, TabAccountSettingsProvider } from "../../src/components/settings/TabAccountSettings";
import { TabAccountBadge } from "../../src/components/layout/TabAccountBadge";
import { cliAccountMessage } from "../../src/lib/cliAccounts";
import { TabAccountPanel, tabAccountProvider } from "../../src/components/layout/TabAccountPanel";
import DetachedPaneShell from "../../src/components/layout/DetachedPaneShell";
import PaneTabBar from "../../src/components/workspace/PaneTabBar";
import { useCliAccountStore } from "../../src/stores/cliAccountStore";
import { useUsageStore } from "../../src/stores/usageStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import type { CliAccountProfile, CliProvider, ProfileUsage, TabAccountEvidence } from "../../src/lib/ipc";
import type { PaneTab, Workspace } from "../../src/types";
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let current: TabAccountEvidence | null;
const checked = new Date(2026, 10, 12, 9, 30).toISOString();
const profile = (provider: CliProvider, id = "selected", label = "仕事用"): CliAccountProfile => ({
  id, provider, label, email: "fixture@example.test", identity_key: "fixture", plan: null,
  org_name: null, captured_at: "", last_switched_at: null, needs_relogin: false,
});
const tab = (provider: CliProvider = "claude", overrides: Partial<PaneTab> = {}): PaneTab => ({
  id: "tab", sessionId: "pty", agentId: provider === "claude" ? "claude-code" : provider,
  agentKind: provider, type: "terminal", agentAccountId: "selected", ...overrides,
});
const evidence = (result: TabAccountEvidence["result"] = "verified", provider: CliProvider = "claude"): TabAccountEvidence => ({
  provider, profile_id: "selected", method: provider === "claude" ? "claude_launch_token" : "account_home",
  result, checked_at: checked, launched_at: checked, fingerprint: provider === "claude" ? "0123456789" : undefined,
  owner_email: provider === "claude" ? undefined : "owner@example.test", owner_method: provider === "claude" ? "profile" : undefined,
});
// jsdom (pretendToBeVisual) drives requestAnimationFrame with its own setInterval(..., 1000 / 60), started whenever the
// first frame callback is queued. Whether that lands inside one test depends on timing (it did on Windows), so only
// that driver is excluded; any product polling interval still fails these checks.
const productIntervals = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter(([, ms]) => ms !== 1000 / 60);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.handlers.clear();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 12, 12));
  current = evidence();
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "get_tab_account_evidence" || command === "recheck_tab_account") return current;
    return undefined;
  });
  useCliAccountStore.setState({ profiles: [profile("claude"), profile("claude", "global", "全体用")],
    active: { claude: "global", codex: null, grok: null }, loading: false });
  useUsageStore.setState({ accounts: [] });
  useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null });
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {}, lastLog: {}, lastLogAt: {} });
  useUiStore.setState({ activePaneId: "pty" });
  useSettingsStore.setState({ agentTabContent: "terminal", conversationHistoryMode: "legacy" });
  host = document.createElement("div"); host.dataset.cmuxThemedRoot = "true";
  document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function mount(node: ReactNode) { await act(async () => root.render(node)); }
function button(label: string) {
  const node = [...host.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === label || node.getAttribute("aria-label") === label);
  expect(node, label).toBeDefined(); return node!;
}
function emitUpdated(id = "selected") { for (const handler of mocks.handlers) handler({ payload: { profile_id: id } }); }
const calls = (name: string) => mocks.invoke.mock.calls.filter(([command]) => command === name);

describe("V2 exact badge confirmation wording, icons, colors", () => {
  it.each([
    ["matched", "check", "var(--cmux-text-secondary)", "確認済み: このタブのログインが owner@example.test のものだと確かめました (最後に確かめた時刻: 09:30)"],
    ["verified", "check", "var(--cmux-text-secondary)", "確認済み: トークンの持ち主が fixture@example.test だとサーバーで確かめました (最後に確かめた時刻: 09:30)"],
    ["org_matched", "check", "var(--cmux-text-secondary)", "確認済み: トークンの組織が 仕事用 の組織と一致しました (最後に確かめた時刻: 09:30)"],
    ["org_shared", "warning", "var(--cmux-usage-warn)", "組織だけ一致: 同じ組織のアカウントがほかにも登録されているため、どのアカウントかまでは確かめられていません"],
    ["unverified", "warning", "var(--cmux-usage-warn)", "未確認: トークンの持ち主をサーバーで確かめられませんでした。このタブで作業して、仕事用 の使用量が上がるかで確かめてください"],
    ["stale", "warning", "var(--cmux-usage-warn)", "未確認: このタブは、トークンを登録し直す前に起動しました。タブを開き直すと、今のトークンで動きます"],
    ["mismatch", "mismatch", "var(--cmux-usage-danger)", "不一致: このタブのログインは 仕事用 のものではありません。設定のアカウントで、タブ用の登録をやり直してください"],
  ] as const)("renders %s as an exact second line", async (result, icon, color, text) => {
    // Date construction is local on either test host; use fake timers for the literal 'today' format.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 12, 12));
    current = evidence(result, result === "matched" ? "codex" : "claude");
    await mount(<TabAccountBadge accountId="selected" sessionId="pty" />);
    const badge = host.querySelector<HTMLElement>("[data-tab-account-badge]")!;
    expect(badge.title).toBe("アカウント: 仕事用 (このタブだけ)\n" + text);
    expect(badge.style.color).toBe(color);
    expect(badge.style.fontSize).toBe("var(--cmux-font-size-xs)");
    expect(badge.querySelector("[data-account-evidence-icon]")?.getAttribute("data-account-evidence-icon")).toBe(icon);
    expect(badge.textContent).toBe("仕事用");
    expect(badge.innerHTML).not.toContain("0123456789");
    vi.useRealTimers();
  });
  it.each(["codex", "grok"] as const)("uses the %s owner email, the label without an email, and M/D for earlier checks", async provider => {
    current = evidence("matched", provider); current.owner_email = undefined;
    current.checked_at = new Date(2026, 10, 1, 9, 30).toISOString();
    await mount(<TabAccountBadge accountId="selected" sessionId="pty" />);
    expect(host.querySelector<HTMLElement>("[data-tab-account-badge]")!.title).toBe(
      "アカウント: 仕事用 (このタブだけ)\n確認済み: このタブのログインが 仕事用 のものだと確かめました (最後に確かめた時刻: 11/1 09:30)");
  });
  it("fetches on mount and explicit same-profile rechecks, never on a timer or ordinary rerender", async () => {
    const timer = vi.spyOn(globalThis, "setInterval");
    await mount(<TabAccountBadge accountId="selected" sessionId="pty" />);
    await mount(<TabAccountBadge accountId="selected" sessionId="pty" />);
    expect(calls("get_tab_account_evidence")).toHaveLength(1);
    expect(productIntervals(timer)).toEqual([]);
    await act(async () => emitUpdated("other-profile"));
    expect(calls("get_tab_account_evidence")).toHaveLength(1);
    current = evidence("mismatch");
    await act(async () => emitUpdated());
    expect(calls("get_tab_account_evidence")).toHaveLength(2);
    expect(host.querySelector("[data-tab-account-badge]")?.getAttribute("data-account-result")).toBe("mismatch");
    await mount(<TabAccountBadge sessionId="default" />);
    expect(host.querySelector("[data-tab-account-badge]")).toBeNull();
    expect(calls("get_tab_account_evidence")).toHaveLength(2);
  });
});

it("fills a badge first mounted before its PTY is ready without polling", async () => {
  current = null;
  await mount(<TabAccountBadge accountId="selected" sessionId="pty" />);
  expect(host.querySelector("[data-account-evidence-icon]")).toBeNull();
  current = evidence("org_matched");
  await act(async () => emitUpdated());
  expect(host.querySelector("[data-tab-account-badge]")?.getAttribute("data-account-result")).toBe("org_matched");
  expect(calls("get_tab_account_evidence")).toHaveLength(2);
});

const fieldValues = () => [...host.querySelectorAll("dl > div")].map(node => [node.querySelector("dt")?.textContent, node.querySelector("dd")?.textContent]);
describe("V3 account panel", () => {
  it.each(["claude", "codex", "grok"] as const)("shows the exact ordered rows and usage for the selected %s account", async provider => {
    useCliAccountStore.setState({ profiles: [profile(provider), profile(provider, "global", "全体用")],
      active: { claude: null, codex: null, grok: null, [provider]: "global" } });
    current = evidence(provider === "claude" ? "verified" : "matched", provider);
    const usage: ProfileUsage = {
      provider, profile_id: "selected", label: "仕事用", email: null, plan: null, registered: true, is_active: false,
      needs_relogin: false, state: "ok", five_hour: { pct: 12, resets_at: "" }, seven_day: { pct: 34, resets_at: "" },
      seven_day_sonnet: null, seven_day_opus: null, model_windows: [], error_code: null, retry_at: null, fetched_at: "",
    };
    useUsageStore.setState({ accounts: [usage, { ...usage, profile_id: "global", five_hour: { pct: 99, resets_at: "" } }] });
    await mount(<TabAccountPanel tab={tab(provider)} provider={provider} onClose={() => {}} />);
    expect(host.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("このタブのアカウント");
    expect(fieldValues()).toEqual([
      ["指定したアカウント", "仕事用 (fixture@example.test)"],
      ["ログインの渡し方", provider === "claude" ? "登録した長期トークン (このタブだけに渡しています)" : "このアカウント専用のログイン (このタブだけが使います)"],
      ["確認", provider === "claude"
        ? "確認済み: トークンの持ち主が fixture@example.test だとサーバーで確かめました (最後に確かめた時刻: 09:30)"
        : "確認済み: このタブのログインが owner@example.test のものだと確かめました (最後に確かめた時刻: 09:30)"],
      ["今の全体のアカウント", "全体用"],
      ["仕事用 の使用量", "5 時間 12%・週 34%"],
    ]);
    expect(host.textContent).toContain("このタブで作業すると 仕事用 の使用量が上がり、全体のアカウントの使用量は動きません。");
    expect(host.textContent).not.toContain("99%");
    expect(host.textContent).not.toContain("0123456789");
    expect(calls("get_account_usage")).toHaveLength(0);
  });
  it("shows missing usage, no global selection, and a label without an email", async () => {
    useCliAccountStore.setState({ profiles: [{ ...profile("claude"), email: null }], active: { claude: null, codex: null, grok: null } });
    await mount(<TabAccountPanel tab={tab()} provider="claude" onClose={() => {}} />);
    expect(fieldValues()).toContainEqual(["指定したアカウント", "仕事用"]);
    expect(fieldValues()).toContainEqual(["今の全体のアカウント", "なし"]);
    expect(fieldValues()).toContainEqual(["仕事用 の使用量", "未取得"]);
    await act(async () => useCliAccountStore.setState({ profiles: [profile("claude"), profile("claude", "changed", "切替後")],
      active: { claude: "changed", codex: null, grok: null } }));
    expect(fieldValues()).toContainEqual(["今の全体のアカウント", "切替後"]);
  });
  it.each(["claude", "codex", "grok"] as const)("shows only the exact default-tab explanation for %s, with no recheck", async provider => {
    useCliAccountStore.setState({ profiles: [profile(provider, "global", "全体用")],
      active: { claude: null, codex: null, grok: null, [provider]: "global" } });
    await mount(<TabAccountPanel tab={tab(provider, { agentAccountId: undefined })} provider={provider} onClose={() => {}} />);
    expect(host.querySelector("p")?.textContent).toBe("このタブはアカウントを指定せずに起動しました。全体のアカウントで動いています (今の全体のアカウント: 全体用)。");
    expect(host.querySelector("dl")).toBeNull();
    expect([...host.querySelectorAll("button")].some(node => node.textContent === "確かめ直す")).toBe(false);
    expect(calls("get_tab_account_evidence")).toHaveLength(0);
    expect(calls("recheck_tab_account")).toHaveLength(0);
  });
  it("rechecks the PTY once, disables while pending, and updates both the panel and badge", async () => {
    await mount(<><TabAccountBadge accountId="selected" sessionId="pty" /><TabAccountPanel tab={tab()} provider="claude" onClose={() => {}} /></>);
    let finish!: (next: TabAccountEvidence) => void;
    const pending = new Promise<TabAccountEvidence>(resolve => { finish = resolve; });
    mocks.invoke.mockImplementation(async (name: string) => name === "recheck_tab_account" ? pending : current);
    await act(async () => button("確かめ直す").click());
    expect(button("確かめ直す").disabled).toBe(true);
    expect(button("確かめ直す").getAttribute("aria-busy")).toBe("true");
    await act(async () => button("確かめ直す").click());
    expect(calls("recheck_tab_account")).toEqual([["recheck_tab_account", { sessionId: "pty" }]]);
    current = evidence("org_shared");
    await act(async () => { finish(current!); emitUpdated(); });
    expect(button("確かめ直す").disabled).toBe(false);
    const text = "組織だけ一致: 同じ組織のアカウントがほかにも登録されているため、どのアカウントかまでは確かめられていません";
    expect(fieldValues()).toContainEqual(["確認", text]);
    expect(host.querySelector<HTMLElement>("[data-tab-account-badge]")!.title).toBe("アカウント: 仕事用 (このタブだけ)\n" + text);
  });
  it.each(["rejected", "unavailable", "mismatch"] as const)("uses the exact %s failure and allows retry", async outcome => {
    await mount(<TabAccountPanel tab={tab()} provider="claude" onClose={() => {}} />);
    mocks.invoke.mockImplementation(async (name: string) => {
      if (name !== "recheck_tab_account") return current;
      if (outcome === "rejected") throw new Error("fixture-private-credential-error");
      return { ...evidence(outcome === "mismatch" ? "mismatch" : "unverified"), owner_method: undefined };
    });
    await act(async () => button("確かめ直す").click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(outcome === "mismatch"
      ? "不一致: このタブのログインは 仕事用 のものではありません。設定のアカウントで、タブ用の登録をやり直してください"
      : outcome === "rejected" ? cliAccountMessage("unknown")
      : "確かめられませんでした: サーバーにつながりませんでした。少し待ってから、もう一度押してください。");
    expect(button("確かめ直す").disabled).toBe(false);
    expect(host.textContent).not.toContain("fixture-private-credential-error");
  });
});


describe("V-FIX1 factual recheck outcomes", () => {
  it.each(["status_only", "method_only", "both"] as const)("uses exact wording A for an answered Claude lookup: %s", async kind => {
    await mount(<TabAccountPanel tab={tab()} provider="claude" onClose={() => {}} />);
    mocks.invoke.mockResolvedValue({
      ...evidence("unverified"), owner_method: kind === "status_only" ? undefined : "org",
      owner_check_status: kind === "method_only" ? undefined : 403,
    });
    await act(async () => button("確かめ直す").click());
    const notice = host.querySelector<HTMLElement>('[role="status"]')!;
    expect(notice.textContent).toBe("確かめ直しました (09:30): サーバーは、このトークンの持ち主を答えませんでした。");
    expect(notice.style.color).toBe("var(--cmux-usage-warn)");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).not.toContain("確かめられませんでした: サーバーにつながりませんでした。少し待ってから、もう一度押してください。");
  });
  it("keeps the communication alert only when both status and method are absent", async () => {
    await mount(<TabAccountPanel tab={tab()} provider="claude" onClose={() => {}} />);
    mocks.invoke.mockResolvedValue({ ...evidence("unverified"), owner_method: undefined, owner_check_status: undefined });
    await act(async () => button("確かめ直す").click());
    const notice = host.querySelector<HTMLElement>('[role="alert"]')!;
    expect(notice.textContent).toBe("確かめられませんでした: サーバーにつながりませんでした。少し待ってから、もう一度押してください。");
    expect(notice.style.color).toBe("var(--cmux-usage-danger)");
    expect(host.querySelector('[role="status"]')).toBeNull();
  });
  it.each(["codex", "grok"] as const)("reports the existing local-file error for %s without a server claim", async provider => {
    current = evidence("matched", provider);
    await mount(<TabAccountPanel tab={tab(provider)} provider={provider} onClose={() => {}} />);
    mocks.invoke.mockRejectedValue("cli_account.error.home_not_ready");
    await act(async () => button("確かめ直す").click());
    const notice = host.querySelector<HTMLElement>('[role="alert"]')!;
    expect(notice.textContent).toBe("原因: このアカウントはタブ用のログインがまだです。次にすること: 設定のアカウントからログインしてください。");
    expect(notice.style.color).toBe("var(--cmux-usage-danger)");
    expect(host.textContent).not.toContain("サーバーにつながりませんでした");
  });
  it("maps a removed Claude token exception through the existing error table", async () => {
    await mount(<TabAccountPanel tab={tab()} provider="claude" onClose={() => {}} />);
    mocks.invoke.mockRejectedValue("cli_account.error.launch_token_missing");
    await act(async () => button("確かめ直す").click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(cliAccountMessage("cli_account.error.launch_token_missing"));
    expect(host.textContent).not.toContain("サーバーにつながりませんでした");
  });
  it.each(["claude", "codex", "grok"] as const)("uses exact wording B only for this provider's current active account: %s", async provider => {
    current = evidence(provider === "claude" ? "verified" : "matched", provider);
    useCliAccountStore.setState({ profiles: [profile(provider), profile(provider, "global", "全体用")],
      active: { claude: "selected", codex: "selected", grok: "selected", [provider]: "global" } });
    await mount(<TabAccountPanel tab={tab(provider)} provider={provider} onClose={() => {}} />);
    const footer = host.querySelector('[role="dialog"] p')!;
    expect(footer.textContent).toBe("このタブで作業すると 仕事用 の使用量が上がり、全体のアカウントの使用量は動きません。");
    await act(async () => useCliAccountStore.setState({ active: { claude: null, codex: null, grok: null, [provider]: "selected" } }));
    expect(footer.textContent).toBe("この指定は、今の全体のアカウントと同じ 仕事用 です。このタブで作業すると 仕事用 の使用量が上がります。");
    expect(host.textContent).not.toContain("全体のアカウントの使用量は動きません。");
  });
  it.each([
    ["verified", "claude"], ["org_matched", "claude"], ["org_shared", "claude"], ["stale", "claude"],
    ["matched", "codex"], ["matched", "grok"],
  ] as const)("adds no notice for the remaining result %s from %s", async (result, provider) => {
    current = evidence(result, provider);
    await mount(<TabAccountPanel tab={tab(provider)} provider={provider} onClose={() => {}} />);
    mocks.invoke.mockResolvedValue(evidence(result, provider));
    await act(async () => button("確かめ直す").click());
    expect(host.querySelector('[role="alert"], [role="status"]')).toBeNull();
  });
});

function workspace(active: PaneTab): Workspace {
  return { id: "w", name: "Fixture", gridTemplateId: "1x1", status: "running", createdAt: 1,
    panes: [{ id: "p", agentId: active.agentId, sessionId: active.sessionId, activeTabId: active.id, tabs: [active] }] };
}
describe("V3 agent-only kebab menu and detached confirmation", () => {
  it.each([
    ["claude", true], ["codex", true], ["grok", true], ["claude-codex", false], ["antigravity", false], ["shell", false],
  ] as const)("shows the row only for supported agent %s", async (kind, visible) => {
    const active = { ...tab(), agentId: kind, agentKind: kind === "shell" ? undefined : kind } as PaneTab;
    const ws = workspace(active);
    useWorkspaceListStore.setState({ workspaces: [ws], activeWorkspaceId: "w" });
    await mount(<PaneTabBar pane={ws.panes[0]} workspaceId="w" hasTerminalBuffer={() => false} />);
    await act(async () => host.querySelector<HTMLButtonElement>("button[aria-haspopup='menu']")!.click());
    expect(host.querySelector('[data-pane-action="tab-account"]') !== null).toBe(visible);
  });
  it("keeps web presets out of the menu even when they use an agent name", () => {
    expect(tabAccountProvider(tab("claude", { type: "web" }))).toBeNull();
    expect(tabAccountProvider(tab("codex", { type: "browser" }))).toBeNull();
    expect(tabAccountProvider(tab("codex"), null)).toBe("codex");
    expect(tabAccountProvider(tab("grok", { agentKind: undefined }))).toBe("grok");
    expect(tabAccountProvider(tab("claude", { agentId: "shell", agentKind: undefined }), "grok")).toBe("grok");
  });
  it("opens from keyboard menu activation, traps focus in the panel, and closes on Escape", async () => {
    const active = tab(); const ws = workspace(active);
    useWorkspaceListStore.setState({ workspaces: [ws], activeWorkspaceId: "w" });
    const Bar = () => <PaneTabBar pane={ws.panes[0]} workspaceId="w" hasTerminalBuffer={() => false} />;
    await mount(<Bar />);
    const trigger = host.querySelector<HTMLButtonElement>("button[aria-haspopup='menu']")!;
    trigger.focus();
    // Browsers dispatch a zero-detail click for Enter/Space on a native button.
    await act(async () => { trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })); });
    const menu = host.querySelector<HTMLElement>(".pane-actions-menu")!;
    const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    const target = menu.querySelector<HTMLButtonElement>('[data-pane-action="tab-account"]')!;
    items.at(-1)!.focus();
    const steps = items.indexOf(target) + 1;
    for (let n = 0; n < steps; n++) await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
    expect(document.activeElement).toBe(target);
    expect(target.textContent).toBe("このタブのアカウント");
    await act(async () => { target.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })); });
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(document.activeElement).toBe(dialog);
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });
  it("renders and refreshes the same PTY evidence in the actual detached shell", async () => {
    const ws = workspace(tab("codex"));
    useWorkspaceListStore.setState({ workspaces: [ws], activeWorkspaceId: "w" });
    useCliAccountStore.setState({ profiles: [profile("codex")], active: { claude: null, codex: "selected", grok: null } });
    current = evidence("matched", "codex");
    await mount(<DetachedPaneShell workspace={{ ...ws, detached: true }} />);
    expect(host.querySelector("[data-detached-pane-shell]")).not.toBeNull();
    const badge = host.querySelector<HTMLElement>("[data-tab-account-badge]")!;
    expect(badge.title).toBe("アカウント: 仕事用 (このタブだけ)\n確認済み: このタブのログインが owner@example.test のものだと確かめました (最後に確かめた時刻: 09:30)");
    current = evidence("mismatch", "codex");
    await act(async () => emitUpdated());
    expect(badge.title).toBe("アカウント: 仕事用 (このタブだけ)\n不一致: このタブのログインは 仕事用 のものではありません。設定のアカウントで、タブ用の登録をやり直してください");
    expect(calls("get_tab_account_evidence").every(([, args]) => args.sessionId === "pty")).toBe(true);
  });
});


describe("RV-04 token registration updates on mounted badges", () => {
  it.each(["save", "remove"] as const)("refreshes the badge and open panel after settings %s succeeds", async operation => {
    const registration = { profile_id: "selected", registered_at: checked, expires_at: "2027-11-12T00:00:00Z",
      owner_check: "verified", fingerprint: "rv04-old" };
    let registrations = [registration];
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "get_tab_account_evidence") return current;
      if (command === "get_cli_launch_tokens") return registrations;
      if (command === "list_cli_account_homes") return [];
      if (command === "set_cli_launch_token" || command === "remove_cli_launch_token") {
        await pending;
        current = evidence("stale");
        registrations = operation === "save" ? [{ ...registration, fingerprint: "rv04-new" }] : [];
        // Model the backend success event. A Python contract checks both real commands emit it.
        emitUpdated();
        return operation === "save" ? registrations[0] : undefined;
      }
      return undefined;
    });
    const timer = vi.spyOn(globalThis, "setInterval");
    await mount(<><TabAccountBadge accountId="selected" sessionId="pty" />
      <TabAccountPanel tab={tab()} provider="claude" onClose={() => {}} />
      <TabAccountSettingsProvider><TabAccountSettings profile={profile("claude")} /></TabAccountSettingsProvider></>);
    const badge = host.querySelector<HTMLElement>("[data-tab-account-badge]")!;
    expect(badge.getAttribute("data-account-result")).toBe("verified");
    expect(calls("get_tab_account_evidence")).toHaveLength(2);
    if (operation === "save") {
      await act(async () => button("登録").click());
      host.querySelector<HTMLInputElement>('input[type="password"]')!.value = "rv04-synthetic-paste";
      await act(async () => button("保存").click());
    } else await act(async () => button("外す").click());
    expect(calls(operation === "save" ? "set_cli_launch_token" : "remove_cli_launch_token")).toHaveLength(1);
    expect(badge.getAttribute("data-account-result")).toBe("verified");
    await act(async () => emitUpdated("unrelated-profile"));
    expect(calls("get_tab_account_evidence")).toHaveLength(2);
    await act(async () => finish());
    expect(calls("get_tab_account_evidence")).toHaveLength(4);
    expect(badge.getAttribute("data-account-result")).toBe("stale");
    expect(badge.title).toContain("未確認: このタブは、トークンを登録し直す前に起動しました。タブを開き直すと、今のトークンで動きます");
    expect(fieldValues()).toContainEqual(["確認", "未確認: このタブは、トークンを登録し直す前に起動しました。タブを開き直すと、今のトークンで動きます"]);
    expect(host.innerHTML).not.toContain("rv04-synthetic-paste");
    expect(productIntervals(timer)).toEqual([]);
  });
});


describe("RV-05 factual usage footer", () => {
  const cases = ([false, true] as const).flatMap(same =>
    (["matched", "verified", "org_matched", "org_shared", "unverified", "stale", "mismatch", "none"] as const)
      .map(result => ({ same, result })));
  it.each(cases)("selects A/B/C for global-same=$same, evidence=$result", async ({ same, result }) => {
    const provider = result === "matched" ? "codex" : "claude";
    current = result === "none" ? null : evidence(result, provider);
    useCliAccountStore.setState({ profiles: [profile(provider), profile(provider, "global", "Global")],
      active: { claude: null, codex: null, grok: null, [provider]: same ? "selected" : "global" } });
    await mount(<TabAccountPanel tab={tab(provider)} provider={provider} onClose={() => {}} />);
    const confirmed = result === "matched" || result === "verified" || result === "org_matched";
    expect(host.querySelector('[role="dialog"] p')?.textContent).toBe(confirmed ? (same ? "この指定は、今の全体のアカウントと同じ 仕事用 です。このタブで作業すると 仕事用 の使用量が上がります。" : "このタブで作業すると 仕事用 の使用量が上がり、全体のアカウントの使用量は動きません。") : "指定したアカウントは 仕事用 です。実際にどのアカウントの使用量が上がるかは、上の「確認」と使用量で確かめてください。");
  });
  it.each(([false, true] as const).flatMap(same => [false, true].map(retain => ({ same, retain }))))(
    "uses C when reading fails, global-same=$same, retains-earlier-verified=$retain", async ({ same, retain }) => {
      let fail = !retain;
      mocks.invoke.mockImplementation(async (command: string) => {
        if (command === "get_tab_account_evidence") {
          if (fail) throw new Error("rv05-private-read-error");
          return current;
        }
        return undefined;
      });
      useCliAccountStore.setState({ active: { claude: same ? "selected" : "global", codex: null, grok: null } });
      await mount(<TabAccountPanel tab={tab()} provider="claude" onClose={() => {}} />);
      if (retain) { fail = true; await act(async () => emitUpdated()); }
      expect(host.querySelector('[role="dialog"] p')?.textContent).toBe("指定したアカウントは 仕事用 です。実際にどのアカウントの使用量が上がるかは、上の「確認」と使用量で確かめてください。");
      expect(host.textContent).not.toContain("rv05-private-read-error");
    });
});

describe("RV-06 last verification time after a recheck", () => {
  it.each([["matched", "codex", "確認済み: このタブのログインが owner@example.test のものだと確かめました (最後に確かめた時刻: 11:45)"], ["verified", "claude", "確認済み: トークンの持ち主が fixture@example.test だとサーバーで確かめました (最後に確かめた時刻: 11:45)"], ["org_matched", "claude", "確認済み: トークンの組織が 仕事用 の組織と一致しました (最後に確かめた時刻: 11:45)"]] as const)("shows the latest %s check independently of launch time", async (result, provider, expected) => {
    current = evidence(result, provider);
    useCliAccountStore.setState({ profiles: [profile(provider), profile(provider, "global", "Global")],
      active: { claude: null, codex: null, grok: null, [provider]: "global" } });
    await mount(<><TabAccountBadge accountId="selected" sessionId="pty" />
      <TabAccountPanel tab={tab(provider)} provider={provider} onClose={() => {}} /></>);
    current = { ...current!, checked_at: new Date(2026, 10, 12, 11, 45).toISOString() };
    await act(async () => { button("確かめ直す").click(); emitUpdated(); });
    expect(current.launched_at).toBe(checked);
    expect(host.querySelector<HTMLElement>("[data-tab-account-badge]")!.title.split("\n")[1]).toBe(expected);
    expect(fieldValues()).toContainEqual(["確認", expected]);
  });
});
