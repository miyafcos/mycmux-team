import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/ipc", () => ({
  listCliAccounts: vi.fn(),
  captureCliAccount: vi.fn(),
  switchCliAccount: vi.fn(),
  removeCliAccount: vi.fn(),
  renameCliAccount: vi.fn(),
  resolveCliAccountOrphan: vi.fn(),
}));

const usageFetch = vi.fn();
vi.mock("../../src/stores/usageStore", () => ({
  useUsageStore: { getState: () => ({ fetch: usageFetch }) },
}));

const pushToast = vi.fn();
vi.mock("../../src/stores/toastStore", () => ({
  useToastStore: { getState: () => ({ pushToast }) },
}));

import {
  captureCliAccount,
  listCliAccounts,
  removeCliAccount,
  renameCliAccount,
  resolveCliAccountOrphan,
  switchCliAccount,
  type CliAccountProfile,
  type CliAccountsSnapshot,
  type CliSwitchResult,
} from "../../src/lib/ipc";
import { __resetCliAccountStoreForTests, useCliAccountStore } from "../../src/stores/cliAccountStore";

const mockedList = vi.mocked(listCliAccounts);
const mockedCapture = vi.mocked(captureCliAccount);
const mockedSwitch = vi.mocked(switchCliAccount);
const mockedRemove = vi.mocked(removeCliAccount);
const mockedRename = vi.mocked(renameCliAccount);
const mockedResolveOrphan = vi.mocked(resolveCliAccountOrphan);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const profile: CliAccountProfile = { id: "claude-a", provider: "claude", label: "A", email: "a@example.test", identity_key: "a", plan: "pro", org_name: null, captured_at: "2026-01-01T00:00:00Z", last_switched_at: null, needs_relogin: false };
const snapshot = (profiles: CliAccountProfile[]): CliAccountsSnapshot => ({ profiles, live: [{ provider: "claude", present: true, email: profile.email, identity_key: profile.identity_key, plan: profile.plan, org_name: null, matched_profile_id: profile.id, error: null }, { provider: "codex", present: false, email: null, identity_key: null, plan: null, org_name: null, matched_profile_id: null, error: null }, { provider: "grok", present: false, email: null, identity_key: null, plan: null, org_name: null, matched_profile_id: null, error: null }], active: { claude: profile.id, codex: null, grok: null }, orphans: [], backup_root: "backups", generated_at: "2026-01-01T00:00:00Z" });
const switchResult: CliSwitchResult = { profile, wrote_back_to: null, backup_dir: "backup", warnings: [] };

