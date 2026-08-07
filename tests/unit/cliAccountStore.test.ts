import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/ipc", () => ({
  listCliAccounts: vi.fn(),
  captureCliAccount: vi.fn(),
  switchCliAccount: vi.fn(),
  removeCliAccount: vi.fn(),
  renameCliAccount: vi.fn(),
}));

const usageFetch = vi.fn();
vi.mock("../../src/stores/usageStore", () => ({
  useUsageStore: { getState: () => ({ fetch: usageFetch }) },
}));

import {
  captureCliAccount,
  listCliAccounts,
  removeCliAccount,
  renameCliAccount,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const profile: CliAccountProfile = { id: "claude-a", provider: "claude", label: "A", email: "a@example.test", identity_key: "a", plan: "pro", org_name: null, captured_at: "2026-01-01T00:00:00Z", last_switched_at: null, needs_relogin: false };
const snapshot = (profiles: CliAccountProfile[]): CliAccountsSnapshot => ({ profiles, live: [{ provider: "claude", present: true, email: profile.email, identity_key: profile.identity_key, plan: profile.plan, org_name: null, matched_profile_id: profile.id, error: null }, { provider: "codex", present: false, email: null, identity_key: null, plan: null, org_name: null, matched_profile_id: null, error: null }], generated_at: "2026-01-01T00:00:00Z" });
const switchResult: CliSwitchResult = { profile, wrote_back_to: null, backup_dir: "backup", warnings: [] };

describe("cliAccountStore", () => {
  beforeEach(() => {
    mockedList.mockReset(); mockedCapture.mockReset(); mockedSwitch.mockReset(); mockedRemove.mockReset(); mockedRename.mockReset(); usageFetch.mockReset();
    __resetCliAccountStoreForTests();
  });
  afterEach(() => __resetCliAccountStoreForTests());

  it("populates profiles and live logins on fetch", async () => {
    mockedList.mockResolvedValue(snapshot([profile]));
    await useCliAccountStore.getState().fetch();
    expect(useCliAccountStore.getState().profiles).toEqual([profile]);
    expect(useCliAccountStore.getState().live).toHaveLength(2);
    expect(useCliAccountStore.getState().lastError).toBeNull();
  });

  it("keeps last-good data when fetch fails", async () => {
    mockedList.mockResolvedValueOnce(snapshot([profile]));
    await useCliAccountStore.getState().fetch();
    mockedList.mockRejectedValueOnce(new Error("boom"));
    await useCliAccountStore.getState().fetch();
    expect(useCliAccountStore.getState().profiles).toEqual([profile]);
    expect(useCliAccountStore.getState().lastError).toBe("boom");
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
  });

  it("returns null and sets lastError when switching fails", async () => {
    mockedSwitch.mockRejectedValue(new Error("switch boom"));
    await expect(useCliAccountStore.getState().switchTo("claude", profile.id)).resolves.toBeNull();
    expect(useCliAccountStore.getState().lastError).toBe("switch boom");
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
    expect(useCliAccountStore.getState().busyProfileId).toBe("capture:claude");
    pending.resolve(profile); await operation;
    expect(useCliAccountStore.getState().busyProfileId).toBeNull();
  });
});
