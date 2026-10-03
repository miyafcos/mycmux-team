import { invoke } from "@tauri-apps/api/core";
import { startTearoutFrames, finishTearoutFrames } from "./frameMetrics";
import type { DockTarget } from "../../stores/detachedDockStore";

export type TearoutResult = "kept_window" | "docked" | "esc_cancelled" | "failed_restored" | "reordered" | "cancelled_before_tearout";
export type TearoutError = "prepare_failed" | "show_failed" | "native_move_failed" | "receive_failed" | "dock_failed" | "rollback_failed" | "unexpected_failure";
export interface Reveal { shown_at: number; visible_at: number; scale: number; monitor: string | null; focus_stolen: boolean }
export interface NativeTiming { native_started_at: number | null; at: number; phase: "move" | "end"; scale: number; monitor: string | null; focus_stolen: boolean; esc_at?: number | null }
export interface RecordData {
  drag_id: string; pane_id: string; source_window: string; switch_on: boolean; down_at: number;
  grabbed_kind: "pane" | "tab" | "workspace"; pane_count: number;
  outside_at: number | null; shown_at: number | null; visible_at: number | null; native_started_at: number | null;
  hover_started_at: number | null; highlighted_at: number | null; receiver_window: string | null;
  released_at: number | null; esc_at: number | null; layout_done_at: number; result: TearoutResult; destination: ReturnType<typeof destination>;
  session_id_equal: boolean | null; scale: number | null; monitor: string | null; focus_stolen: boolean; errors: TearoutError[];
}
function destination(target: DockTarget | null) {
  if (!target) return null;
  if (target.kind === "workspace") return { kind: "sidebar", index: null, workspace_id: null, pane_id: null };
  return { kind: target.kind === "tab-index" ? "tab_strip" : target.zone, index: target.kind === "tab-index" ? target.index : null,
    workspace_id: target.workspaceId, pane_id: target.paneId };
}

export class TearoutRecord {
  private written = false;
  private data: RecordData;
  constructor(public readonly id: string, paneId: string, source: string, downAt: number,
    grabbedKind: RecordData["grabbed_kind"] = "pane", paneCount = 1) {
    startTearoutFrames(id);
    this.data = { drag_id: id, pane_id: paneId, source_window: source, switch_on: true, down_at: downAt,
      grabbed_kind: grabbedKind, pane_count: paneCount,
      outside_at: null, shown_at: null, visible_at: null, native_started_at: null, hover_started_at: null,
      highlighted_at: null, receiver_window: null, released_at: null, esc_at: null, layout_done_at: 0, result: "kept_window",
      destination: null, session_id_equal: true, scale: null, monitor: null, focus_stolen: false, errors: [] };
  }
  outside(at: number): void { this.data.outside_at ??= at; }
  transport(kind: RecordData["grabbed_kind"], count: number): void { this.data.grabbed_kind = kind; this.data.pane_count = count; }
  escaped(at: number): void { this.data.esc_at ??= at; }
  revealed(reveal: Reveal): void { Object.assign(this.data, reveal); }
  native(sample: NativeTiming): void {
    if (sample.native_started_at) this.data.native_started_at = sample.native_started_at;
    this.data.scale = sample.scale; this.data.monitor = sample.monitor;
    this.data.focus_stolen ||= sample.focus_stolen;
    if (sample.phase === "end") this.data.released_at = sample.at;
    if (sample.esc_at) this.data.esc_at ??= sample.esc_at;
  }
  highlighted(at: number, hoverAt: number, receiver: string): void {
    this.data.highlighted_at = at; this.data.hover_started_at = hoverAt; this.data.receiver_window = receiver;
  }
  error(code: TearoutError): void { if (!this.data.errors.includes(code)) this.data.errors.push(code); }
  identity(equal: boolean | null): void { this.data.session_id_equal = equal; }
  forRetire(target: DockTarget): RecordData {
    finishTearoutFrames(this.id);
    return { ...this.data, result: "docked", destination: destination(target) };
  }
  async finish(result: TearoutResult, target: DockTarget | null = null, identity: boolean | null = this.data.session_id_equal): Promise<void> {
    if (this.written) return;
    this.written = true;
    finishTearoutFrames(this.id);
    this.data.result = result; this.data.destination = destination(target);
    this.data.session_id_equal = identity; this.data.layout_done_at = Date.now();
    if (this.data.released_at == null) this.data.released_at = this.data.layout_done_at;
    await invoke("tearout_log_record", { record: this.data });
  }
}

export const activeTearoutRecords = new Map<string, TearoutRecord>();
