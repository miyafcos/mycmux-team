// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callbacks: new Map<string, (event: { payload: unknown }) => void>(),
  unlisten: vi.fn(),
  listCliAccounts: vi.fn(),
  usageFetch: vi.fn(() => Promise.resolve()),
  pushToast: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, callback: (event: { payload: unknown }) => void) => {
    mocks.callbacks.set(name, callback);
    return () => { mocks.unlisten(name); mocks.callbacks.delete(name); };
  }),
}));
vi.mock("../../src/lib/ipc", async (original) => ({
  ...await original<typeof import("../../src/lib/ipc")>(),
  listCliAccounts: mocks.listCliAccounts,
}));
vi.mock("../../src/stores/usageStore", () => ({
  useUsageStore: { getState: () => ({ fetch: mocks.usageFetch }) },
}));
vi.mock("../../src/stores/toastStore", () => ({
  useToastStore: { getState: () => ({ pushToast: mocks.pushToast }) },
}));

import {
  CLI_LOGIN_COMPLETED_EVENT,
  CLI_LOGIN_FAILED_EVENT,
  type CliAccountProfile,
  type CliAccountsSnapshot,
  type CliProvider,
} from "../../src/lib/ipc";
import { cliAccountMessage } from "../../src/lib/cliAccounts";
import { useCliLoginEvents } from "../../src/hooks/useCliLoginEvents";
import { __resetCliAccountStoreForTests, useCliAccountStore } from "../../src/stores/cliAccountStore";
import { __resetCliLoginStoreForTests, useCliLoginStore } from "../../src/stores/cliLoginStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";

let root: Root;
let host: HTMLDivElement;
const providers: CliProvider[] = ["claude", "codex", "grok"];

function Listener(): null {
  useCliLoginEvents();
  return null;
}

function pendingLogin(provider: CliProvider): void {
  useCliAccountStore.getState().setLoginBusy(provider, `login:${provider}`);
  useCliLoginStore.setState((state) => ({ byProvider: {
    ...state.byProvider,
    [provider]: { stage: "waiting", loginId: `login-${provider}`, mode: "new",
      startedAt: Date.now(), sessionId: null, tabId: null },
  } }));
}

function profileFor(provider: CliProvider): CliAccountProfile {
  return { id: `${provider}-dummy`, provider, label: `Dummy ${provider}`,
    email: `${provider}@example.test`, identity_key: `dummy-${provider}`,
    plan: "pro", org_name: null, captured_at: "2026-10-09T00:00:00Z",
    last_switched_at: null, needs_relogin: false };
}

function snapshotFor(profile: CliAccountProfile): CliAccountsSnapshot {
  return { profiles: [profile], live: [], active: { claude: null, codex: null, grok: null },
    orphans: [], backup_root: "dummy-backups", generated_at: "2026-10-09T00:00:00Z" };
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.callbacks.clear();
  mocks.listCliAccounts.mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  __resetCliAccountStoreForTests();
  __resetCliLoginStoreForTests();
  useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<Listener />); });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  expect(mocks.unlisten).toHaveBeenCalledTimes(3);
  expect(mocks.callbacks.size).toBe(0);
  host.remove();
  __resetCliLoginStoreForTests();
  __resetCliAccountStoreForTests();
  vi.unstubAllGlobals();
});

describe("existing CLI login events refresh the account list for all providers", () => {
  it.each(providers)("reloads %s registrations and usage before releasing the login", async (provider) => {
    pendingLogin(provider);
    const profile = profileFor(provider);
    let finishFetch!: (value: CliAccountsSnapshot) => void;
    mocks.listCliAccounts.mockReturnValueOnce(new Promise<CliAccountsSnapshot>((resolve) => {
      finishFetch = resolve;
    }));
    // Invoke the actual subscribed hook callback; the real login/account stores
    // must read the backend snapshot rather than just append the event profile.
    expect(mocks.callbacks.has("mycmux://cli-login-completed")).toBe(true);
    await act(async () => {
      mocks.callbacks.get(CLI_LOGIN_COMPLETED_EVENT)!({ payload: {
        login_id: `login-${provider}`, profile, updated_existing: false,
      } });
    });
    expect(mocks.listCliAccounts).toHaveBeenCalledOnce();
    expect(mocks.usageFetch).toHaveBeenCalledOnce();
    expect(useCliAccountStore.getState().profiles).toEqual([]);
    expect(useCliLoginStore.getState().byProvider[provider]?.stage).toBe("capturing");
    expect(useCliAccountStore.getState().busyByProvider[provider]).toBe(`login:${provider}`);
    await act(async () => { finishFetch(snapshotFor(profile)); });
    expect(useCliAccountStore.getState().profiles).toEqual([profile]);
    expect(useCliAccountStore.getState().fetchError).toBeNull();
    expect(useCliLoginStore.getState().byProvider[provider]).toBeNull();
    expect(useCliAccountStore.getState().busyByProvider[provider]).toBeNull();
    expect(mocks.pushToast).toHaveBeenCalledWith(`「${profile.label}」を登録しました。`, "info");
  });

  it.each(providers)("refreshes the existing %s row on reauthentication without duplicating it", async (provider) => {
    pendingLogin(provider);
    const profile = profileFor(provider);
    useCliAccountStore.setState({ profiles: [{ ...profile, needs_relogin: true }] });
    mocks.listCliAccounts.mockResolvedValueOnce(snapshotFor(profile));
    await act(async () => {
      mocks.callbacks.get(CLI_LOGIN_COMPLETED_EVENT)!({ payload: {
        login_id: `login-${provider}`, profile, updated_existing: true,
      } });
    });
    expect(useCliAccountStore.getState().profiles).toEqual([profile]);
    expect(mocks.listCliAccounts).toHaveBeenCalledOnce();
    expect(mocks.usageFetch).toHaveBeenCalledOnce();
    expect(useCliAccountStore.getState().busyByProvider[provider]).toBeNull();
    expect(mocks.pushToast).toHaveBeenCalledWith(`「${profile.label}」の登録を更新しました。`, "info");
  });

  it("ignores completion for an unrelated login ID", async () => {
    pendingLogin("grok");
    await act(async () => {
      mocks.callbacks.get(CLI_LOGIN_COMPLETED_EVENT)!({ payload: {
        login_id: "unrelated-login", profile: profileFor("grok"), updated_existing: false,
      } });
    });
    expect(mocks.listCliAccounts).not.toHaveBeenCalled();
    expect(mocks.usageFetch).not.toHaveBeenCalled();
    expect(useCliLoginStore.getState().byProvider.grok?.stage).toBe("waiting");
  });

  it("shows the Codex missing-file cause on the existing failure event", async () => {
    pendingLogin("codex");
    await act(async () => {
      mocks.callbacks.get(CLI_LOGIN_FAILED_EVENT)!({ payload: {
        login_id: "login-codex", code: "cli_account.error.codex_login_file_missing",
      } });
    });
    expect(mocks.pushToast).toHaveBeenCalledWith(
      cliAccountMessage("cli_account.error.codex_login_file_missing"), "error",
    );
    expect(mocks.pushToast.mock.calls[0][0]).toContain("ファイル以外");
    expect(useCliLoginStore.getState().byProvider.codex).toBeNull();
    expect(useCliAccountStore.getState().busyByProvider.codex).toBeNull();
    expect(mocks.listCliAccounts).not.toHaveBeenCalled();
  });
});
