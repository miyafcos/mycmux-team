// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  begin: vi.fn(), cancel: vi.fn(), submit: vi.fn(), current: vi.fn(), listen: vi.fn(), open: vi.fn(),
  tokens: vi.fn(), homes: vi.fn(), accounts: vi.fn(), save: vi.fn(), startHome: vi.fn(),
  accountState: { busyByProvider: { claude: null, codex: null, grok: null } },
}));
vi.mock("../../src/lib/ipc", () => ({
  CLI_LOGIN_TIMEOUT_MS: 600000, startClaudeSetupToken: mocks.begin, cancelClaudeSetupToken: mocks.cancel,
  submitClaudeSetupCode: mocks.submit, getClaudeSetupTokenState: mocks.current, onClaudeSetupToken: mocks.listen,
  getCliLaunchTokens: mocks.tokens, listCliAccountHomes: mocks.homes, listCliAccounts: mocks.accounts,
  setCliLaunchToken: mocks.save, removeCliLaunchToken: vi.fn(), recheckCliLaunchToken: vi.fn(), unregisterCliAccountHome: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: mocks.open }));
vi.mock("../../src/stores/cliAccountStore", () => ({
  useCliAccountStore: Object.assign((select: (s: typeof mocks.accountState) => unknown) => select(mocks.accountState),
    { getState: () => mocks.accountState }),
}));
vi.mock("../../src/stores/cliLoginStore", async () => {
  const { create } = await import("zustand");
  return { useCliLoginStore: create(() => ({ byProvider: { claude: null, codex: null, grok: null }, startAccountHome: mocks.startHome })) };
});
import { TabAccountSettings, TabAccountSettingsProvider } from "../../src/components/settings/TabAccountSettings";
import { LaunchAccountRow, useLaunchAccounts } from "../../src/components/workspace/LaunchAccountRow";
import { isSetupTokenActive, useClaudeSetupTokenStore } from "../../src/stores/claudeSetupTokenStore";
import type { ClaudeSetupTokenEvent, CliAccountProfile, SwitchableCliProvider } from "../../src/lib/ipc";
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const profile = (provider: SwitchableCliProvider = "claude"): CliAccountProfile => ({
  id: provider + "-fixture", provider, label: "仕事用", email: "fixture@example.test", identity_key: "fixture",
  plan: null, org_name: null, captured_at: "", last_switched_at: null, needs_relogin: false,
});
const registered = { profile_id: "claude-fixture", registered_at: "", expires_at: "2099-01-01T00:00:00Z",
  owner_check: "verified" as const, fingerprint: "fixture" };
function event(state: ClaudeSetupTokenEvent["state"], more = {}): ClaudeSetupTokenEvent {
  return { login_id: "setup-fixture", profile_id: "claude-fixture", state, ...more };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.tokens.mockResolvedValue([]); mocks.homes.mockResolvedValue([]);
  mocks.accounts.mockResolvedValue({ profiles: [profile()] });
  mocks.current.mockResolvedValue(null); mocks.listen.mockResolvedValue(() => {});
  mocks.begin.mockResolvedValue(event("starting")); mocks.cancel.mockResolvedValue(undefined); mocks.submit.mockResolvedValue(undefined);
  mocks.open.mockResolvedValue(undefined); mocks.save.mockResolvedValue(registered); mocks.startHome.mockResolvedValue(undefined);
  useClaudeSetupTokenStore.setState({ registrationOrigins: { claude: null, codex: null, grok: null }, completionOrigin: null, resultFocus: null, homeStartPending: { claude: false, codex: false, grok: false }, completedLoginIds: [] });
  useClaudeSetupTokenStore.setState({ event: null, endedEvents: [], retiredLoginIds: [], pendingProfileId: null, failure: null, failureProfileId: null });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });
