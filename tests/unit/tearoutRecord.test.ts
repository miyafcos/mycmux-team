import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
import { TearoutRecord } from "../../src/lib/tearout/record";
beforeEach(() => mocks.invoke.mockClear());
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
