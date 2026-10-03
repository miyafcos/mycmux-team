import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProfileUsage } from "../../src/lib/ipc";
import { claimResetTicket } from "../../src/lib/ipc";
import { invoke } from "@tauri-apps/api/core";
import type { ResetTicketOutcome, ResetTickets } from "../../src/lib/resetTickets";
import { createResetTicketStore } from "../../src/stores/resetTicketStore";

vi.mock("../../src/lib/appConfirmation", () => ({ cancelAppConfirmations: vi.fn(() => false), confirm: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const row: ProfileUsage = {
  profile_id: "p", provider: "claude", label: "P", email: "p@example.test", plan: "max",
  registered: true, is_active: false, needs_relogin: false, state: "ok",
  five_hour: null, seven_day: null, seven_day_sonnet: null, seven_day_opus: null,
  model_windows: [], error_code: null, retry_at: null, fetched_at: "2026-09-28T00:00:00Z",
};
const tickets: ResetTickets = {
  available: 1, expires_at: null, usable_now: true, blocked_reason: null,
  clears: ["five_hour", "seven_day"], moves_weekly_reset: false, requires_limit: false, title: null,
};
const outcome = (kind: ResetTicketOutcome["kind"]): ResetTicketOutcome => ({ kind, resets_left: null, weekly_resets_at: null });

function setup() {
  const confirm = vi.fn().mockResolvedValue(true);
  const claim = vi.fn().mockResolvedValue(outcome("reset"));
  const uuid = vi.fn().mockReturnValueOnce("first").mockReturnValueOnce("second").mockReturnValue("third");
  const refresh = vi.fn().mockResolvedValue(undefined);
  const store = createResetTicketStore({ confirm, claim, uuid, refresh });
  return { store, confirm, claim, uuid, refresh };
}

describe("reset ticket store", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows a blocked reason without a dialog", async () => {
    const { store, confirm, claim } = setup();
    await store.getState().useTicket(row, { ...tickets, usable_now: false, blocked_reason: "requires_limit" });
    expect(store.getState().message?.tone).toBe("warn");
    expect(confirm).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  it("cancels without claiming", async () => {
    const { store, confirm, claim, refresh } = setup();
    confirm.mockResolvedValue(false);
    await store.getState().useTicket(row, tickets);
    expect(claim).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(store.getState().inFlight).toEqual({});
  });

  it("sends a fresh id and the confirmed email on every press", async () => {
    const { store, claim, uuid, refresh } = setup();
    claim.mockResolvedValueOnce(outcome("unconfirmed")).mockResolvedValueOnce(outcome("reset")).mockResolvedValueOnce(outcome("reset"));
    await store.getState().useTicket(row, tickets);
    await store.getState().useTicket(row, tickets);
    await store.getState().useTicket(row, tickets);
    expect(claim).toHaveBeenNthCalledWith(1, "p", "first", "p@example.test");
    expect(claim).toHaveBeenNthCalledWith(2, "p", "second", "p@example.test");
    expect(claim).toHaveBeenNthCalledWith(3, "p", "third", "p@example.test");
    expect(uuid).toHaveBeenCalledTimes(3);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("clears a rejected request and reports the invoke error", async () => {
    const { store, claim, refresh } = setup();
    claim.mockRejectedValue(new Error("failed"));
    await store.getState().useTicket(row, tickets);
    expect(store.getState().message?.tone).toBe("error");
    expect(store.getState().message?.text).toContain("failed");
    expect(refresh).toHaveBeenCalledOnce();
    store.getState().dismiss();
    expect(store.getState().message).toBeNull();
  });

  it("ignores a second press while the first is in flight", async () => {
    const { store, claim, confirm } = setup();
    let resolve!: (value: ResetTicketOutcome) => void;
    claim.mockReturnValue(new Promise<ResetTicketOutcome>((done) => { resolve = done; }));
    const first = store.getState().useTicket(row, tickets);
    await Promise.resolve();
    await store.getState().useTicket(row, tickets);
    expect(confirm).toHaveBeenCalledOnce();
    resolve(outcome("reset"));
    await first;
    expect(store.getState().inFlight).toEqual({});
  });
});

it("passes the IPC argument names expected by the Rust command", async () => {
  vi.mocked(invoke).mockResolvedValue(outcome("reset"));
  await claimResetTicket("p", "request-1", "p@example.test");
  expect(invoke).toHaveBeenCalledWith("use_reset_ticket", { profileId: "p", requestId: "request-1", expectedEmail: "p@example.test" });
});