function button(text: string) {
  const node = [...host.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === text);
  expect(node, text).toBeDefined(); return node!;
}
async function click(text: string) { await act(async () => button(text).click()); }
async function renderSettings(provider: SwitchableCliProvider = "claude") {
  await act(async () => root.render(<TabAccountSettingsProvider><TabAccountSettings profile={profile(provider)} /></TabAccountSettingsProvider>));
}
async function begin() { await click("タブでも使う"); await click("始める"); }
async function emit(state: ClaudeSetupTokenEvent["state"], more = {}) {
  await act(async () => useClaudeSetupTokenStore.getState().handleEvent(event(state, more)));
}
describe("one-button Claude registration", () => {
  it("confirms the browser account and annual approval before invoking the hidden login", async () => {
    await renderSettings(); await click("タブでも使う");
    expect(host.textContent).toContain("ブラウザで 仕事用 にログインしているか確かめてから承認してください。承認は 1 年に 1 回です。");
    expect(mocks.begin).not.toHaveBeenCalled(); await click("取消");
    expect(mocks.begin).not.toHaveBeenCalled(); await begin();
    expect(mocks.begin).toHaveBeenCalledExactlyOnceWith("claude-fixture");
    expect(host.textContent).toContain("準備しています");
  });
  it("shows approval, fallback URL, code input, owner check, and the refreshed registration", async () => {
    await renderSettings(); await begin(); await emit("waiting_browser", { url: "https://example.test/authorize" });
    expect(host.textContent).toContain("ブラウザで承認してください");
    expect(host.querySelector('input[aria-label="承認コード"]')).toBeNull();
    await emit("code_available", { url: "https://example.test/authorize" });
    expect(host.textContent).toContain("ブラウザが開かないときはこの URL を開いてください");
    await click("URL を開く"); expect(mocks.open).toHaveBeenCalledExactlyOnceWith("https://example.test/authorize");
    expect(host.textContent).toContain("コードが表示されたときだけ、ここに貼ってください");
    const input = host.querySelector<HTMLInputElement>('input[aria-label="承認コード"]')!;
    input.value = "fixture-code#fixture-state";
    await act(async () => input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(mocks.submit).toHaveBeenCalledExactlyOnceWith("setup-fixture", "fixture-code#fixture-state");
    expect(input.value).toBe("");
    await emit("checking_owner"); expect(host.textContent).toContain("持ち主を確かめています");
    mocks.tokens.mockResolvedValue([registered]); await emit("saved", { status: registered });
    expect(host.textContent).toContain("登録済み・期限 2099-01-01・持ち主: 確認済み");
    expect(button("登録し直す")).toBeDefined();
  });
  it("closes the code form during confirmation and ignores delayed code availability", async () => {
    await renderSettings(); await begin(); await emit("code_available");
    const input = host.querySelector<HTMLInputElement>('form input[type="password"]')!;
    input.value = "fixture-code#fixture-state";
    expect(host.querySelector('[role="status"]')?.textContent).toBe("ブラウザで承認してください");
    await emit("confirming");
    expect(isSetupTokenActive(useClaudeSetupTokenStore.getState().event)).toBe(true);
    expect(input.value).toBe("");
    expect(host.querySelector('form input[type="password"]')).toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toBe("登録中…");
    await emit("code_available");
    expect(host.querySelector('form input[type="password"]')).toBeNull();
  });
  it("cancels the active native login and clears the code on unmount", async () => {
    await renderSettings(); await begin(); await emit("code_available");
    const input = host.querySelector<HTMLInputElement>('input[aria-label="承認コード"]')!;
    input.value = "fixture-code#fixture-state"; await click("中止");
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith("setup-fixture");
    await act(async () => root.render(<div />)); expect(input.value).toBe("");
  });
  it.each([
    ["failed", "capture_failed", "取り込めませんでした"],
    ["failed", "cli_error", "承認を続けられませんでした"],
    ["failed", "launch_failed", "Claude Code を起動できませんでした"],
    ["failed", "output_limit", "出力が上限を超えました"],
    ["failed", "save_failed", "保存できませんでした"],
    ["mismatch", "owner_mismatch", "アカウントが一致しません"],
    ["timeout", "timeout", "時間切れ"],
    ["cancelled", "cancelled", "中止しました"],
  ] as const)("explains %s/%s and the next action", async (state, reason, message) => {
    await renderSettings(); await begin(); await emit(state, { reason });
    expect(host.textContent).toContain(message);
    expect(host.textContent).toMatch(/詳しく|もう一度|やり直/);
  });
  it("keeps the existing write-only paste registration inside Details", async () => {
    await renderSettings();
    const details = [...host.querySelectorAll("details")].find(node => node.querySelector("summary")?.textContent === "詳しく")!;
    expect(details).toBeDefined(); expect(details.open).toBe(false);
    details.open = true; await click("登録");
    const input = details.querySelector<HTMLInputElement>('input[type="password"]')!;
    expect(input).not.toBeNull(); expect(details.textContent).toContain("claude setup-token");
    input.value = "manual-fixture-secret"; await click("保存");
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith("claude-fixture", "manual-fixture-secret");
    expect(input.value).toBe("");
  });
  it("uses the new label for expired registrations and existing Codex/Grok actions", async () => {
    mocks.tokens.mockResolvedValue([{ ...registered, expires_at: "2000-01-01T00:00:00Z" }]);
    await renderSettings(); expect(button("タブでも使う")).toBeDefined();
    for (const provider of ["codex", "grok"] as const) {
      await renderSettings(provider); await click("タブでも使う"); expect(mocks.startHome).toHaveBeenCalledWith(provider, provider + "-fixture");
    }
  });
});
function Launcher({ provider }: { provider: SwitchableCliProvider }) {
  const accounts = useLaunchAccounts(provider);
  return <LaunchAccountRow accounts={accounts} ownerKey="launcher:fixture" value="" onChange={vi.fn()} />;
}
describe("registration inside the launcher", () => {
  it("registers Claude in place and reloads choices so the account becomes selectable", async () => {
    await act(async () => root.render(<Launcher provider="claude" />));
    expect(button("仕事用").disabled).toBe(true); await begin();
    await emit("code_available", { url: "https://example.test/authorize" });
    expect(host.querySelector('input[aria-label="承認コード"]')).not.toBeNull();
    mocks.tokens.mockResolvedValue([registered]); await emit("saved", { status: registered });
    expect(button("仕事用").disabled).toBe(false);
  });
  it.each(["codex", "grok"] as const)("uses a keyboard-focusable button for unavailable %s homes", async provider => {
    mocks.accounts.mockResolvedValue({ profiles: [profile(provider)] });
    await act(async () => root.render(<Launcher provider={provider} />));
    const action = button("タブでも使う"); expect(action.disabled).toBe(false); expect(action.tabIndex).toBe(0);
    action.focus(); expect(document.activeElement).toBe(action); await click("タブでも使う");
    expect(mocks.startHome).toHaveBeenCalledExactlyOnceWith(provider, provider + "-fixture");
  });
});
describe("non-secret setup-token store", () => {
  it("ignores delayed events from the previous login after a new login has started", () => {
    const setup = useClaudeSetupTokenStore.getState();
    setup.handleEvent(event("saved", { status: registered }));
    setup.handleEvent({ ...event("starting"), login_id: "new-setup" });
    setup.handleEvent(event("saved", { status: registered }));
    setup.handleEvent(event("code_available", { url: "https://example.test/old" }));
    expect(useClaudeSetupTokenStore.getState().event?.login_id).toBe("new-setup");
    expect(useClaudeSetupTokenStore.getState().event?.state).toBe("starting");
  });

  it("discards unexpected secret fields in both the event and nested public status", () => {
    useClaudeSetupTokenStore.getState().handleEvent({
      ...event("saved"), token: "private-fixture", output: "private-fixture",
      status: { ...registered, token: "private-fixture", transcript: "private-fixture" },
    } as unknown as ClaudeSetupTokenEvent);
    const serialized = JSON.stringify(useClaudeSetupTokenStore.getState());
    expect(serialized).not.toContain("private-fixture");
    expect(useClaudeSetupTokenStore.getState().event?.status).toEqual(registered);
  });

  it("keeps no secret fields and does not regress a streamed result to a late start response", async () => {
    let resolve!: (value: ClaudeSetupTokenEvent) => void;
    mocks.begin.mockImplementation(() => new Promise<ClaudeSetupTokenEvent>(r => { resolve = r; }));
    const pending = useClaudeSetupTokenStore.getState().begin("claude-fixture");
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await emit("saved", { status: registered });
    await act(async () => resolve(event("starting"))); await pending;
    expect(useClaudeSetupTokenStore.getState().event?.state).toBe("saved");
    const state = JSON.stringify(useClaudeSetupTokenStore.getState());
    expect(state).not.toMatch(/"(token|output|buffer|transcript)":/);
    expect(localStorage.length).toBe(0);
  });
  it("prevents repeated starts and shows a safe error when starting fails", async () => {
    mocks.begin.mockRejectedValue(new Error("private-output-must-stay-hidden"));
    await renderSettings(); await click("タブでも使う"); await click("始める");
    expect(host.textContent).toContain("始められませんでした");
    expect(host.textContent).not.toContain("private-output");
  });
});

describe("owner verification cancellation boundary", () => {
  it("hides Cancel while checking the owner", async () => {
    await renderSettings(); await begin(); await emit("checking_owner");
    expect([...host.querySelectorAll("button")].some(node => node.textContent === "中止")).toBe(false);
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
});

describe("setup-token keyboard focus", () => {
  it("moves focus from Begin to the flow, then code, and cycles through Cancel in settings", async () => {
    await renderSettings(); await click("タブでも使う");
    const beginButton = button("始める");
    expect(document.activeElement).toBe(beginButton);
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => { beginButton.dispatchEvent(enter); if (!enter.defaultPrevented) beginButton.click(); });
    const flow = host.querySelector<HTMLElement>("[data-claude-setup-token]")!;
    expect(flow.tabIndex).toBe(-1); expect(document.activeElement).toBe(flow);
    await emit("code_available", { url: "https://example.test/oauth/authorize?state=fixture" });
    const input = host.querySelector<HTMLInputElement>('input[aria-label="承認コード"]')!;
    expect(document.activeElement).toBe(input);
    const tab = async (shiftKey = false) => act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true }));
    });
    await tab(true); expect(document.activeElement).toBe(button("URL を開く"));
    await tab(); expect(document.activeElement).toBe(input);
    await tab(); expect(document.activeElement).toBe(button("コードを送る"));
    await tab(); expect(document.activeElement).toBe(button("中止"));
    const cancel = document.activeElement as HTMLButtonElement;
    await act(async () => {
      const key = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
      cancel.dispatchEvent(key); if (!key.defaultPrevented) cancel.click();
    });
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith("setup-fixture");
    await tab(); expect(document.activeElement).toBe(button("URL を開く"));
  });
});

