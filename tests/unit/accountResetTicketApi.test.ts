import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { claimResetTicket, type ProfileUsage } from "../../src/lib/ipc";
import { handleSocketCommand } from "../../src/components/layout/socketCommands";
import { useResetTicketForApi } from "../../src/lib/accountResetTicketApi";
import { createResetTicketStore } from "../../src/stores/resetTicketStore";
import type { ResetTicketOutcome, ResetTickets } from "../../src/lib/resetTickets";

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tauri-apps/api/core")>(), invoke: vi.fn(),
}));

const tickets: ResetTickets = { available: 3, expires_at: "2026-11-01T00:00:00Z", usable_now: true, blocked_reason: null, clears: ["five_hour", "seven_day"], moves_weekly_reset: false, requires_limit: false, title: null };
const row: ProfileUsage = { profile_id: "claude-a", provider: "claude", label: "A", email: "a@example.test", plan: "max", registered: true, is_active: false, needs_relogin: false, state: "ok", five_hour: null, seven_day: null, seven_day_sonnet: null, seven_day_opus: null, model_windows: [], reset_tickets: tickets, error_code: null, retry_at: null, fetched_at: "2026-10-10T00:00:00Z" };
const args = { provider: "claude", profile_id: "claude-a", request_id: "api-request", expected_email: "a@example.test" };
const outcome = (kind: ResetTicketOutcome["kind"], extra: Partial<ResetTicketOutcome> = {}): ResetTicketOutcome => ({ kind, resets_left: null, weekly_resets_at: null, retry_of_unconfirmed: false, ...extra });
const mockedInvoke = vi.mocked(invoke);
const deadline = () => Date.now() + 25000;

function backend(answer: ResetTicketOutcome, inventory: ProfileUsage = row) {
  mockedInvoke.mockImplementation(async (command) => {
    if (command === "use_reset_ticket") return answer;
    if (command === "get_account_usage") return { accounts: [inventory], generated_at: row.fetched_at };
    throw new Error("unexpected command");
  });
}

