import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
import { TearoutRecord, configureTearoutInputEvidence } from "../../src/lib/tearout/record";
import { beginTearoutOperation, endTearoutOperation, localTearoutRefusal, restoringTearoutOperation,
  observeTearoutMove, clearObservedTearoutMoves, reserveIncomingTearout, finishIncomingTearout } from "../../src/lib/tearout/operation";
import { recordTearoutRefusal } from "../../src/lib/tearout/refusal";
beforeEach(() => { mocks.invoke.mockClear(); configureTearoutInputEvidence(false); });
describe("one metadata record per native gesture", () => {
  it("2a retains attempted destination, failed checkpoint and both windows' stage timestamps", async () => {
    const record = new TearoutRecord("attempted", "tab", "child", 10);
    record.attempted({ kind: "pane-zone", workspaceId: "w", paneId: "p", zone: "right" }, "main");
    record.decision("approved");
    record.diagnostics({ failure_checkpoint: "consume", recovery_reason: "restore_failed", revoke_reason: "revoke_failed",
      dock_stages: [{ side: "child", stage: "prepared", at: 20 }, { side: "receiver", stage: "consume_wait", at: 30 }] });
    record.diagnostics({ dock_stages: [{ side: "receiver", stage: "consume_wait", at: 31 }] });
    record.failure("tearout_drop_target_changed", "docking"); await record.finish("failed_restored");
    expect(mocks.invoke.mock.calls[0][1].record).toMatchObject({ destination: null, receiver_window: "main",
      attempted_destination: { kind: "right", workspace_id: "w", pane_id: "p" }, failure_checkpoint: "consume",
      recovery_reason: "restore_failed", revoke_reason: "revoke_failed", release_decision: "approved", release_target_kind: "right",
      dock_stages: [{ side: "child", stage: "prepared", at: 20 }, { side: "receiver", stage: "consume_wait", at: 30 }] });
  });
  it.each([false, true])("2a captures current highlight at release after clearing=%s", async cleared => {
    const record = new TearoutRecord("highlight", "tab", "child", 10);
    record.highlighted(20, 15, "main");
    if (cleared) record.clearedHighlight(25);
    record.native({ phase: "end", at: 30, native_started_at: 15, scale: 1, monitor: null, focus_stolen: false });
    record.clearedHighlight(30, true);
    await record.finish("kept_window");
    expect(mocks.invoke.mock.calls[0][1].record).toMatchObject({ highlighted_at: 20,
      highlight_cleared_at: 30, highlight_at_release: !cleared });
  });
  it("2a orders delayed highlight messages by event time and ignores post-release cleanup", async () => {
    const record = new TearoutRecord("late-highlight", "tab", "child", 10);
    record.clearedHighlight(40, true);
    record.native({ phase: "end", at: 30, native_started_at: 15, scale: 1, monitor: null, focus_stolen: false });
    record.highlighted(20, 15, "main");
    expect(record.forRetire({ kind: "workspace" }, "main").highlight_at_release).toBe(true);
    record.clearedHighlight(25);
    await record.finish("kept_window");
    expect(mocks.invoke.mock.calls[0][1].record).toMatchObject({ highlight_at_release: false, highlight_cleared_at: 40 });
  });
  it("2a supplies receiver_window for docked retirement and freezes the serialized stage snapshot", () => {
    const record = new TearoutRecord("retired", "tab", "child", 10);
    const value = record.forRetire({ kind: "workspace" }, "main");
    record.highlighted(20, 15, "stale-hover-receiver");
    record.diagnostics({ dock_stages: [{ side: "receiver", stage: "receipt", at: 40 }] });
    expect(value.receiver_window).toBe("main"); expect(value.dock_stages).toEqual([]);
    expect(record.forRetire({ kind: "workspace" }).receiver_window).toBe("main");
  });
  it("2a keeps serialized record keys and diagnostic enum values inside Rust's strict schema", () => {
    const schema = readFileSync(new URL("../../src-tauri/src/tearout/log.rs", import.meta.url), "utf8");
    const fields = schema.split("pub struct DragRecord {")[1].split("\n}")[0];
    const record = new TearoutRecord("schema", "tab", "child", 10).forRetire({ kind: "workspace" }, "main");
    for (const key of Object.keys(record)) expect(fields, key).toMatch(new RegExp(`\\b${key}:`));
    for (const [name, values] of Object.entries({
      FailureCheckpoint: ["consume", "receiver_validation", "receipt_timeout", "attachment_timeout", "other"],
      RefusalSource: ["band", "pointer", "phase", "observed_move", "incoming", "backend_pre_ownership", "backend_release", "backend_transfer"],
      BlockerPhase: ["moving", "restoring"],
      ReleaseDecision: ["no_receiver", "no_hit", "layout_changed", "expired", "receipt_timeout", "approved",
        "no_release_point", "esc_cancelled", "receiver_timeout", "cancelled", "identity_changed"],
      ConsumeFailureReason: ["expired", "receiver_changed", "release_id_changed", "target_changed", "layout_changed", "sender_changed",
        "not_approved", "already_consumed", "disposed", "backend_rejected"],
      DockStageName: ["prepare_wait", "prepared", "phase_shown", "phase_committed", "publish_wait", "published", "delivery_sent",
        "receipt_wait", "receipt", "attachment_prepared_wait", "attachment_prepared", "consume_wait", "consumed", "session_alive_wait",
        "session_alive", "layout", "attachment_wait", "attached"],
    })) {
      const definition = schema.split(`enum ${name} {`)[1].split("}")[0];
      expect(new Set(definition.match(/\b[A-Z][A-Za-z0-9_]*\b/g)), name).toEqual(new Set(values.map(value =>
        value.split("_").map(part => part[0].toUpperCase() + part.slice(1)).join(""))));
    }
  });
  it("review2 separates the release receiver from historical highlight and attempted receiver", async () => {
    const record = new TearoutRecord("receiver-semantics", "tab", "child", 10);
    record.native({ phase: "end", at: 30, native_started_at: 15, scale: 1, monitor: null, focus_stolen: false, receiver: "under-pointer" });
    expect(record.forRetire({ kind: "workspace" })).toMatchObject({ receiver_window: null, release_receiver_window: "under-pointer" });
    record.highlighted(20, 15, "highlighted");
    expect(record.forRetire({ kind: "workspace" }).receiver_window).toBe("highlighted");
    record.attempted({ kind: "workspace" }, "attempted");
    record.decision("approved"); record.decision("layout_changed");
    await record.finish("failed_restored");
    expect(mocks.invoke.mock.calls[0][1].record).toMatchObject({ receiver_window: "attempted", release_receiver_window: "under-pointer", release_decision: "approved" });
  });
  it("review2 retains independent cleanup reasons and transferred identities without claiming failed sessions", async () => {
    const record = new TearoutRecord("independent-diagnostics", "tab", "child", 10);
    record.diagnostics({ receiver_cleanup_reason: "receiver_failed", recovery_reason: "child_failed", revoke_reason: "revoke_failed",
      release_cancel_reason: "cancel_failed", restore_unconfirmed: true, transferred_session_ids: ["pty-live"], consume_failure_reason: "expired" });
    record.failure("original", "restoring", ["pty-live"], "docking");
    await record.finish("restore_failed");
    expect(mocks.invoke.mock.calls[0][1].record).toMatchObject({ receiver_cleanup_reason: "receiver_failed", recovery_reason: "child_failed",
      revoke_reason: "revoke_failed", release_cancel_reason: "cancel_failed", restore_unconfirmed: true, transferred_session_ids: ["pty-live"],
      failed_session_ids: ["pty-live"], failure_phase: "restoring", failure_phase_before_restore: "docking", consume_failure_reason: "expired" });
  });
  it("keeps the actual timing, identity, destination, scale and focus without terminal contents", async () => {
    const record = new TearoutRecord("drag", "tab", "main", 10);
    record.outside(20); record.outside(21);
    record.revealed({ shown_at: 23, visible_at: 24, scale: 1.5, monitor: "DISPLAY1", focus_stolen: false });
    record.native({ at: 30, native_started_at: 28, phase: "move", scale: 1.5, monitor: "DISPLAY1", focus_stolen: false });
    record.highlighted(180, 50, "receiver");
    record.native({ at: 190, native_started_at: 28, phase: "end", scale: 2, monitor: "DISPLAY2", focus_stolen: true });
    await record.finish("docked", { kind: "tab-index", workspaceId: "w", paneId: "p", index: 2 });
    await record.finish("esc_cancelled");
    expect(mocks.invoke).toHaveBeenCalledOnce();
    const data = mocks.invoke.mock.calls[0][1].record;
    expect(data).toMatchObject({ outside_at: 20, shown_at: 23, visible_at: 24, native_started_at: 28,
      hover_started_at: 50, highlighted_at: 180, released_at: 190, result: "docked", session_id_equal: true,
      scale: 2, monitor: "DISPLAY2", focus_stolen: true, destination: { kind: "tab_strip", index: 2 } });
    expect(Object.keys(data)).not.toContain("terminal_output");
    expect(Object.keys(data)).not.toContain("command");
  });
  it("lets the backend log a self-dock after its webview has been destroyed", () => {
    const record = new TearoutRecord("regrab", "tab", "mycmux-w1", 10);
    record.error("dock_failed");
    const data = record.forRetire({ kind: "pane-zone", workspaceId: "w", paneId: "p", zone: "left" });
    expect(data.result).toBe("docked");
    expect(data.destination).toMatchObject({ kind: "left" });
    expect(data.layout_done_at).toBe(0);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe("2b refusal diagnostics and shared Rust record contract", () => {
  it("emits the shared JSON sample including native start delay and every record field", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(100);
    try {
      const record = new TearoutRecord("sample-2b", "tab", "child", 10);
      record.native({ phase: "move", at: 30, native_started_at: 25, native_start_delay_ms: 15,
        scale: 1.5, monitor: "DISPLAY1", focus_stolen: false });
      record.refusal("pointer", "owner-2b", "moving");
      record.error("move_busy"); record.failure("tearout_move_busy", "moving");
      await record.finish("rejected_busy", null, null);
      const actual = JSON.parse(JSON.stringify(mocks.invoke.mock.calls[0][1].record));
      const fixture = JSON.parse(readFileSync(new URL("../fixtures/tearout-drag-record.sample.json", import.meta.url), "utf8"));
      expect(Object.keys(actual).sort()).toEqual(Object.keys(fixture).sort());
      expect(actual).toEqual(fixture);
    } finally { clock.mockRestore(); }
  });
  it("keeps a measured zero native start delay when a later sample omits it", async () => {
    const record = new TearoutRecord("delay", "tab", "child", 10);
    const sample = { phase: "move" as const, at: 30, native_started_at: 25, scale: 1.5, monitor: null, focus_stolen: false };
    record.native({ ...sample, native_start_delay_ms: 0 }); record.native(sample);
    await record.finish("kept_window");
    expect(mocks.invoke.mock.calls[0][1].record.native_start_delay_ms).toBe(0);
  });
  it.each(["phase", "restoring", "observed_move", "incoming"])("captures the %s blocker before it ends", async source => {
    endTearoutOperation(); clearObservedTearoutMoves();
    if (source === "phase" || source === "restoring") {
      expect(beginTearoutOperation("blocker")).toBe(true);
      if (source === "restoring") restoringTearoutOperation();
      expect(beginTearoutOperation("must-not-replace-blocker")).toBe(false);
    } else if (source === "observed_move") observeTearoutMove({ id: "blocker", label: "child", phase: "move" }, "child");
    else reserveIncomingTearout("blocker");
    const refusal = localTearoutRefusal()!;
    endTearoutOperation(); clearObservedTearoutMoves(); finishIncomingTearout("blocker");
    expect(localTearoutRefusal()).toBeNull();
    await recordTearoutRefusal(new TearoutRecord("refused", "tab", "child", 10), refusal);
    expect(mocks.invoke.mock.calls[0][1].record).toMatchObject({ refusal_source: source === "restoring" ? "phase" : source,
      blocker_id: "blocker", blocker_phase: source === "restoring" ? "restoring" : "moving", result: "rejected_busy" });
    expect(beginTearoutOperation()).toBe(true);
    expect(localTearoutRefusal()?.blockerId).toBeNull(); endTearoutOperation();
  });
});

it("preserves an absent release as unmeasured and logs the recovery stage", async () => {
  const record = new TearoutRecord("busy", "tab", "main", 10);
  record.failure("tearout_move_busy", "restoring", ["pty-existing"]);
  await record.finish("rejected_busy");
  expect(mocks.invoke.mock.calls[0][1].record).toMatchObject({ released_at: null, released: false,
    failure_reason: "tearout_move_busy", failure_phase: "restoring", failed_session_ids: ["pty-existing"] });
});


it("records bounded DOM/native correlation only after test-profile opt-in", async () => {
  configureTearoutInputEvidence(true);
  const event = { pointerId: 4, timeStamp: 20, isTrusted: false } as PointerEvent;
  const point = { x: -1200.5, y: -30, at: 40, method: "native_up" as const };
  for (let i = 0; i < 257; i++) {
    const record = new TearoutRecord(`input-${i}`, "tab", "main", 10);
    record.input(event, "band");
    record.native({ at: 50, native_started_at: 25, phase: "end", scale: 2, monitor: null, focus_stolen: false, release: point });
    await record.finish("kept_window");
  }
  expect(mocks.invoke.mock.calls[0][1].record).toMatchObject({ input_evidence: { pointer_id: 4, trusted: false, surface: "band" },
    release_point: { point, receiver_window: null, receiver_epoch: null, client_x: null, client_y: null }, released_at: 40 });
  expect(mocks.invoke.mock.calls[256][1].record).toMatchObject({ input_evidence: null, release_point: null });
  configureTearoutInputEvidence(false);
  const ordinary = new TearoutRecord("ordinary", "tab", "main", 10); ordinary.input(event, "band"); await ordinary.finish("kept_window");
  expect(mocks.invoke.mock.calls.at(-1)![1].record.input_evidence).toBeNull();
});

it("persists native start alignment independently of cursor tracking lag", async () => {
  const record = new TearoutRecord("aligned", "p", "main", 1);
  const alignment = { cursor:[300, 400] as [number, number], before:[100, 200] as [number, number],
    expected:[250, 370] as [number, number], after:[250, 370] as [number, number], scale:1.5, error_before_px:226.715, error_after_px:0 };
  record.native({native_started_at:25,at:25,phase:"move",scale:1.5,monitor:"test",focus_stolen:false,start_alignment:alignment});
  await record.finish("kept_window");
  expect(mocks.invoke).toHaveBeenLastCalledWith("tearout_log_record", {record:expect.objectContaining({start_alignment:alignment})});
});
