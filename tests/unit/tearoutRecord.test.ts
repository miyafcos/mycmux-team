import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
import { TearoutRecord, configureTearoutInputEvidence } from "../../src/lib/tearout/record";
beforeEach(() => { mocks.invoke.mockClear(); configureTearoutInputEvidence(false); });
describe("one metadata record per native gesture", () => {
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
