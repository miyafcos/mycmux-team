// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  begin: vi.fn(), cancel: vi.fn(), submit: vi.fn(), current: vi.fn(), listen: vi.fn(), open: vi.fn(),
  tokens: vi.fn(), homes: vi.fn(), accounts: vi.fn(), save: vi.fn(), recheck: vi.fn(), startHome: vi.fn(),
  accountListListeners: new Set<(event: { payload: AccountListChange }) => void>(),
  accountListSubscriptionFails: false,
  accountState: { busyByProvider: { claude: null, codex: null, grok: null } },
}));
vi.mock("../../src/lib/ipc", () => ({
  CLI_LOGIN_TIMEOUT_MS: 600000, startClaudeSetupToken: mocks.begin, cancelClaudeSetupToken: mocks.cancel,
  submitClaudeSetupCode: mocks.submit, getClaudeSetupTokenState: mocks.current, onClaudeSetupToken: mocks.listen,
  getCliLaunchTokens: mocks.tokens, listCliAccountHomes: mocks.homes, listCliAccounts: mocks.accounts,
  setCliLaunchToken: mocks.save, removeCliLaunchToken: vi.fn(), recheckCliLaunchToken: mocks.recheck, unregisterCliAccountHome: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: mocks.open }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, notify: (event: { payload: AccountListChange }) => void) => {
    if (name === "tab-account-evidence-updated") {
      if (mocks.accountListSubscriptionFails) throw new Error("fixture: list subscription failed");
      mocks.accountListListeners.add(notify);
    }
    return () => { mocks.accountListListeners.delete(notify); };
  }),
}));
vi.mock("../../src/stores/cliAccountStore", () => ({
  useCliAccountStore: Object.assign((select: (s: typeof mocks.accountState) => unknown) => select(mocks.accountState),
    { getState: () => mocks.accountState }),
}));
vi.mock("../../src/stores/cliLoginStore", async () => {
  const { create } = await import("zustand");
  return { useCliLoginStore: create(() => ({ byProvider: { claude: null, codex: null, grok: null }, startAccountHome: mocks.startHome })) };
});
import { OverlayShell } from "../../src/components/common/OverlayShell";
import type { AccountListChange } from "../../src/lib/tabAccounts";
import { TabAccountSettings, TabAccountSettingsProvider } from "../../src/components/settings/TabAccountSettings";
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
  mocks.accountListSubscriptionFails = false;
  mocks.tokens.mockReset().mockResolvedValue([]); mocks.homes.mockReset().mockResolvedValue([]);
  mocks.accounts.mockResolvedValue({ profiles: [profile()] });
  mocks.current.mockResolvedValue(null); mocks.listen.mockResolvedValue(() => {});
  mocks.begin.mockResolvedValue(event("starting")); mocks.cancel.mockResolvedValue(undefined); mocks.submit.mockResolvedValue(undefined);
  mocks.open.mockResolvedValue(undefined); mocks.save.mockReset().mockResolvedValue(registered); mocks.recheck.mockReset().mockResolvedValue(registered); mocks.startHome.mockResolvedValue(true);
  useClaudeSetupTokenStore.setState({ event: null, browserOpenFailed: false, codeSubmission: null, retiredLoginIds: [], pendingProfileId: null, failure: null, failureProfileId: null });
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
async function begin() { await click("タブ用に登録"); await click("始める"); }
async function emit(state: ClaudeSetupTokenEvent["state"], more = {}) {
  await act(async () => useClaudeSetupTokenStore.getState().handleEvent(event(state, more)));
}
async function notifyAccountListChanged() {
  const { login_id, profile_id } = event("starting");
  await act(async () => {
    for (const notify of mocks.accountListListeners) notify({ payload: { profile_id, claude_setup_login_id: login_id } });
  });
}
describe("one-button Claude registration", () => {
  it("opens the approved URL once even when management closes before the start response", async () => {
    const url = "https://claude.ai/oauth/authorize?state=fixture";
    let started!: (value: ClaudeSetupTokenEvent) => void;
    mocks.begin.mockReturnValueOnce(new Promise(resolve => { started = resolve; }));
    await renderSettings();
    await begin();
    await act(async () => root.render(null));
    await emit("code_available", { url });
    await act(async () => started(event("starting")));
    await emit("code_available", { url });
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith(url);
    await renderSettings();
    expect(host.querySelector('input[aria-label="承認コード"]')).not.toBeNull();
  });

  it("confirms the browser account and annual approval before invoking the hidden login", async () => {
    await renderSettings(); await click("タブ用に登録");
    expect(host.textContent).toContain("ブラウザで 仕事用 にログインしているか確かめてから承認してください。承認は 1 年に 1 回です。");
    expect(host.textContent).toContain("OS の既定のブラウザで承認ページを開きます。");
    expect(mocks.begin).not.toHaveBeenCalled(); await click("取消");
    expect(mocks.begin).not.toHaveBeenCalled(); await begin();
    expect(mocks.begin).toHaveBeenCalledExactlyOnceWith("claude-fixture");
    expect(host.textContent).toContain("準備しています");
  });
  it("shows approval, fallback URL, code input, owner check, and the refreshed registration", async () => {
    await renderSettings(); await begin(); await emit("waiting_browser", { url: "https://claude.ai/oauth/authorize?state=fixture" });
    expect(host.textContent).toContain("ブラウザで承認してください");
    expect(host.querySelector('input[aria-label="承認コード"]')).toBeNull();
    await emit("code_available", { url: "https://claude.ai/oauth/authorize?state=fixture" });
    expect(host.textContent).toContain("ブラウザが開かないときはこの URL を開いてください");
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith("https://claude.ai/oauth/authorize?state=fixture");
    await click("URL を開く"); expect(mocks.open).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("コードが表示されたときだけ、ここに貼ってください");
    const input = host.querySelector<HTMLInputElement>('input[aria-label="承認コード"]')!;
    input.value = "fixture-code#fixture-state";
    await act(async () => input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(mocks.submit).toHaveBeenCalledExactlyOnceWith("setup-fixture", "fixture-code#fixture-state");
    expect(input.value).toBe("");
    await emit("checking_owner"); expect(host.textContent).toContain("持ち主を確かめています");
    mocks.tokens.mockResolvedValue([registered]);
    await notifyAccountListChanged();
    await emit("saved", { status: registered });
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
    await emit("code_available", { reason: "code_reopened", url: "https://claude.ai/oauth/authorize?state=fixture" });
    const reopened = host.querySelector<HTMLInputElement>('form input[type="password"]')!;
    expect(reopened.disabled).toBe(false);
    reopened.value = "fixture-code#fixture-state";
    await act(async () => {
      reopened.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      reopened.value = "duplicate#fixture-state";
      reopened.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await emit("confirming");
    await emit("code_available", { reason: "code_reopened" });
    expect(host.querySelector<HTMLInputElement>('form input[type="password"]')?.disabled).toBe(true);
    expect(mocks.submit).toHaveBeenCalledExactlyOnceWith("setup-fixture", "fixture-code#fixture-state");
    await emit("checking_owner");
    await emit("code_available", { reason: "code_reopened" });
    expect(host.querySelector('form input[type="password"]')).toBeNull();
  });
  it.each(["unverified", "org_matched", "org_shared"] as const)(
    "shows that the owner is unverified after first registration with %s",
    async owner_check => {
      await renderSettings(); await begin();
      const status = { ...registered, owner_check };
      mocks.tokens.mockResolvedValue([status]);
      await notifyAccountListChanged();
      await emit("saved", { status });
      expect(host.textContent).toContain("トークンの持ち主は未確認です。");
      expect(host.textContent).toContain("登録済み・期限 2099-01-01");
    },
  );
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
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith("claude-fixture", "manual-fixture-secret",
      expect.stringMatching(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/));
    expect(input.value).toBe("");
  });
  it("uses the new label for expired registrations and existing Codex/Grok actions", async () => {
    mocks.tokens.mockResolvedValue([{ ...registered, expires_at: "2000-01-01T00:00:00Z" }]);
    await renderSettings(); expect(button("登録し直す")).toBeDefined();
    for (const provider of ["codex", "grok"] as const) {
      await renderSettings(provider); await click("タブ用に登録"); expect(mocks.startHome).toHaveBeenCalledWith(provider, provider + "-fixture");
    }
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
    await vi.waitFor(() => expect(mocks.begin).toHaveBeenCalledOnce());
    await emit("saved", { status: registered });
    await act(async () => resolve(event("starting"))); await pending;
    expect(useClaudeSetupTokenStore.getState().event?.state).toBe("saved");
    const state = JSON.stringify(useClaudeSetupTokenStore.getState());
    expect(state).not.toMatch(/"(token|output|buffer|transcript)":/);
    expect(localStorage.length).toBe(0);
  });
  it("prevents repeated starts and shows a safe error when starting fails", async () => {
    mocks.begin.mockRejectedValue(new Error("private-output-must-stay-hidden"));
    await renderSettings(); await click("タブ用に登録"); await click("始める");
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
    await renderSettings(); await click("タブ用に登録");
    const beginButton = button("始める");
    expect(document.activeElement).toBe(beginButton);
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => { beginButton.dispatchEvent(enter); if (!enter.defaultPrevented) beginButton.click(); });
    const flow = host.querySelector<HTMLElement>("[data-claude-setup-token]")!;
    expect(flow.tabIndex).toBe(-1); expect(document.activeElement).toBe(flow);
    await emit("code_available", { url: "https://claude.ai/oauth/authorize?state=fixture" });
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

function managementFlow() {
  return <TabAccountSettingsProvider>
    <ClaudeSetupTokenFlow profile={profile()} registered={false} continueRegistration={false} disabled={false} />
  </TabAccountSettingsProvider>;
}

describe("setup-token retries in account management", () => {
  const retryCases = (["timeout", "cancelled", "failed", "mismatch", "saved"] as const)
    .flatMap(outcome => [true, false].map(dismiss => ({ outcome, dismiss })));
  it.each(retryCases)(
    "keeps the new code field and approval when retrying $outcome with dismiss=$dismiss", async ({ outcome, dismiss }) => {
      await act(async () => root.render(managementFlow()));
      mocks.tokens.mockClear();
      mocks.homes.mockClear();
      await begin();
      await emit(outcome, outcome === "saved" ? { status: registered } : {});
      const completed = outcome === "saved" || outcome === "mismatch" ? 1 : 0;
      expect(mocks.tokens).toHaveBeenCalledTimes(completed);
      expect(mocks.homes).toHaveBeenCalledTimes(completed);
      if (dismiss) {
        await click(S.dismiss);
        expect([...host.querySelectorAll("button")].some(node => node.textContent === S.dismiss)).toBe(false);
      } else {
        expect(button(S.dismiss)).toBeDefined();
      }
      mocks.current.mockResolvedValue(event(outcome));
      mocks.begin.mockResolvedValue(event("starting", { login_id: "retry-fixture" }));
      await begin();
      const url = "https://claude.ai/oauth/authorize?state=retry-fixture";
      await emit("code_available", { login_id: "retry-fixture", url });
      await emit("timeout");
      expect(document.activeElement).toBe(host.querySelector('input[aria-label="承認コード"]'));
      expect(host.textContent).toContain(url);
      expect(mocks.open).toHaveBeenCalledExactlyOnceWith(url);
      await emit("saved", { login_id: "retry-fixture", status: registered });
      await emit("saved", { login_id: "retry-fixture", status: registered });
      expect(mocks.tokens).toHaveBeenCalledTimes(completed + 1);
      expect(mocks.homes).toHaveBeenCalledTimes(completed + 1);
    },
  );
  it("resumes the same native registration without attempting a rejected second start", async () => {
    await act(async () => root.render(managementFlow()));
    mocks.current.mockResolvedValue(event("code_available", { url: "https://claude.ai/oauth/authorize?state=active" }));
    mocks.begin.mockRejectedValue(new Error("fixture registration already running"));
    await begin();
    const code = host.querySelector('input[aria-label="承認コード"]');
    expect(code).not.toBeNull();
    expect(document.activeElement).toBe(code);
    expect(host.textContent).not.toContain("始められませんでした");
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(useClaudeSetupTokenStore.getState()).toMatchObject({
      event: { state: "code_available", login_id: "setup-fixture" }, pendingProfileId: null,
    });
  });
  it("opens the first approval URL once after explicitly resuming a starting registration", async () => {
    await act(async () => root.render(managementFlow()));
    mocks.current.mockResolvedValue(event("starting", { login_id: "already-starting-fixture" }));
    await click(S.useInTab);
    expect(host.textContent).toContain(S.approvalBrowser);
    expect(mocks.open).not.toHaveBeenCalled();
    await click(S.begin);
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();

    const url = "https://claude.ai/oauth/authorize?state=already-starting";
    await emit("waiting_browser", { login_id: "already-starting-fixture", url });
    await emit("code_available", { login_id: "already-starting-fixture", url });
    expect(host.textContent).toContain(url);
    expect(document.activeElement).toBe(host.querySelector('input[aria-label="承認コード"]'));
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith(url);
  });
  it("keeps the old timeout out when a management read and a new start overlap", async () => {
    let finishOpen!: (value: ClaudeSetupTokenEvent) => void;
    let finishSnapshot!: (value: ClaudeSetupTokenEvent) => void;
    let finishStart!: (value: ClaudeSetupTokenEvent) => void;
    mocks.current.mockImplementationOnce(() => new Promise(resolve => { finishOpen = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { finishSnapshot = resolve; }));
    mocks.begin.mockImplementationOnce(() => new Promise(resolve => { finishStart = resolve; }));
    await act(async () => root.render(managementFlow()));
    await begin();
    const old = event("timeout", { login_id: "old-fixture" });
    await act(async () => finishOpen(old));
    expect(host.textContent).not.toContain("時間切れ");
    expect([...host.querySelectorAll("button")].some(node => node.textContent === S.dismiss)).toBe(false);
    await act(async () => finishSnapshot(old));
    await act(async () => finishStart(event("starting", { login_id: "new-fixture" })));
    const url = "https://claude.ai/oauth/authorize?state=new-fixture";
    await emit("code_available", { login_id: "new-fixture", url });
    expect(document.activeElement).toBe(host.querySelector('input[aria-label="承認コード"]'));
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith(url);
  });
  it("does not open or show a URL from an unapproved origin", async () => {
    await renderSettings();
    await begin();
    const url = "https://claude.ai.example.test/oauth/authorize?state=fixture";
    await emit("code_available", { url });
    expect(mocks.open).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain(url);
    expect(host.querySelector('input[aria-label="承認コード"]')).not.toBeNull();
  });
});

describe("setup-token result focus inside management", () => {
  it.each(["cancelled", "timeout", "failed", "mismatch", "saved"] as const)(
    "focuses result dismissal after %s in the owning settings flow", async outcome => {
      await act(async () => root.render(managementFlow()));
      await begin();
      await emit("code_available");
      expect(document.activeElement).toBe(host.querySelector('input[aria-label="承認コード"]'));
      if (outcome === "cancelled") {
        await act(async () => button(S.cancel).focus());
        await click(S.cancel);
        expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith("setup-fixture");
      }
      await emit(outcome, outcome === "saved" ? { status: registered } : {});
      expect(document.activeElement).toBe(button(S.dismiss));
    },
  );
  it("preserves focus outside the owning flow when its registration times out", async () => {
    await act(async () => root.render(<>{managementFlow()}<button type="button">Outside fixture</button></>));
    await begin();
    await emit("code_available");
    const outside = button("Outside fixture");
    await act(async () => outside.focus());
    await emit("timeout");
    expect(document.activeElement).toBe(outside);
  });
  it("changes an open management row from registered to expired", async () => {
    vi.useFakeTimers();
    mocks.tokens.mockResolvedValue([{ ...registered, expires_at: new Date(Date.now() + 1000).toISOString() }]);
    await renderSettings();
    expect(host.textContent).toContain("登録済み");
    await act(async () => vi.advanceTimersByTimeAsync(1001));
    expect(host.textContent).toContain("期限切れ");
    expect(button("登録し直す")).toBeDefined();
  });
});

describe("Claude registration readback in account management", () => {
  it.each(["saved", "mismatch"] as const)("reads saved lists after %s even when the list subscription fails", async outcome => {
    mocks.accountListSubscriptionFails = true;
    await renderSettings();
    expect(mocks.accountListListeners.size).toBe(0);
    expect(mocks.tokens).toHaveBeenCalledTimes(1);
    expect(mocks.homes).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("未登録");
    await begin();
    await emit("code_available");
    mocks.tokens.mockClear();
    mocks.homes.mockClear();

    const status = { ...registered, owner_check: outcome === "saved" ? "verified" as const : "mismatch" as const };
    mocks.tokens.mockResolvedValue([status]);
    await emit(outcome, { status });
    await emit(outcome, { status });
    expect(mocks.tokens).toHaveBeenCalledTimes(1);
    expect(mocks.homes).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain(outcome === "saved" ? "登録済み・期限" : "不一致・期限");
  });

  it.each(["saved", "mismatch"] as const)("reads both registration lists once for the native notification and %s result", async outcome => {
    await renderSettings();
    await begin();
    await emit("code_available");
    mocks.tokens.mockClear();
    mocks.homes.mockClear();

    const status = { ...registered, owner_check: outcome === "saved" ? "verified" as const : "mismatch" as const };
    mocks.tokens.mockResolvedValue([status]);
    await notifyAccountListChanged();
    await emit(outcome, { status });
    await emit(outcome, { status });
    await notifyAccountListChanged();
    expect(mocks.tokens).toHaveBeenCalledTimes(1);
    expect(mocks.homes).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain(outcome === "saved" ? "登録済み・期限" : "不一致・期限");
  });

  it.each(["saved", "mismatch"] as const)("reads each registration list once when management reopens after %s", async outcome => {
    await renderSettings();
    await begin();
    await emit("code_available");
    mocks.tokens.mockClear();
    mocks.homes.mockClear();
    if (outcome === "saved") {
      mocks.tokens.mockResolvedValue([registered]);
      await notifyAccountListChanged();
    }
    await emit(outcome, outcome === "saved" ? { status: registered } : { reason: "owner_mismatch" });
    expect(mocks.tokens).toHaveBeenCalledTimes(1);
    expect(mocks.homes).toHaveBeenCalledTimes(1);
    await click(S.dismiss);
    await act(async () => root.render(null));
    mocks.current.mockResolvedValue(event(outcome));
    mocks.tokens.mockClear();
    mocks.homes.mockClear();
    await renderSettings();
    expect(mocks.tokens).toHaveBeenCalledTimes(1);
    expect(mocks.homes).toHaveBeenCalledTimes(1);
  });

  it.each(["saved", "failed", "mismatch"] as const)("preserves a newer login C after early %s from B and a late B start response", async outcome => {
    let resolveB!: (result: ClaudeSetupTokenEvent) => void;
    mocks.begin.mockImplementationOnce(() => new Promise(resolve => { resolveB = resolve; }));
    await act(async () => root.render(managementFlow()));
    mocks.tokens.mockClear();
    mocks.homes.mockClear();
    await begin();
    const b = { login_id: "login-b", ...(outcome === "saved" ? { status: registered } : {}) };
    await emit(outcome, b);
    const c = event("code_available", { login_id: "login-c", profile_id: "claude-other" });
    await act(async () => useClaudeSetupTokenStore.getState().handleEvent(c));
    await act(async () => resolveB(event("starting", { login_id: "login-b" })));
    await emit(outcome, b);
    expect(useClaudeSetupTokenStore.getState()).toMatchObject({ event: c, pendingProfileId: null });
    expect(mocks.tokens).toHaveBeenCalledTimes(outcome === "failed" ? 0 : 1);
    expect(mocks.homes).toHaveBeenCalledTimes(outcome === "failed" ? 0 : 1);
    expect(host.querySelector('input[aria-label="承認コード"]')).toBeNull();
  });

  it.each(["saved", "failed"] as const)("keeps an early %s result actionable once its start response arrives", async outcome => {
    let resolveStart!: (result: ClaudeSetupTokenEvent) => void;
    mocks.begin.mockImplementationOnce(() => new Promise(resolve => { resolveStart = resolve; }));
    await act(async () => root.render(managementFlow()));
    mocks.tokens.mockClear();
    mocks.homes.mockClear();
    await begin();
    await emit(outcome, outcome === "saved" ? { status: registered } : {});
    await act(async () => resolveStart(event("starting")));
    expect(useClaudeSetupTokenStore.getState()).toMatchObject({ event: { state: outcome }, pendingProfileId: null });
    await click(S.dismiss);
    expect([...host.querySelectorAll("button")].some(node => node.textContent === S.dismiss)).toBe(false);
    await emit(outcome);
    expect(mocks.tokens).toHaveBeenCalledTimes(outcome === "saved" ? 1 : 0);
    expect(mocks.homes).toHaveBeenCalledTimes(outcome === "saved" ? 1 : 0);
  });

  it("closes the actual management overlay with Escape while the code field is focused and resumes the same login", async () => {
    host.dataset.cmuxThemedRoot = "true";
    function Management() {
      const [opened, setOpened] = useState(true);
      return <>
        <button type="button" onClick={() => setOpened(true)}>Open management</button>
        {opened && <OverlayShell open ariaLabel="Account management" onClose={() => setOpened(false)}>
          {managementFlow()}
        </OverlayShell>}
      </>;
    }
    await act(async () => root.render(<Management />));
    await begin();
    const url = "https://claude.ai/oauth/authorize?state=escape-fixture";
    await emit("code_available", { url });
    const code = host.querySelector<HTMLInputElement>('input[aria-label="承認コード"]')!;
    expect(document.activeElement).toBe(code);
    await act(async () => code.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.cancel).not.toHaveBeenCalled();
    await click("Open management");
    expect(host.querySelector('input[aria-label="承認コード"]')).not.toBeNull();
    expect(host.textContent).toContain(url);
    expect(useClaudeSetupTokenStore.getState().event?.login_id).toBe("setup-fixture");
    expect(mocks.begin).toHaveBeenCalledTimes(1);
  });
});

describe("L12b FIX5 management registration readback", () => {
  it.each((["saved", "mismatch"] as const).flatMap(outcome =>
    (["progress lookup first", "row absent"] as const).map(order => ({ outcome, order })),
  ))("reads $outcome once with $order", async ({ outcome, order }) => {
    let finishLookup!: (result: ClaudeSetupTokenEvent) => void;
    if (order === "progress lookup first") {
      mocks.current.mockImplementationOnce(() => new Promise(resolve => { finishLookup = resolve; }));
    }
    await renderSettings();
    expect(host.textContent).toContain("未登録");
    if (order === "row absent") {
      await begin();
      await emit("code_available");
      await act(async () => root.render(<TabAccountSettingsProvider>{null}</TabAccountSettingsProvider>));
    }
    expect(mocks.tokens).toHaveBeenCalledTimes(1);
    expect(mocks.homes).toHaveBeenCalledTimes(1);
    mocks.tokens.mockClear();
    mocks.homes.mockClear();
    const status = { ...registered, owner_check: outcome === "saved" ? "verified" as const : "mismatch" as const };
    mocks.tokens.mockResolvedValue([status]);
    if (order === "progress lookup first") {
      await act(async () => finishLookup(event(outcome, { status })));
      await notifyAccountListChanged();
    } else {
      await notifyAccountListChanged();
      await emit(outcome, { status });
      await renderSettings();
    }
    expect(mocks.tokens).toHaveBeenCalledTimes(1);
    expect(mocks.homes).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain(outcome === "saved" ? "登録済み・期限" : "不一致・期限");
  });



  it("shares a pending completion read with the matching native notification", async () => {
    await renderSettings();
    mocks.tokens.mockClear();
    mocks.homes.mockClear();
    let finishRead!: (value: typeof registered[]) => void;
    mocks.tokens.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
    await emit("saved", { status: registered });
    await notifyAccountListChanged();
    expect(mocks.tokens).toHaveBeenCalledTimes(1);
    expect(mocks.homes).toHaveBeenCalledTimes(1);
    await act(async () => finishRead([registered]));
    expect(host.textContent).toContain("登録済み・期限");
  });

  it("reads the registration again when a distinct update interrupted its first read", async () => {
    await renderSettings();
    await begin();
    await emit("code_available");
    mocks.tokens.mockClear();
    mocks.homes.mockClear();
    let finishAborted!: (value: typeof registered[]) => void;
    mocks.tokens.mockImplementationOnce(() => new Promise(resolve => { finishAborted = resolve; }));
    await emit("saved", { status: registered });
    expect(finishAborted).toBeDefined();
    // A separate reload starts while the first fetch is held, and also fails.
    mocks.tokens.mockRejectedValueOnce(new Error("fixture: interrupted read"));
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(mocks.tokens).toHaveBeenCalledTimes(2);
    mocks.tokens.mockResolvedValue([registered]);
    await notifyAccountListChanged();
    await act(async () => finishAborted([]));
    expect(mocks.tokens).toHaveBeenCalledTimes(3);
    expect(mocks.homes).toHaveBeenCalledTimes(3);
    expect(host.textContent).toContain("登録済み・期限");
  });

  it("observes Claude completion when the provider mounts without a row", async () => {
    let finishLookup!: (result: ClaudeSetupTokenEvent) => void;
    mocks.current.mockImplementationOnce(() => new Promise(resolve => { finishLookup = resolve; }));
    await act(async () => root.render(<TabAccountSettingsProvider>{null}</TabAccountSettingsProvider>));
    expect(mocks.tokens).toHaveBeenCalledTimes(1);
    mocks.tokens.mockResolvedValue([registered]);
    expect(finishLookup).toBeTypeOf("function");
    await act(async () => finishLookup(event("saved", { status: registered })));
    expect(mocks.tokens).toHaveBeenCalledTimes(2);
    await renderSettings();
    expect(host.textContent).toContain("登録済み・期限");
    expect(mocks.tokens).toHaveBeenCalledTimes(2);
  });

  it.each((["saved", "mismatch"] as const).flatMap(outcome =>
    (["tokens", "homes"] as const).flatMap(list =>
      (["terminal", "notification"] as const).map(source => ({ outcome, list, source })),
    ),
  ))("reads setup $outcome again after $list fails and $source arrives", async ({ outcome, list, source }) => {
    await renderSettings();
    await begin();
    await emit("checking_owner");
    const status = { ...registered, owner_check: outcome === "saved" ? "verified" as const : "mismatch" as const };
    const terminal = () => emit(outcome, { status });
    mocks.tokens.mockResolvedValue([status]);
    if (source === "terminal") await notifyAccountListChanged();
    else await terminal();
    expect(host.textContent).toContain(outcome === "saved" ? "登録済み・期限" : "不一致・期限");
    mocks.tokens.mockClear();
    mocks.homes.mockClear();

    mocks[list].mockRejectedValueOnce(new Error("fixture: foreground list read failed"));
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(mocks.tokens).toHaveBeenCalledTimes(1);
    expect(mocks.homes).toHaveBeenCalledTimes(1);

    if (source === "notification") {
      mocks[list].mockRejectedValueOnce(new Error("fixture: list still unavailable"));
      await notifyAccountListChanged();
      expect(mocks[list]).toHaveBeenCalledTimes(2);
      await notifyAccountListChanged();
    } else {
      await terminal();
      expect(mocks[list]).toHaveBeenCalledTimes(2);
    }
    const reads = source === "notification" ? 3 : 2;
    expect(mocks.tokens).toHaveBeenCalledTimes(reads);
    expect(mocks.homes).toHaveBeenCalledTimes(reads);
    expect(host.textContent).toContain(outcome === "saved" ? "登録済み・期限" : "不一致・期限");
    expect(host.textContent).not.toContain("タブ用の登録を読み取れませんでした");
    await notifyAccountListChanged();
    expect(mocks.tokens).toHaveBeenCalledTimes(reads);
    expect(mocks.homes).toHaveBeenCalledTimes(reads);
  });
});

const tokenWrites = ["paste succeeds", "paste records mismatch", "recheck"] as const;
type TokenWriteOperation = typeof tokenWrites[number];
const recordedMismatch = "cli_account.error.launch_token_owner_mismatch";

async function beginTokenWrite(operation: TokenWriteOperation, notificationSent = true) {
  const paste = operation !== "recheck";
  const mismatch = operation !== "paste succeeds";
  const status = { ...registered, owner_check: mismatch ? "mismatch" as const : "verified" as const };
  if (mismatch) mocks.tokens.mockResolvedValue([registered]);
  await renderSettings();
  if (paste) {
    const details = host.querySelector("details")!;
    details.open = true;
    await click("登録");
    details.querySelector<HTMLInputElement>('input[type="password"]')!.value = "manual-fixture-value";
  }
  const command = paste ? mocks.save : mocks.recheck;
  let reply!: () => void;
  let writeId: string | undefined;
  command.mockImplementationOnce((profileId: string, ...args: string[]) => new Promise((resolve, reject) => {
    expect(profileId).toBe(registered.profile_id);
    writeId = args[paste ? 1 : 0];
    reply = () => {
      if (operation === "paste records mismatch") reject(recordedMismatch);
      else resolve({ ...status, notification_sent: notificationSent });
    };
  }));
  mocks.tokens.mockClear();
  mocks.homes.mockClear();
  await click(paste ? "保存" : "確かめ直す");
  expect(command).toHaveBeenCalledTimes(1);
  // Native commits before emitting the list notice and settling the command.
  mocks.tokens.mockResolvedValue([status]);
  const notice = (related = true) => act(async () => {
    const payload = {
      profile_id: registered.profile_id,
      ...(related && writeId ? { claude_token_write_id: writeId } : {}),
    };
    for (const listener of mocks.accountListListeners) listener({ payload });
  });
  return { reply: () => act(async () => reply()), notice, status };
}

function expectTokenWriteDisplay(operation: TokenWriteOperation) {
  expect(host.textContent).toContain(operation === "paste succeeds" ? "登録済み・期限" : "不一致・期限");
  expect(host.textContent).not.toContain("タブ用の登録を読み取れませんでした");
  const alerts = [...host.querySelectorAll('[role="alert"]')].map(alert => alert.textContent);
  if (operation === "paste records mismatch") expect(alerts.join(" ")).toContain("長期トークンは選択したアカウントのものではありません");
  else expect(alerts).toEqual([]);
}

describe("L12b FIX6 Claude manual updates", () => {
  it.each(tokenWrites.flatMap(operation =>
    (["notice first", "reply first", "notice send failed", "subscription failed", "separate change"] as const)
      .map(order => ({ operation, order })),
  ))("shares a token write read for $operation with $order", async ({ operation, order }) => {
    mocks.accountListSubscriptionFails = order === "subscription failed";
    const write = await beginTokenWrite(operation, order !== "notice send failed");
    if (order === "notice first" || order === "separate change" || order === "subscription failed") await write.notice();
    await write.reply();
    if (order === "reply first") await write.notice();
    expectTokenWriteDisplay(operation);
    expect(mocks.tokens).toHaveBeenCalledTimes(1);
    expect(mocks.homes).toHaveBeenCalledTimes(1);
    if (order === "separate change") {
      const next = operation === "paste succeeds" ? { ...registered, owner_check: "mismatch" } : registered;
      mocks.tokens.mockResolvedValue([next]);
      await write.notice(false);
      expect(mocks.tokens).toHaveBeenCalledTimes(2);
      expect(mocks.homes).toHaveBeenCalledTimes(2);
      expect(host.textContent).toContain(operation === "paste succeeds" ? "不一致・期限" : "登録済み・期限");
    }
  });

  it.each(tokenWrites.flatMap(operation =>
    (["notice first", "reply first", "reply during read", "both reads fail"] as const)
      .map(order => ({ operation, order })),
  ))("retries a failed token write read for $operation with $order", async ({ operation, order }) => {
    const write = await beginTokenWrite(operation);
    const list = order === "reply first" ? mocks.homes : mocks.tokens;
    let failRead!: (error: Error) => void;
    list.mockImplementationOnce(() => new Promise((_resolve, reject) => { failRead = reject; }));
    const replyFirst = order === "reply first";
    await (replyFirst ? write.reply() : write.notice());
    expect(failRead).toBeTypeOf("function");
    const second = replyFirst ? write.notice : write.reply;
    if (order === "reply during read") await second();
    if (order === "both reads fail") {
      list.mockRejectedValueOnce(new Error("fixture: token write list still unavailable"));
    }
    await act(async () => failRead(new Error("fixture: token write list unavailable")));
    if (order !== "reply during read") await second();
    expect(mocks.tokens).toHaveBeenCalledTimes(2);
    expect(mocks.homes).toHaveBeenCalledTimes(2);
    if (order === "both reads fail") {
      expect(host.textContent).toContain("タブ用の登録を読み取れませんでした");
      await write.notice(false);
      expect(mocks.tokens).toHaveBeenCalledTimes(3);
      expect(mocks.homes).toHaveBeenCalledTimes(3);
    }
    expectTokenWriteDisplay(operation);
  });

  it("keeps unrelated changes for the same profile when the write and notice cross", async () => {
    const write = await beginTokenWrite("paste records mismatch");
    await write.reply();
    expectTokenWriteDisplay("paste records mismatch");
    mocks.tokens.mockResolvedValue([registered]);
    await write.notice(false);
    expect(host.textContent).toContain("登録済み・期限");
    await write.notice();
    expect(mocks.tokens).toHaveBeenCalledTimes(2);
    expect(mocks.homes).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("登録済み・期限");
  });
});