describe("account.use_reset_ticket", () => {
  beforeEach(() => { mockedInvoke.mockReset(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("uses the existing command through socket dispatch and returns count, expiry and resend state", async () => {
    backend(outcome("reset", { resets_left: 2, retry_of_unconfirmed: true, weekly_resets_at: "2026-10-17T00:00:00Z" }));
    expect(await handleSocketCommand("account.use_reset_ticket", args)).toEqual({ provider: "claude", profile_id: "claude-a", status: "used", outcome: "reset", resets_left: 2, expires_at: tickets.expires_at, tickets_known: true, weekly_resets_at: "2026-10-17T00:00:00Z", retry_of_unconfirmed: true, error_code: null });
    expect(invoke).toHaveBeenNthCalledWith(1, "use_reset_ticket", { profileId: "claude-a", requestId: "api-request", expectedEmail: "a@example.test", apiRequest: true, apiProvider: "claude" });
    expect(invoke).toHaveBeenNthCalledWith(2, "get_account_usage", { apiCommand: "account.use_reset_ticket" });
  });

  it("propagates API log policy to inventory even after an upstream failure", async () => {
    backend(outcome("unconfirmed"), { ...row, state: "error", error_code: "SECRET-profile" });
    await useResetTicketForApi(args, deadline());
    expect(invoke).toHaveBeenLastCalledWith("get_account_usage", { apiCommand: "account.use_reset_ticket" });
  });

  it.each([true, false])("both PC and API enter the same command/state (PC first: %s)", async (pcFirst) => {
    const calls: Record<string, unknown>[] = [];
    mockedInvoke.mockImplementation(async (command, payload) => {
      if (command === "get_account_usage") return { accounts: [row], generated_at: row.fetched_at };
      if (command !== "use_reset_ticket") throw new Error("unexpected command");
      calls.push(payload as Record<string, unknown>);
      return calls.length === 1 ? outcome("unconfirmed") : outcome("reset", { retry_of_unconfirmed: true });
    });
    const store = createResetTicketStore({ confirm: async () => true, claim: claimResetTicket, uuid: () => "pc-request", refresh: async () => undefined });
    if (pcFirst) {
      await store.getState().useTicket(row, tickets);
      expect(await useResetTicketForApi(args, deadline())).toMatchObject({ status: "used", retry_of_unconfirmed: true });
    } else {
      expect(await useResetTicketForApi(args, deadline())).toMatchObject({ status: "unconfirmed" });
      await store.getState().useTicket(row, tickets);
    }
    expect(calls).toHaveLength(2);
    const pc = calls.find((call) => call.requestId === "pc-request");
    const api = calls.find((call) => call.requestId === "api-request");
    expect(pc).toEqual({ profileId: row.profile_id, requestId: "pc-request", expectedEmail: row.email });
    expect(api).toEqual({ profileId: row.profile_id, requestId: "api-request", expectedEmail: row.email, apiRequest: true, apiProvider: "claude" });
    expect(store.getState().inFlight).toEqual({});
  });

  it.each([
    ["unconfirmed", "unconfirmed"], ["no_ticket", "no_ticket"], ["already_used", "used"],
    ["cooldown", "not_usable"], ["nothing_to_reset", "not_usable"], ["offer_changed", "not_usable"],
    ["auth_error", "not_usable"], ["token_stale", "not_usable"], ["owner_mismatch", "not_usable"],
    ["rate_limited", "not_usable"], ["unavailable", "not_usable"],
  ] as const)("reports %s as %s", async (kind, status) => {
    backend(outcome(kind));
    expect(await useResetTicketForApi(args, deadline())).toMatchObject({ status, outcome: kind, error_code: null });
  });

  it.each(["claude", "codex", "grok"] as const)("keeps live:%s valid at the reset API boundary", async (provider) => {
    mockedInvoke.mockImplementation(async () => {
      if (provider === "grok") throw "Reset tickets are not supported for Grok";
      return outcome("no_ticket");
    });
    const reply = await useResetTicketForApi({ ...args, provider, profile_id: `live:${provider}` }, deadline());
    expect(reply.status).toBe(provider === "grok" ? "not_usable" : "no_ticket");
    expect(invoke).toHaveBeenCalledWith("use_reset_ticket", { profileId: `live:${provider}`, requestId: "api-request", expectedEmail: row.email, apiRequest: true, apiProvider: provider });
  });

  it("reports no ticket even when inventory cannot be read", async () => {
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "use_reset_ticket") return outcome("no_ticket");
      throw new Error("inventory unavailable");
    });
    expect(await useResetTicketForApi(args, deadline())).toMatchObject({ status: "no_ticket", resets_left: 0, expires_at: null, tickets_known: false });
  });

  it.each(["Reset tickets are not supported for Grok", "reset_ticket.error.profile_not_found", "private@example.test synthetic-secret /private/auth.json"])("returns a fixed error for %s", async (error) => {
    mockedInvoke.mockRejectedValue(error);
    const reply = await useResetTicketForApi({ ...args, provider: "grok" }, deadline());
    expect(reply.error_code).toBe(error === "Reset tickets are not supported for Grok" ? "reset_ticket.error.unsupported_provider" : error === "reset_ticket.error.profile_not_found" ? error : "reset_ticket.error.use_failed");
    expect(JSON.stringify(reply)).not.toContain("synthetic-secret");
    expect(JSON.stringify(reply)).not.toContain("private@example.test");
  });

  it("surfaces backend busy for overlapping API calls without a second spend", async () => {
    let resolve!: (value: ResetTicketOutcome) => void;
    let entered = false;
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "get_account_usage") return { accounts: [row], generated_at: row.fetched_at };
      if (entered) return outcome("busy");
      entered = true;
      return new Promise<ResetTicketOutcome>((done) => { resolve = done; });
    });
    const first = useResetTicketForApi(args, deadline());
    expect(await useResetTicketForApi({ ...args, request_id: "second-request" }, deadline())).toMatchObject({ status: "rejected", outcome: "busy", error_code: "reset_ticket.error.busy" });
    resolve(outcome("reset"));
    await first;
    expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === "use_reset_ticket")).toHaveLength(2);
  });

  it.each(["claude", "codex"] as const)("never borrows account B inventory after a live:%s claim on account A", async (provider) => {
    const liveId = `live:${provider}`;
    backend(outcome("reset", { resets_left: 1 }), {
      ...row, provider, profile_id: liveId, registered: false,
      email: "b@example.test", reset_tickets: { ...tickets, available: 99, expires_at: "2099-01-01T00:00:00Z" },
    });
    const reply = await useResetTicketForApi({ ...args, provider, profile_id: liveId, expected_email: "a@example.test" }, deadline());
    expect(reply).toMatchObject({ status: "used", resets_left: 1, expires_at: null, tickets_known: false });
  });

  it("requires inventory email to match the expected owner for a saved row", async () => {
    backend(outcome("unconfirmed"), { ...row, email: "b@example.test" });
    expect(await useResetTicketForApi(args, deadline())).toMatchObject({ resets_left: null, expires_at: null, tickets_known: false });
  });

  it("keeps previous/cooldown inventory unknown and never echoes extra fields", async () => {
    backend({ ...outcome("unconfirmed"), weekly_resets_at: "private@example.test synthetic-secret", private_token: "synthetic-secret" } as ResetTicketOutcome, { ...row, state: "cooldown" });
    const reply = await useResetTicketForApi(args, deadline());
    expect(reply).toMatchObject({ resets_left: null, expires_at: null, tickets_known: false, weekly_resets_at: null });
    expect(JSON.stringify(reply)).not.toContain("synthetic-secret");
  });

  it("bounds the inventory read without losing a completed claim", async () => {
    vi.useFakeTimers();
    mockedInvoke.mockImplementation(async (command) => command === "use_reset_ticket" ? outcome("reset", { resets_left: 2 }) : new Promise(() => {}));
    const result = useResetTicketForApi(args, Date.now() + 10);
    await vi.advanceTimersByTimeAsync(10);
    expect(await result).toMatchObject({ status: "used", resets_left: 2, expires_at: null, tickets_known: false });
  });

  it("expires before starting a claim", async () => {
    expect(await useResetTicketForApi(args, Date.now() - 1)).toMatchObject({ status: "rejected", error_code: "reset_ticket.error.request_expired" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("uses a new UUID when no request id is supplied and accepts live usage rows", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => "generated-request" });
    backend(outcome("reset"), { ...row, profile_id: "live:claude", registered: false });
    await useResetTicketForApi({ provider: "claude", profileId: "live:claude" }, deadline());
    expect(invoke).toHaveBeenCalledWith("use_reset_ticket", { profileId: "live:claude", requestId: "generated-request", expectedEmail: null, apiRequest: true, apiProvider: "claude" });
  });

  it.each([
    {}, { ...args, request_id: "private@example.test" }, { ...args, request_id: "a".repeat(65) },
    { ...args, requestId: "conflicting" }, { ...args, expectedEmail: "conflicting" },
    { ...args, expected_email: 123 }, { ...args, provider: "unsupported" },
  ])("rejects malformed args %j before invoking", async (input) => {
    await expect(useResetTicketForApi(input, deadline())).rejects.toThrow("account.use_reset_ticket.invalid_args");
    expect(invoke).not.toHaveBeenCalled();
  });
});