describe("cliAccountStore", () => {
  beforeEach(() => {
    mockedList.mockReset(); mockedCapture.mockReset(); mockedSwitch.mockReset(); mockedRemove.mockReset(); mockedRename.mockReset(); mockedResolveOrphan.mockReset(); usageFetch.mockReset(); pushToast.mockReset();
    __resetCliAccountStoreForTests();
  });
  afterEach(() => __resetCliAccountStoreForTests());

  it("populates profiles and live logins on fetch", async () => {
    mockedList.mockResolvedValue(snapshot([profile]));
    await useCliAccountStore.getState().fetch();
    expect(useCliAccountStore.getState().profiles).toEqual([profile]);
    expect(useCliAccountStore.getState().live).toHaveLength(3);
    expect(useCliAccountStore.getState().fetchError).toBeNull();
    expect(useCliAccountStore.getState().active.claude).toBe(profile.id);
  });

  it("keeps last-good data when fetch fails", async () => {
    mockedList.mockResolvedValueOnce(snapshot([profile]));
    await useCliAccountStore.getState().fetch();
    mockedList.mockRejectedValueOnce(new Error("boom"));
    await useCliAccountStore.getState().fetch();
    expect(useCliAccountStore.getState().profiles).toEqual([profile]);
    expect(useCliAccountStore.getState().fetchError).toContain("原因:");
  });

  it("drops out-of-order fetch responses", async () => {
    const older = deferred<CliAccountsSnapshot>(); const newer = deferred<CliAccountsSnapshot>();
    mockedList.mockImplementationOnce(() => older.promise).mockImplementationOnce(() => newer.promise);
    const first = useCliAccountStore.getState().fetch(); const second = useCliAccountStore.getState().fetch();
    newer.resolve(snapshot([{ ...profile, id: "new" }])); await second;
    older.resolve(snapshot([{ ...profile, id: "old" }])); await first;
    expect(useCliAccountStore.getState().profiles.map((item) => item.id)).toEqual(["new"]);
  });

  it("switches, refetches, refreshes usage, and stores the result", async () => {
    mockedSwitch.mockResolvedValue(switchResult); mockedList.mockResolvedValue(snapshot([profile])); usageFetch.mockResolvedValue(undefined);
    await expect(useCliAccountStore.getState().switchTo("claude", profile.id)).resolves.toEqual(switchResult);
    expect(mockedList).toHaveBeenCalledOnce(); expect(usageFetch).toHaveBeenCalledOnce(); expect(useCliAccountStore.getState().lastSwitchResult).toEqual(switchResult);
    expect(pushToast).toHaveBeenCalledWith("「A」に切り替えました。新しく起動するセッションから反映されます。", "info");
  });

  it("does not claim success when restored identity verification warns", async () => {
    const warned = {
      ...switchResult,
      warnings: ["cli_account.warning.restored_identity_mismatch"],
    };
    mockedSwitch.mockResolvedValue(warned);
    mockedList.mockResolvedValue(snapshot([profile]));
    usageFetch.mockResolvedValue(undefined);

    await useCliAccountStore.getState().switchTo("claude", profile.id);

    expect(pushToast).toHaveBeenCalledWith(
      expect.stringContaining("一致を確認できません"),
      "warning",
    );
    expect(pushToast).not.toHaveBeenCalledWith(expect.stringContaining("切り替えました"), "info");
  });

  it("reports metadata persistence failure as a warning after the login was applied", async () => {
    mockedSwitch.mockResolvedValue({
      ...switchResult,
      warnings: ["cli_account.warning.switch_metadata_not_saved"],
    });
    mockedList.mockResolvedValue(snapshot([profile]));
    usageFetch.mockResolvedValue(undefined);

    await useCliAccountStore.getState().switchTo("claude", profile.id);

    expect(pushToast).toHaveBeenCalledWith(
      expect.stringContaining("選択履歴を保存できませんでした"),
      "warning",
    );
  });

  it("returns null and sets operationError when switching fails", async () => {
    mockedSwitch.mockRejectedValue(new Error("cli_account.error.profile_not_found"));
    await expect(useCliAccountStore.getState().switchTo("claude", profile.id)).resolves.toBeNull();
    expect(useCliAccountStore.getState().operationError).toContain("対象の登録アカウント");
  });

  it("rejects a concurrent mutation", async () => {
    const pending = deferred<CliSwitchResult>(); mockedSwitch.mockImplementationOnce(() => pending.promise); mockedList.mockResolvedValue(snapshot([profile])); usageFetch.mockResolvedValue(undefined);
    const first = useCliAccountStore.getState().switchTo("claude", profile.id);
    expect(await useCliAccountStore.getState().switchTo("claude", "claude-b")).toBeNull();
    pending.resolve(switchResult); await first;
    expect(mockedSwitch).toHaveBeenCalledOnce();
  });

  it("uses the provider capture busy key", async () => {
    const pending = deferred<CliAccountProfile>(); mockedCapture.mockImplementationOnce(() => pending.promise); mockedList.mockResolvedValue(snapshot([profile]));
    const operation = useCliAccountStore.getState().capture("claude");
    expect(useCliAccountStore.getState().busyByProvider.claude).toBe("capture:claude");
    pending.resolve(profile); await operation;
    expect(useCliAccountStore.getState().busyByProvider.claude).toBeNull();
  });

  it("keeps an operation error until the user dismisses it even after fetch succeeds", async () => {
    mockedSwitch.mockRejectedValueOnce(new Error("cli_account.error.profile_not_found"));
    await useCliAccountStore.getState().switchTo("claude", profile.id);
    const operationError = useCliAccountStore.getState().operationError;
    expect(operationError).toContain("対象の登録アカウント");

    mockedList.mockResolvedValueOnce(snapshot([profile]));
    await useCliAccountStore.getState().fetch();
    expect(useCliAccountStore.getState().operationError).toBe(operationError);
    expect(useCliAccountStore.getState().fetchError).toBeNull();

    useCliAccountStore.getState().dismissOperationError();
    expect(useCliAccountStore.getState().operationError).toBeNull();
  });

  it("dismisses switch warnings without losing the backup result", async () => {
    useCliAccountStore.setState({
      lastSwitchResult: { ...switchResult, warnings: ["cli_account.warning.restored_identity_mismatch"] },
    });
    useCliAccountStore.getState().dismissSwitchWarnings();
    expect(useCliAccountStore.getState().lastSwitchResult).toEqual({ ...switchResult, warnings: [] });
  });

  it("queues different providers while keeping their busy states independent", async () => {
    const claudePending = deferred<CliSwitchResult>();
    const codexProfile: CliAccountProfile = { ...profile, id: "codex-b", provider: "codex", identity_key: "codex-b", label: "B" };
    const codexResult: CliSwitchResult = { ...switchResult, profile: codexProfile };
    mockedSwitch
      .mockImplementationOnce(() => claudePending.promise)
      .mockResolvedValueOnce(codexResult);
    mockedList.mockResolvedValue(snapshot([profile, codexProfile]));
    usageFetch.mockResolvedValue(undefined);

    const first = useCliAccountStore.getState().switchTo("claude", profile.id);
    const second = useCliAccountStore.getState().switchTo("codex", codexProfile.id);
    expect(useCliAccountStore.getState().busyByProvider).toEqual({ claude: profile.id, codex: codexProfile.id, grok: null });
    await Promise.resolve();
    expect(mockedSwitch).toHaveBeenCalledTimes(1);

    claudePending.resolve(switchResult);
    await first;
    await second;
    expect(mockedSwitch).toHaveBeenCalledTimes(2);
    expect(useCliAccountStore.getState().busyByProvider).toEqual({ claude: null, codex: null, grok: null });
  });

  it("checks automatic-switch permission inside the queue and releases busy on cancellation", async () => {
    const pending = deferred<CliSwitchResult>();
    mockedSwitch.mockImplementationOnce(() => pending.promise);
    mockedList.mockResolvedValue(snapshot([profile]));
    usageFetch.mockResolvedValue(undefined);
    let enabled = true;
    const guard = vi.fn(() => enabled);
    const first = useCliAccountStore.getState().switchTo("claude", profile.id);
    const queued = useCliAccountStore.getState().switchTo("codex", "codex-b", guard);
    await Promise.resolve();
    expect(guard).not.toHaveBeenCalled();
    enabled = false;
    pending.resolve(switchResult);
    await first;
    await expect(queued).resolves.toBeNull();
    expect(guard).toHaveBeenCalledOnce();
    expect(mockedSwitch).toHaveBeenCalledOnce();
    expect(useCliAccountStore.getState().busyByProvider.codex).toBeNull();
  });
});