import { ClaudeSetupTokenFlow } from "../../src/components/settings/ClaudeSetupTokenFlow";
import { setupTokenStrings as S } from "../../src/components/layout/tabAccountStrings";

describe("setup-token retry after a completed registration", () => {
  it.each(["timeout", "cancelled", "failed", "mismatch", "saved"] as const)(
    "keeps the code field, URL, focus, and one saved callback when retrying after %s",
    async previousState => {
      const onSaved = vi.fn();
      await act(async () => root.render(<ClaudeSetupTokenFlow profile={profile()} onSaved={onSaved} />));
      await begin();
      await emit(previousState, previousState === "saved" ? { status: registered } : {});
      await click(S.dismiss); onSaved.mockClear();
      mocks.current.mockResolvedValue(event(previousState));
      mocks.begin.mockResolvedValue(event("starting", { login_id: "retry-fixture" }));
      await begin();
      const url = "https://example.test/oauth/authorize?state=retry";
      await emit("code_available", { login_id: "retry-fixture", url });
      const input = host.querySelector<HTMLInputElement>('input[aria-label="' + S.codeLabel + '"]');
      expect(input).not.toBeNull();
      expect(host.textContent).toContain(url);
      expect(document.activeElement).toBe(input);
      await emit("saved", { login_id: "retry-fixture", status: registered });
      await emit("saved", { login_id: "retry-fixture", status: registered });
      expect(onSaved).toHaveBeenCalledTimes(1);
    },
  );

  it("retires a terminal native snapshot even when the store has no cached event", async () => {
    const onSaved = vi.fn();
    await act(async () => root.render(<ClaudeSetupTokenFlow profile={profile()} onSaved={onSaved} />));
    await begin(); await emit("timeout"); await click(S.dismiss);
    await act(async () => useClaudeSetupTokenStore.setState({ event: null }));
    mocks.current.mockResolvedValue(event("timeout"));
    mocks.begin.mockResolvedValue(event("starting", { login_id: "retry-fixture" }));
    await begin();
    const url = "https://example.test/oauth/authorize?state=snapshot";
    await emit("code_available", { login_id: "retry-fixture", url });
    const input = host.querySelector<HTMLInputElement>('input[aria-label="' + S.codeLabel + '"]');
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    expect(host.textContent).toContain(url);
    await emit("saved", { login_id: "retry-fixture", status: registered });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("keeps ownership when another surface connects to the old timeout during retry preparation", async () => {
    const surfaces = (showPeer: boolean) => <>
      <section data-test-surface="settings"><ClaudeSetupTokenFlow profile={profile()} /></section>
      {showPeer && <section data-test-surface="launcher"><ClaudeSetupTokenFlow profile={profile()} surface="launcher" /></section>}
    </>;
    await act(async () => root.render(surfaces(false)));
    await begin(); await emit("timeout"); await click(S.dismiss);
    let resolveSnapshot!: (value: ClaudeSetupTokenEvent | null) => void;
    mocks.current.mockImplementationOnce(() => new Promise<ClaudeSetupTokenEvent | null>(resolve => { resolveSnapshot = resolve; }));
    mocks.begin.mockResolvedValue(event("starting", { login_id: "retry-fixture" }));
    await begin();
    expect(mocks.begin).toHaveBeenCalledTimes(1);
    mocks.current.mockResolvedValue(event("timeout"));
    await act(async () => root.render(surfaces(true)));
    await act(async () => resolveSnapshot(null));
    await emit("code_available", { login_id: "retry-fixture", url: "https://example.test/oauth/authorize?state=peer" });
    const owner = host.querySelector('[data-test-surface="settings"]')!;
    const peer = host.querySelector('[data-test-surface="launcher"]')!;
    const input = owner.querySelector<HTMLInputElement>('input[aria-label="' + S.codeLabel + '"]');
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    expect(peer.querySelector("input")).toBeNull();
    expect(useClaudeSetupTokenStore.getState().registrationOrigins.claude).toEqual({
      surface: "settings", provider: "claude", profileId: "claude-fixture", ownerKey: "settings", loginId: "retry-fixture",
    });
  });

  it("keeps an active native snapshot instead of regressing to the start response", async () => {
    await act(async () => root.render(<ClaudeSetupTokenFlow profile={profile()} />));
    mocks.current.mockResolvedValue(event("code_available", { url: "https://example.test/oauth/authorize?state=active" }));
    await begin();
    const input = host.querySelector<HTMLInputElement>('input[aria-label="' + S.codeLabel + '"]');
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    expect(useClaudeSetupTokenStore.getState().event?.state).toBe("code_available");
  });
});

describe("setup-token result focus ownership", () => {
  it.each(["cancelled", "timeout", "failed", "mismatch", "saved"] as const)(
    "focuses result dismissal after %s in the owning settings flow",
    async outcome => {
      await act(async () => root.render(<ClaudeSetupTokenFlow profile={profile()} />));
      await begin(); await emit("code_available");
      const input = host.querySelector<HTMLInputElement>('input[aria-label="' + S.codeLabel + '"]')!;
      expect(document.activeElement).toBe(input);
      if (outcome === "cancelled") {
        await act(async () => button(S.cancel).focus());
        await click(S.cancel);
        expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith("setup-fixture");
      }
      await emit(outcome, outcome === "saved" ? { status: registered } : {});
      expect(document.activeElement).toBe(button(S.dismiss));
    },
  );

  it.each(["cancelled", "timeout"] as const)(
    "focuses result dismissal after %s in the owning new-workspace flow",
    async outcome => {
      await act(async () => root.render(<ClaudeSetupTokenFlow profile={profile()} surface="new-workspace" />));
      await begin(); await emit("code_available");
      await emit(outcome);
      expect(document.activeElement).toBe(button(S.dismiss));
    },
  );

  it.each(["cancelled", "timeout"] as const)(
    "does not focus the result of a passive settings flow after %s",
    async outcome => {
      await act(async () => root.render(<ClaudeSetupTokenFlow profile={profile()} />));
      await act(async () => {
        useClaudeSetupTokenStore.getState().startRegistration({ surface: "launcher", provider: "claude", profileId: "claude-fixture", ownerKey: "launcher:fixture" });
        await useClaudeSetupTokenStore.getState().begin("claude-fixture");
      });
      await emit("code_available");
      await act(async () => button(S.cancel).focus());
      await emit(outcome);
      expect(document.activeElement).toBe(document.body);
      expect(document.activeElement).not.toBe(button(S.dismiss));
    },
  );

  it("preserves focus outside the owning flow when its registration times out", async () => {
    await act(async () => root.render(<>
      <ClaudeSetupTokenFlow profile={profile()} />
      <button data-outside-flow type="button">Outside fixture</button>
    </>));
    await begin(); await emit("code_available");
    const outside = host.querySelector<HTMLButtonElement>("[data-outside-flow]")!;
    await act(async () => outside.focus());
    await emit("timeout");
    expect(document.activeElement).toBe(outside);
  });
});

describe("registration binds to its started login", () => {
  it("keeps B ownership when uncached connect A arrives before the begin snapshot A", async () => {
    const onSaved = vi.fn();
    let resolveConnect!: (value: ClaudeSetupTokenEvent | null) => void;
    let resolveSnapshot!: (value: ClaudeSetupTokenEvent | null) => void;
    let resolveStart!: (value: ClaudeSetupTokenEvent) => void;
    mocks.current
      .mockImplementationOnce(() => new Promise(resolve => { resolveConnect = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveSnapshot = resolve; }));
    mocks.begin.mockImplementationOnce(() => new Promise(resolve => { resolveStart = resolve; }));
    await act(async () => root.render(<ClaudeSetupTokenFlow profile={profile()} onSaved={onSaved} />));
    expect(useClaudeSetupTokenStore.getState().event).toBeNull();
    expect(useClaudeSetupTokenStore.getState().retiredLoginIds).toEqual([]);
    await begin();
    expect(mocks.current).toHaveBeenCalledTimes(2);
    const old = event("timeout", { login_id: "old-login" });
    await act(async () => resolveConnect(old));
    await act(async () => resolveSnapshot(old));
    expect(mocks.begin).toHaveBeenCalledTimes(1);
    await act(async () => resolveStart(event("starting", { login_id: "new-login" })));
    const url = "https://example.test/oauth/authorize?state=new-login";
    await emit("code_available", { login_id: "new-login", url });
    const input = host.querySelector<HTMLInputElement>('input[aria-label="' + S.codeLabel + '"]');
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    expect(host.textContent).toContain(url);
    await emit("saved", { login_id: "new-login", status: registered });
    await emit("saved", { login_id: "new-login", status: registered });
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(useClaudeSetupTokenStore.getState().registrationOrigins.claude).toBeNull();
  });

  it.each(["saved", "failed"] as const)("finishes early %s B only after the start response binds B", async outcome => {
    const onSaved = vi.fn();
    let resolveStart!: (value: ClaudeSetupTokenEvent) => void;
    mocks.begin.mockImplementationOnce(() => new Promise(resolve => { resolveStart = resolve; }));
    await act(async () => root.render(<ClaudeSetupTokenFlow profile={profile()} onSaved={onSaved} />));
    await begin();
    await emit(outcome, { login_id: "early-login", ...(outcome === "saved" ? { status: registered } : { reason: "capture_failed" }) });
    expect(onSaved).not.toHaveBeenCalled();
    expect(useClaudeSetupTokenStore.getState().registrationOrigins.claude).not.toBeNull();
    await act(async () => resolveStart(event("starting", { login_id: "early-login" })));
    expect(useClaudeSetupTokenStore.getState().event).toMatchObject({ login_id: "early-login", state: outcome });
    expect(useClaudeSetupTokenStore.getState().pendingProfileId).toBeNull();
    expect(useClaudeSetupTokenStore.getState().registrationOrigins.claude).toBeNull();
    expect(onSaved).toHaveBeenCalledTimes(outcome === "saved" ? 1 : 0);
    expect(button(S.dismiss)).toBeDefined();
    await emit(outcome, { login_id: "early-login" });
    expect(onSaved).toHaveBeenCalledTimes(outcome === "saved" ? 1 : 0);
  });
});


describe("pending registration hides old results", () => {
  it("keeps B intact when connect A finishes before the begin snapshot A", async () => {
    const onSaved = vi.fn();
    let resolveConnect!: (value: ClaudeSetupTokenEvent | null) => void;
    let resolveSnapshot!: (value: ClaudeSetupTokenEvent | null) => void;
    let resolveStart!: (value: ClaudeSetupTokenEvent) => void;
    mocks.current
      .mockImplementationOnce(() => new Promise(resolve => { resolveConnect = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveSnapshot = resolve; }));
    mocks.begin.mockImplementationOnce(() => new Promise(resolve => { resolveStart = resolve; }));
    await act(async () => root.render(<ClaudeSetupTokenFlow profile={profile()} onSaved={onSaved} />));
    await begin();
    const old = event("timeout", { login_id: "old-result" });
    await act(async () => resolveConnect(old));
    expect(useClaudeSetupTokenStore.getState().pendingProfileId).toBe("claude-fixture");
    const staleDismiss = [...host.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === S.dismiss);
    // Exercise the destructive old-result action if the regression makes it visible.
    if (staleDismiss) await act(async () => staleDismiss.click());
    expect.soft(staleDismiss).toBeUndefined();
    await act(async () => resolveSnapshot(old));
    await act(async () => resolveStart(event("starting", { login_id: "pending-B" })));
    const url = "https://example.test/oauth/authorize?state=pending-B";
    await emit("code_available", { login_id: "pending-B", url });
    expect.soft(host.querySelector("input[aria-label='" + S.codeLabel + "']")).not.toBeNull();
    expect.soft(host.textContent).toContain(url);
    await emit("saved", { login_id: "pending-B", status: registered });
    await emit("saved", { login_id: "pending-B", status: registered });
    expect.soft(onSaved).toHaveBeenCalledTimes(1);
  });
});


describe("early completion survives another login", () => {
  it.each(["saved", "failed", "mismatch"] as const)("finishes early %s B after C starts and before B binds", async outcome => {
    const onSaved = vi.fn();
    let resolveStart!: (value: ClaudeSetupTokenEvent) => void;
    mocks.begin.mockImplementationOnce(() => new Promise(resolve => { resolveStart = resolve; }));
    await act(async () => root.render(<ClaudeSetupTokenFlow profile={profile()} onSaved={onSaved} />));
    await begin();
    await emit(outcome, { login_id: "early-B", ...(outcome === "saved" ? { status: registered } : { reason: outcome === "mismatch" ? "owner_mismatch" : "capture_failed" }) });
    expect(onSaved).not.toHaveBeenCalled();
    expect(useClaudeSetupTokenStore.getState().registrationOrigins.claude).not.toBeNull();
    const other = event("starting", { login_id: "foreign-C", profile_id: "claude-other" });
    await act(async () => useClaudeSetupTokenStore.getState().handleEvent(other));
    await act(async () => resolveStart(event("starting", { login_id: "early-B" })));
    expect.soft(useClaudeSetupTokenStore.getState().pendingProfileId).toBeNull();
    expect.soft(useClaudeSetupTokenStore.getState().registrationOrigins.claude).toBeNull();
    expect.soft(useClaudeSetupTokenStore.getState().event).toEqual(other);
    expect.soft(onSaved).toHaveBeenCalledTimes(outcome === "failed" ? 0 : 1);
    if (outcome !== "failed") expect.soft(onSaved).toHaveBeenCalledWith(outcome);
    await emit(outcome, { login_id: "early-B" });
    expect.soft(onSaved).toHaveBeenCalledTimes(outcome === "failed" ? 0 : 1);
    expect.soft(useClaudeSetupTokenStore.getState().event).toEqual(other);
    expect.soft(useClaudeSetupTokenStore.getState().completionOrigin).toBeNull();
  });
  it("keeps only the last sixteen accepted public terminal events", async () => {
    for (let index = 0; index < 18; index++) {
      await emit("failed", { login_id: "history-" + index, reason: "capture_failed", private_payload: "fixture-private-field" });
    }
    await emit("starting", { login_id: "history-active", profile_id: "claude-other" });
    const history = useClaudeSetupTokenStore.getState().endedEvents;
    expect(history).toHaveLength(16);
    expect(history[0].login_id).toBe("history-2");
    expect(history[15]).toEqual(event("failed", { login_id: "history-17", reason: "capture_failed" }));
    expect(JSON.stringify(history)).not.toContain("fixture-private-field");
    await emit("saved", { login_id: "history-17" });
    expect(useClaudeSetupTokenStore.getState().endedEvents).toEqual(history);
  });
});
