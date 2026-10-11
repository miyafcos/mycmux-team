import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { presentAccountUsage } from "../../src/lib/accountUsageApi";
import { accountLimitLabel, groupAccountRows } from "../../src/lib/accountAvailability";
import { handleSocketCommand } from "../../src/components/layout/socketCommands";
import type { AccountUsageReport } from "../../src/lib/ipc";

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tauri-apps/api/core")>(), invoke: vi.fn(),
}));

const fixture = JSON.parse(readFileSync(new URL("../fixtures/account-usage-api-v1.json", import.meta.url), "utf8")) as {
  schema_version: number;
  cases: { id: string; input: AccountUsageReport; expected: ReturnType<typeof presentAccountUsage> }[];
};

function checkPreserved(input: AccountUsageReport): void {
  const before = structuredClone(input);
  const reply = presentAccountUsage(input);
  const { availability_groups: groups, ...raw } = reply;
  const rawAccounts = raw.accounts.map(({ availability_group, availability_order, availability_label, ...row }) => row);
  expect({ ...raw, accounts: rawAccounts }).toEqual(before);
  expect(input).toEqual(before);
  expect(groups).toEqual(groupAccountRows(input.accounts).map((group) => ({
    id: group.id, label: group.label, collapsible: group.collapsible,
    profile_ids: group.rows.map((row) => row.profile_id),
  })));
  for (const group of groupAccountRows(input.accounts)) {
    group.rows.forEach((row, index) => {
      const projected = reply.accounts.find((item) => item.profile_id === row.profile_id)!;
      expect(projected.availability_group).toBe(group.id);
      expect(projected.availability_order).toBe(index);
      expect(projected.availability_label).toBe(accountLimitLabel(row));
    });
  }
}

describe("portable account usage v1 contract", () => {
  it("has a versioned fixed fixture with explicit expected reports", () => {
    expect(fixture.schema_version).toBe(1);
    expect(fixture.cases).toHaveLength(9);
  });

  it.each(fixture.cases)("matches the explicit fixture and PC projection: $id", ({ input, expected }) => {
    expect(presentAccountUsage(input)).toEqual(expected);
    checkPreserved(input);
  });

  it.each([NaN, Infinity, -Infinity])("shares the PC finite-number policy for %s", (pct) => {
    const input = structuredClone(fixture.cases[0].input);
    const row = input.accounts[4];
    row.five_hour = { pct, resets_at: null };
    row.seven_day = null;
    row.seven_day_sonnet = { pct, resets_at: null };
    checkPreserved(input);
    expect(presentAccountUsage(input).accounts[4].availability_group).toBe("unverified");
  });

  it("retains unrecognized additive raw metadata", () => {
    const input = { ...fixture.cases[0].input, future_report: { value: null }, accounts: fixture.cases[0].input.accounts.map((row) => ({ ...row, future_row: { value: 1 } })) };
    checkPreserved(input);
    expect(presentAccountUsage(input)).toMatchObject({ future_report: { value: null } });
  });

  it.each(["account.usage", "usage"])("dispatches %s through the same projection without new provider requests", async (command) => {
    vi.mocked(invoke).mockReset().mockResolvedValue(fixture.cases[0].input);
    expect(await handleSocketCommand(command, {})).toEqual(fixture.cases[0].expected);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("get_account_usage", { apiCommand: "account.usage" });
  });

  it("publishes the account capabilities while keeping the existing API version", () => {
    const rust = readFileSync(new URL("../../src-tauri/src/socket.rs", import.meta.url), "utf8");
    const payload = rust.slice(rust.indexOf("fn system_version_payload()"), rust.indexOf("fn account_api_log_line"));
    expect(payload).toContain('"account.switch.v1"');
    expect(payload).toContain('"account.usage.presentation.v1"');
    expect(rust).toContain("const SOCKET_API_MAJOR: u64 = 1;");
    expect(rust).toContain("const SOCKET_API_MINOR: u64 = 0;");
  });
});
