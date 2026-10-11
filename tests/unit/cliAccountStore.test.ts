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
import { switchAccountForApi } from "../../src/lib/accountSwitchApi";

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
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); __resetCliAccountStoreForTests(); });

  it("populates profiles and live logins on fetch", async () => {
    mockedList.mockResolvedValue(snapshot([profile]));
    await useCliAccountStore.getState().fetch();
    expect(useCliAccountStore.getState().profiles).toEqual([profile]);
    expect(useCliAccountStore.getState().live).toHaveLength(3);
    expect(useCliAccountStore.getState().fetchError).toBeNull();
    expect(useCliAccountStore.getState().active.claude).toBe(profile.id);
  });

  it("shares PC notifications, refresh and delayed overwrite detection with account.switch", async () => {
    vi.useFakeTimers();
    mockedSwitch.mockResolvedValue(switchResult);
    mockedList.mockResolvedValue(snapshot([profile]));
    usageFetch.mockResolvedValue(undefined);
    const reply = await switchAccountForApi({ provider: "claude", profile_id: profile.id }, Date.now() + 25000);
    expect(mockedSwitch).toHaveBeenCalledWith("claude", profile.id, true);
    expect(reply).toEqual({ provider: "claude", profile_id: profile.id, status: "switched", applied: true, active_profile_id: profile.id, active_known: true, intended_active_profile_id: profile.id, wrote_back_to: null, warnings: [], error_code: null });
    expect(useCliAccountStore.getState().lastSwitchResult).toEqual(switchResult);
    expect(usageFetch).toHaveBeenCalledOnce();
    expect(pushToast).toHaveBeenCalledWith("「A」に切り替えました。新しく起動するセッションから反映されます。", "info");
    mockedList.mockResolvedValue({ ...snapshot([profile]), live: [{ ...snapshot([profile]).live[0], identity_key: "previous", matched_profile_id: null }] });
    await vi.advanceTimersByTimeAsync(8000);
    expect(pushToast).toHaveBeenLastCalledWith(expect.stringContaining("上書きされました"), "warning");
  });

  it("propagates API log policy to the usage refresh after switching", async () => {
    vi.useFakeTimers();
    mockedSwitch.mockResolvedValue(switchResult);
    mockedList.mockResolvedValue(snapshot([profile]));
    await switchAccountForApi({ provider: "claude", profile_id: profile.id }, Date.now() + 25000);
    expect(usageFetch).toHaveBeenCalledWith(false, "account.switch");
  });

  it.each(["profile_not_found", "needs_relogin", "switch_busy"])("returns this API rejection %s without replacing old UI state", async (code) => {
    mockedSwitch.mockRejectedValue(`cli_account.error.${code}`);
    mockedList.mockResolvedValue(snapshot([profile]));
    useCliAccountStore.setState({ operationError: "previous error", lastSwitchResult: switchResult });
    const reply = await switchAccountForApi({ provider: "claude", profileId: profile.id }, Date.now() + 25000);
    expect(reply.status).toBe("rejected");
    expect(reply.error_code).toBe(`cli_account.error.${code}`);
    expect(reply.applied).toBe(false);
    expect(useCliAccountStore.getState().operationError).toBe("previous error");
    expect(useCliAccountStore.getState().lastSwitchResult).toEqual(switchResult);
    expect(pushToast).not.toHaveBeenCalled();
    expect(usageFetch).not.toHaveBeenCalled();
    expect(useCliAccountStore.getState().busyByProvider.claude).toBeNull();
  });

  it("reports a core needs-relogin failure with its fixed code after write-back", async () => {
    mockedSwitch.mockRejectedValue("cli_account.api.core_error:cli_account.error.needs_relogin");
    mockedList.mockResolvedValue(snapshot([profile]));
    const reply = await switchAccountForApi({ provider: "claude", profile_id: profile.id }, Date.now() + 25000);
    expect(reply).toMatchObject({ status: "failed", applied: false, error_code: "cli_account.error.needs_relogin" });
    expect(useCliAccountStore.getState().operationError).not.toContain("api.core_error");
  });

  it("treats an API already-active marker as a quiet no-op", async () => {
    mockedSwitch.mockRejectedValue("cli_account.result.already_active");
    mockedList.mockResolvedValue(snapshot([profile]));
    const reply = await switchAccountForApi({ provider: "claude", profile_id: profile.id }, Date.now() + 25000);
    expect(reply.status).toBe("already_active");
    expect(reply.applied).toBe(false);
    expect(reply.error_code).toBeNull();
    expect(pushToast).not.toHaveBeenCalled();
    expect(usageFetch).not.toHaveBeenCalled();
  });

  it("excludes concurrent API and PC calls using the same provider busy state", async () => {
    const pending = deferred<CliSwitchResult>();
    mockedSwitch.mockImplementationOnce(() => pending.promise);
    mockedList.mockResolvedValue(snapshot([profile]));
    const first = switchAccountForApi({ provider: "claude", profile_id: profile.id }, Date.now() + 25000);
    expect(await useCliAccountStore.getState().switchTo("claude", "claude-other")).toBeNull();
    const duplicate = await switchAccountForApi({ provider: "claude", profile_id: "claude-other" }, Date.now() + 25000);
    expect(duplicate).toMatchObject({ status: "rejected", applied: false, error_code: "cli_account.error.switch_busy" });
    pending.resolve(switchResult);
    await first;
    expect(mockedSwitch).toHaveBeenCalledOnce();
  });

  it("expires a queued API request before invoking Rust and preserves the PC call shape", async () => {
    vi.useFakeTimers();
    const pending = deferred<CliSwitchResult>();
    mockedSwitch.mockImplementationOnce(() => pending.promise);
    mockedList.mockResolvedValue(snapshot([profile]));
    const first = useCliAccountStore.getState().switchTo("claude", profile.id);
    const queued = switchAccountForApi({ provider: "codex", profile_id: "codex-b" }, Date.now() + 5);
    await Promise.resolve();
    vi.advanceTimersByTime(6);
    pending.resolve(switchResult);
    await first;
    expect(await queued).toMatchObject({ status: "rejected", error_code: "cli_account.error.switch_expired" });
    expect(mockedSwitch).toHaveBeenCalledExactlyOnceWith("claude", profile.id);
    expect(useCliAccountStore.getState().busyByProvider.codex).toBeNull();
  });

  it("separates observed live identity from registry intention and filters warning text", async () => {
    mockedSwitch.mockResolvedValue({ ...switchResult, wrote_back_to: "claude-old", warnings: ["cli_account.warning.restored_identity_mismatch", "cli_account.warning.switch_metadata_not_saved", "secret-token a@example.test"] });
    const observed = snapshot([profile]);
    observed.live[0].matched_profile_id = "claude-old";
    observed.active.claude = "claude-old-intention";
    mockedList.mockResolvedValue(observed);
    const reply = await switchAccountForApi({ provider: "claude", profile_id: profile.id }, Date.now() + 25000);
    expect(reply).toMatchObject({ status: "switched", applied: true, active_profile_id: "claude-old", intended_active_profile_id: "claude-old-intention", wrote_back_to: "claude-old" });
    expect(reply.warnings).toHaveLength(2);
    expect(JSON.stringify(reply)).not.toContain("secret-token");
    expect(JSON.stringify(reply)).not.toContain("a@example.test");
    expect(JSON.stringify(reply)).not.toContain("backup_dir");
  });

  it("does not turn last-good cached active or a previous error into this API outcome", async () => {
    useCliAccountStore.setState({ active: { claude: "stale", codex: null, grok: null }, operationError: "previous error", lastSwitchResult: switchResult });
    mockedSwitch.mockRejectedValue(new Error("secret-token a@example.test /private/auth.json"));
    mockedList.mockRejectedValue(new Error("read failed"));
    const reply = await switchAccountForApi({ provider: "claude", profile_id: profile.id }, Date.now() + 25000);
    expect(reply).toMatchObject({ status: "failed", applied: false, active_profile_id: null, active_known: false, intended_active_profile_id: null, error_code: "cli_account.error.switch_failed", warnings: [] });
    expect(JSON.stringify(reply)).not.toContain("secret-token");
  });

  it.each([undefined, null, [], {}, { provider: "invalid@example.test", profile_id: "secret" }, { provider: "claude", profile_id: " " }, { provider: "claude", profile_id: "a", profileId: "b" }, { provider: "claude", profile_id: 1 }])("rejects malformed args %j with a fixed error before invoking", async (args) => {
    await expect(switchAccountForApi(args, Date.now() + 25000)).rejects.toThrow("account.switch.invalid_args");
    expect(mockedSwitch).not.toHaveBeenCalled();
    expect(mockedList).not.toHaveBeenCalled();
  });

  it("keeps last-good data when fetch fails", async () => {
    mockedList.mockResolvedValueOnce(snapshot([profile]));
    await useCliAccountStore.getState().fetch();
    mockedList.mockRejectedValueOnce(new Error("boom"));
    await useCliAccountStore.getState().fetch();
    expect(useCliAccountStore.getState().profiles).toEqual([profile]);
    expect(useCliAccountStore.getState().fetchError).toContain("原因:");
  });

  it.each(["../outside", "claude-\u0000secret", "private@example.test", `claude-${"a".repeat(161)}`, "claude-a\n", "claude-a\\b"])("rejects malformed profile id %s before native execution", async (profileId) => {
    await expect(switchAccountForApi({ provider: "claude", profile_id: profileId }, Date.now() + 25000)).rejects.toThrow("account.switch.invalid_args");
    expect(mockedSwitch).not.toHaveBeenCalled();
    expect(mockedList).not.toHaveBeenCalled();
  });

  it.each(["claude-unknown", "codex-other-provider", `claude-${"a".repeat(153)}`])("keeps valid unknown/wrong-provider/boundary ID %s on the backend rejection path", async (profileId) => {
    mockedSwitch.mockRejectedValue("cli_account.error.profile_not_found");
    mockedList.mockResolvedValue(snapshot([profile]));
    expect(await switchAccountForApi({ provider: "claude", profile_id: profileId }, Date.now() + 25000)).toMatchObject({ status: "rejected", error_code: "cli_account.error.profile_not_found" });
    expect(mockedSwitch).toHaveBeenCalledWith("claude", profileId, true);
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
