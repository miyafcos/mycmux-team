// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tokens: vi.fn(), save: vi.fn(), recheck: vi.fn(), remove: vi.fn(), homes: vi.fn(), unregister: vi.fn(),
  confirm: vi.fn(), start: vi.fn(), accountState: { busyByProvider: { claude: null, codex: null, grok: null } },
}));
vi.mock("../../src/lib/appConfirmation", () => ({ confirm: mocks.confirm }));
vi.mock("../../src/lib/ipc", () => ({
  CLI_LOGIN_TIMEOUT_MS: 600_000, getCliLaunchTokens: mocks.tokens, setCliLaunchToken: mocks.save,
  removeCliLaunchToken: mocks.remove, recheckCliLaunchToken: mocks.recheck, listCliAccountHomes: mocks.homes, unregisterCliAccountHome: mocks.unregister,
}));
vi.mock("../../src/stores/cliAccountStore", () => ({
  useCliAccountStore: Object.assign((select: (s: typeof mocks.accountState) => unknown) => select(mocks.accountState),
    { getState: () => mocks.accountState, setState: vi.fn() }),
}));
vi.mock("../../src/stores/cliLoginStore", async () => {
  const { create } = await import("zustand");
  return { useCliLoginStore: create(() => ({ byProvider: { claude: null, codex: null, grok: null }, startAccountHome: mocks.start })) };
});

import { TabAccountSettings, TabAccountSettingsProvider } from "../../src/components/settings/TabAccountSettings";
import { useCliLoginStore } from "../../src/stores/cliLoginStore";
import { useCliAccountStore } from "../../src/stores/cliAccountStore";
import { cliAccountMessage } from "../../src/lib/cliAccounts";
import { launcherStrings } from "../../src/components/workspace/launcherStrings";
import type { CliAccountProfile, CliProvider } from "../../src/lib/ipc";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const profile = (provider: CliProvider): CliAccountProfile => ({
  id: provider + "-fixture", provider, label: "仕事用", email: "fixture@example.test", identity_key: "fixture",
  plan: null, org_name: null, captured_at: "", last_switched_at: null, needs_relogin: false,
});
const registered = {
  profile_id: "claude-fixture", registered_at: "2026-01-01T00:00:00Z", expires_at: "2027-01-01T00:00:00Z",
  owner_check: "verified", fingerprint: "non-secret-fixture",
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.tokens.mockResolvedValue([]);
  mocks.homes.mockResolvedValue([]);
  mocks.save.mockResolvedValue(registered);
  mocks.recheck.mockResolvedValue(registered);
  mocks.remove.mockResolvedValue(undefined);
  mocks.unregister.mockResolvedValue(undefined);
  mocks.confirm.mockResolvedValue(true);
  mocks.start.mockResolvedValue(undefined);
  useCliLoginStore.setState({ byProvider: { claude: null, codex: null, grok: null } });
  localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });
async function render(provider: CliProvider = "claude") {
  await act(async () => root.render(<TabAccountSettingsProvider><TabAccountSettings profile={profile(provider)} /></TabAccountSettingsProvider>));
}
function button(text: string): HTMLButtonElement {
  const node = [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === text);
  expect(node, text).toBeDefined();
  return node!;
}
async function click(text: string) { await act(async () => button(text).click()); }
async function editor(secret: string) {
  await click("登録");
  const input = host.querySelector<HTMLInputElement>('input[type="password"]')!;
  input.value = secret;
  return input;
}

describe("S-1 write-only Claude token paste", () => {
  it("explains external setup-token, shows the restrictions, and uses a password input", async () => {
    await render();
    expect(host.textContent).toContain("未登録");
    const input = await editor("fixture-secret");
    expect(input.autocomplete).toBe("off");
    expect(input.getAttribute("spellcheck")).toBe("false");
    expect(host.textContent).toContain("mycmux の外のターミナル");
    expect(host.textContent).toContain("claude setup-token");
    expect(host.textContent).toContain("タブの履歴に残ります");
    expect(host.textContent).toContain(launcherStrings.accountClaudeLimitations);
  });
  it.each(["success", "failure"] as const)("clears after %s and never sends the paste to DOM output, console, storage or stores", async outcome => {
    const secret = "fixture-only-secret-" + outcome;
    await render();
    const input = await editor(secret);
    const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map(name => vi.spyOn(console, name));
    const storageSpy = vi.spyOn(Storage.prototype, "setItem");
    const loginSpy = vi.spyOn(useCliLoginStore, "setState");
    const accountSpy = vi.spyOn(useCliAccountStore, "setState");
    if (outcome === "failure") mocks.save.mockRejectedValue(new Error(secret));
    else {
      mocks.save.mockResolvedValue({ ...registered, owner_check: "unverified" });
      mocks.tokens.mockResolvedValue([{ ...registered, owner_check: "unverified" }]);
    }
    await click("保存");
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.save).toHaveBeenCalledWith("claude-fixture", secret);
    expect(input.value).toBe("");
    expect(host.querySelector('input[type="password"]')).toBeNull();
    expect(host.innerHTML).not.toContain(secret);
    expect(JSON.stringify(consoleSpies.flatMap(spy => spy.mock.calls))).not.toContain(secret);
    expect(JSON.stringify(storageSpy.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(loginSpy.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(accountSpy.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(useCliLoginStore.getState())).not.toContain(secret);
    expect(JSON.stringify(useCliAccountStore.getState())).not.toContain(secret);
    expect(JSON.stringify(localStorage)).not.toContain(secret);
    if (outcome === "success") {
      expect(mocks.tokens.mock.calls.length).toBeGreaterThan(1);
      expect(host.textContent).toContain("登録済み・期限 2027-01-01・持ち主: 未確認");
      expect(host.textContent).toContain("ブラウザで別のアカウントにログインしていなかったか");
    } else expect(host.textContent).toContain(cliAccountMessage("unknown"));
    await click("登録");
    expect(host.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
  });
  it.each(["verified", "org_matched"] as const)("RC-01 refreshes a previous %s row after a saved mismatch without exposing the paste", async previous => {
    const secret = "rc01-fixture-only-secret-" + previous;
    const mismatch = "cli_account.error.launch_token_owner_mismatch";
    mocks.tokens.mockResolvedValue([{ ...registered, owner_check: previous }]);
    await render();
    expect(mocks.tokens).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain(previous === "verified" ? "確認済み (サーバーで確認)" : "確認済み (組織が一致)");
    const input = await editor(secret);
    const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map(name => vi.spyOn(console, name));
    const storageSpy = vi.spyOn(Storage.prototype, "setItem");
    mocks.save.mockImplementation(async () => {
      mocks.tokens.mockResolvedValue([{ ...registered, owner_check: "mismatch" }]);
      throw mismatch;
    });
    await click("保存");
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith("claude-fixture", secret);
    expect(mocks.tokens).toHaveBeenCalledTimes(2);
    expect(mocks.tokens.mock.invocationCallOrder[1]).toBeGreaterThan(mocks.save.mock.invocationCallOrder[0]);
    expect(host.textContent).toContain("登録済み・期限 2027-01-01・持ち主: 不一致 (このトークンでは起動しません)");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(cliAccountMessage(mismatch));
    expect(input.value).toBe("");
    expect(host.querySelector('input[type="password"]')).toBeNull();
    expect(host.innerHTML).not.toContain(secret);
    expect(JSON.stringify(consoleSpies.flatMap(spy => spy.mock.calls))).not.toContain(secret);
    expect(JSON.stringify(storageSpy.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(localStorage)).not.toContain(secret);
    expect(JSON.stringify(sessionStorage)).not.toContain(secret);
  });
  it("RC-01 keeps the registration mismatch notice when refreshing status fails", async () => {
    const secret = "rc01-private-refresh-fixture";
    const mismatch = "cli_account.error.launch_token_owner_mismatch";
    mocks.tokens.mockResolvedValue([registered]);
    await render();
    const input = await editor(secret);
    const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map(name => vi.spyOn(console, name));
    const storageSpy = vi.spyOn(Storage.prototype, "setItem");
    mocks.save.mockImplementation(async () => {
      mocks.tokens.mockRejectedValue(new Error(secret));
      mocks.homes.mockRejectedValue(new Error(secret));
      throw mismatch;
    });
    await click("保存");
    expect(mocks.tokens).toHaveBeenCalledTimes(2);
    expect([...host.querySelectorAll('[role="alert"]')].map(node => node.textContent)).toContain(cliAccountMessage(mismatch));
    expect(input.value).toBe("");
    expect(host.querySelector('input[type="password"]')).toBeNull();
    expect(host.innerHTML).not.toContain(secret);
    expect(JSON.stringify(consoleSpies.flatMap(spy => spy.mock.calls))).not.toContain(secret);
    expect(JSON.stringify(storageSpy.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(localStorage)).not.toContain(secret);
    expect(JSON.stringify(sessionStorage)).not.toContain(secret);
  });
  it("clears immediately while saving and allows only one IPC call", async () => {
    await render();
    const input = await editor("pending-fixture-secret");
    let finish!: (status: typeof registered) => void;
    mocks.save.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    await click("保存");
    expect(input.value).toBe("");
    await act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(mocks.save).toHaveBeenCalledTimes(1);
    await act(async () => { finish(registered); });
  });
  it.each(["cancel", "escape", "close"] as const)("clears the actual detached input on %s", async action => {
    await render();
    const input = await editor("discarded-fixture-secret");
    if (action === "cancel") await click("取消");
    if (action === "escape") await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    if (action === "close") await act(async () => root.render(null));
    expect(input.value).toBe("");
    expect(host.querySelector("input")).toBeNull();
    expect(mocks.save).not.toHaveBeenCalled();
  });
});

describe("S-2 token removal", () => {
  it("shows the date and matched owner without revealing identifiers or fingerprint", async () => {
    mocks.tokens.mockResolvedValue([registered]);
    await render();
    expect(host.textContent).toContain("登録済み・期限 2027-01-01・持ち主: 確認済み (サーバーで確認)");
    expect(host.textContent).not.toContain("claude-fixture");
    expect(host.textContent).not.toContain(registered.fingerprint);
  });
  it("removes only after confirmation and refreshes the state", async () => {
    mocks.tokens.mockResolvedValue([registered]);
    await render();
    mocks.confirm.mockResolvedValueOnce(false);
    await click("外す");
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.confirm.mock.calls[0][0]).toContain("トークン自体は期限まで有効のまま");
    mocks.remove.mockImplementation(async () => { mocks.tokens.mockResolvedValue([]); });
    await click("外す");
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith("claude-fixture");
    expect(host.textContent).toContain("未登録");
  });
});

describe("S-3 Codex/Grok tab logins", () => {
  it.each(["codex", "grok"] as const)("%s renders all home states, owner checks, and the matching login action", async provider => {
    for (const [state, label, action] of [
      [null, "未作成", "タブ用にログイン"], ["created", "ログイン待ち", "タブ用にログイン"],
      ["awaiting_login", "ログイン待ち", "タブ用にログイン"], ["ready", "使える", "再ログイン"],
      ["needs_login", "再ログインが必要", "再ログイン"],
    ] as const) {
      await act(async () => root.render(null));
      mocks.homes.mockResolvedValue(state ? [{ provider, profile_id: provider + "-fixture", state, owner: "matched", generation: 1 }] : []);
      await render(provider);
      expect(host.textContent).toContain(label);
      if (state) expect(host.textContent).toContain("持ち主: 確認済み");
      await click(action);
      expect(mocks.start).toHaveBeenLastCalledWith(provider, provider + "-fixture");
    }
    expect(host.textContent).toContain("登録を外しても会話と設定は残ります");
    expect(host.textContent).toContain("Grok側の変更は残しません");
    expect(host.textContent).toContain("戻す前の設定ファイルは、アカウントのフォルダの中に控えとして残します。");
    expect(host.textContent).not.toContain(provider + "-fixture");
    expect(host.textContent).not.toContain(launcherStrings.accountClaudeLimitations);
  });
  it("shows unverified ownership and refreshes after the existing login flow ends", async () => {
    mocks.homes.mockResolvedValue([{ provider: "codex", profile_id: "codex-fixture", state: "awaiting_login", owner: "unverified", generation: 0 }]);
    await render("codex");
    expect(host.textContent).toContain("ログイン待ち・持ち主: 未確認");
    mocks.homes.mockResolvedValue([{ provider: "codex", profile_id: "codex-fixture", state: "ready", owner: "matched", generation: 1 }]);
    await act(async () => useCliLoginStore.setState({ byProvider: { claude: null, codex: null, grok: null } }));
    expect(host.textContent).toContain("使える・持ち主: 確認済み");
  });
  it.each(["codex", "grok"] as const)("%s unregisters only after confirmation and explains home_in_use", async provider => {
    mocks.homes.mockResolvedValue([{ provider, profile_id: provider + "-fixture", state: "ready", owner: "matched", generation: 1 }]);
    await render(provider);
    mocks.confirm.mockResolvedValueOnce(false);
    await click("タブ用の登録を外す");
    expect(mocks.unregister).not.toHaveBeenCalled();
    expect(mocks.confirm.mock.calls[0][0]).toContain("会話と設定は残ります");
    mocks.unregister.mockRejectedValueOnce("cli_account.error.home_in_use");
    await click("タブ用の登録を外す");
    expect(mocks.unregister).toHaveBeenCalledExactlyOnceWith(provider, provider + "-fixture");
    expect(host.textContent).toContain(cliAccountMessage("cli_account.error.home_in_use"));
    expect(host.textContent).not.toContain("cli_account.error.");
    mocks.unregister.mockImplementation(async () => { mocks.homes.mockResolvedValue([]); });
    await click("タブ用の登録を外す");
    expect(host.textContent).toContain("未作成");
  });
});

describe("V1 confirmation labels and recheck", () => {
  it.each([
    ["verified", "確認済み (サーバーで確認)"],
    ["org_matched", "確認済み (組織が一致)"],
    ["org_shared", "組織だけ一致 (同じ組織のアカウントが複数)"],
    ["unverified", "未確認"],
    ["mismatch", "不一致 (このトークンでは起動しません)"],
  ])("shows the exact %s registration wording", async (owner_check, label) => {
    mocks.tokens.mockResolvedValue([{ ...registered, owner_check }]);
    await render();
    expect(host.textContent).toContain("登録済み・期限 2027-01-01・持ち主: " + label);
    expect(button("確かめ直す").disabled).toBe(false);
  });
  it("rechecks only the profile, disables duplicate requests, and refreshes the result", async () => {
    mocks.tokens.mockResolvedValue([registered]);
    await render();
    let finish!: (value: typeof registered) => void;
    mocks.recheck.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    await click("確かめ直す");
    expect(button("確かめ直す").disabled).toBe(true);
    await click("確かめ直す");
    expect(mocks.recheck).toHaveBeenCalledExactlyOnceWith("claude-fixture");
    mocks.tokens.mockResolvedValue([{ ...registered, owner_check: "org_matched" }]);
    await act(async () => finish(registered));
    expect(button("確かめ直す").disabled).toBe(false);
    expect(host.textContent).toContain("登録済み・期限 2027-01-01・持ち主: 確認済み (組織が一致)");
  });
  it("uses the existing generic error text without exposing IPC errors", async () => {
    mocks.tokens.mockResolvedValue([registered]);
    mocks.recheck.mockRejectedValue(new Error("fixture-private-error"));
    await render();
    await click("確かめ直す");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(cliAccountMessage("unknown"));
    expect(host.textContent).not.toContain("サーバーにつながりませんでした");
    expect(host.textContent).not.toContain("fixture-private-error");
  });
});

describe("V-FIX1 settings recheck outcomes", () => {
  it.each(["status_only", "method_only", "both"] as const)("uses exact wording A with a timestamp for %s", async kind => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 12, 12));
    mocks.tokens.mockResolvedValue([registered]);
    mocks.recheck.mockResolvedValue({
      ...registered, owner_check: "unverified", owner_method: kind === "status_only" ? undefined : "org",
      owner_check_status: kind === "method_only" ? undefined : 403,
      owner_checked_at: new Date(2026, 10, 12, 9, 30).toISOString(),
    });
    await render();
    await click("確かめ直す");
    const notice = host.querySelector<HTMLElement>('[role="status"]')!;
    expect(notice.textContent).toBe("確かめ直しました (09:30): サーバーは、このトークンの持ち主を答えませんでした。");
    expect(notice.style.color).toBe("var(--cmux-usage-warn)");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).not.toContain("サーバーにつながりませんでした");
  });
  it("drops only the timestamp when the returned status has no owner_checked_at", async () => {
    mocks.tokens.mockResolvedValue([registered]);
    mocks.recheck.mockResolvedValue({ ...registered, owner_check: "unverified", owner_check_status: 403 });
    await render();
    await click("確かめ直す");
    expect(host.querySelector('[role="status"]')?.textContent).toBe("確かめ直しました: サーバーは、このトークンの持ち主を答えませんでした。");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
  it("keeps the communication alert only when both status and method are absent", async () => {
    mocks.tokens.mockResolvedValue([registered]);
    mocks.recheck.mockResolvedValue({ ...registered, owner_check: "unverified" });
    await render();
    await click("確かめ直す");
    const notice = host.querySelector<HTMLElement>('[role="alert"]')!;
    expect(notice.textContent).toBe("確かめられませんでした: サーバーにつながりませんでした。少し待ってから、もう一度押してください。");
    expect(notice.style.color).toBe("var(--cmux-usage-danger)");
    expect(host.querySelector('[role="status"]')).toBeNull();
  });
  it("maps a recheck exception through the existing error table instead of claiming a connection failure", async () => {
    mocks.tokens.mockResolvedValue([registered]);
    mocks.recheck.mockRejectedValue("cli_account.error.home_not_ready");
    await render();
    await click("確かめ直す");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("原因: このアカウントはタブ用のログインがまだです。次にすること: 設定のアカウントからログインしてください。");
    expect(host.textContent).not.toContain("サーバーにつながりませんでした");
  });
  it("keeps mismatch in the owner label and does not add a notification", async () => {
    mocks.tokens.mockResolvedValue([registered]);
    mocks.recheck.mockResolvedValue({ ...registered, owner_check: "mismatch" });
    await render();
    mocks.tokens.mockResolvedValue([{ ...registered, owner_check: "mismatch" }]);
    await click("確かめ直す");
    expect(host.textContent).toContain("登録済み・期限 2027-01-01・持ち主: 不一致 (このトークンでは起動しません)");
    expect(host.querySelector('[role="alert"], [role="status"]')).toBeNull();
  });
});
