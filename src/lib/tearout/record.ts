import { invoke } from "@tauri-apps/api/core";
import { startTearoutFrames, finishTearoutFrames } from "./frameMetrics";
import type { ReleasePoint } from "./release";
import type { DockTarget } from "../../stores/detachedDockStore";

export type TearoutResult = "kept_window" | "handed_off" | "handoff_failed" | "docked" | "esc_cancelled" | "failed_restored" | "reordered" | "cancelled_before_tearout" | "rejected_busy" | "restore_failed";
export type TearoutError = "prepare_failed" | "show_failed" | "native_move_failed" | "receive_failed" | "dock_failed" | "rollback_failed" | "unexpected_failure" | "move_busy";
export interface Reveal { shown_at: number; visible_at: number; scale: number; monitor: string | null; focus_stolen: boolean }
export interface ReleaseEvidence { point: ReleasePoint; receiver_window: string | null; receiver_epoch: number | null; client_x: number | null; client_y: number | null }
export interface InputEvidence { pointer_id: number; event_at: number; trusted: boolean; surface: "band" | "strip" | "sidebar" }
let inputEvidenceEnabled = false;
let evidenceCount = 0;
export function configureTearoutInputEvidence(enabled: boolean): void { inputEvidenceEnabled = enabled; if (!enabled) evidenceCount = 0; }

export interface StartAlignment {
  cursor: [number, number]; before: [number, number]; expected: [number, number]; after: [number, number];
  scale: number; error_before_px: number; error_after_px: number;
}
export interface NativeTiming { start_alignment?: StartAlignment | null; native_started_at: number | null; at: number; phase: "move" | "end"; scale: number; monitor: string | null; focus_stolen: boolean; esc_at?: number | null; release?: ReleasePoint | null; receiver?: string | null; receiver_epoch?: number; client_x?: number; client_y?: number }
export interface RecordData {
  input_evidence: InputEvidence | null; release_point: ReleaseEvidence | null;
  drag_id: string; pane_id: string; source_window: string; switch_on: boolean; down_at: number;
  grabbed_kind: "pane" | "tab" | "workspace"; pane_count: number;
  start_alignment: StartAlignment | null;
  outside_at: number | null; shown_at: number | null; visible_at: number | null; native_started_at: number | null;
  hover_started_at: number | null; highlighted_at: number | null; receiver_window: string | null;
  released_at: number | null; esc_at: number | null; layout_done_at: number; result: TearoutResult; destination: ReturnType<typeof destination>;
  released: boolean; failure_reason: string | null; failure_phase: string | null; failed_session_ids: string[];
  session_id_equal: boolean | null; scale: number | null; monitor: string | null; focus_stolen: boolean; errors: TearoutError[];
}
function destination(target: DockTarget | null) {
  if (!target) return null;
  if (target.kind === "workspace") return { kind: "sidebar", index: null, workspace_id: null, pane_id: null };
  return { kind: target.kind === "tab-index" ? "tab_strip" : target.kind === "handoff" ? "handoff" : target.zone, index: target.kind === "tab-index" ? target.index : null,
    workspace_id: target.workspaceId, pane_id: target.paneId };
}

export class TearoutRecord {
  private written = false;
  private evidence = inputEvidenceEnabled && evidenceCount++ < 256;
  private data: RecordData;
  constructor(public readonly id: string, paneId: string, source: string, downAt: number,
    grabbedKind: RecordData["grabbed_kind"] = "pane", paneCount = 1) {
    startTearoutFrames(id);
    this.data = { input_evidence: null, release_point: null, drag_id: id, pane_id: paneId, source_window: source, switch_on: true, down_at: downAt,
      grabbed_kind: grabbedKind, pane_count: paneCount,
      start_alignment: null, outside_at: null, shown_at: null, visible_at: null, native_started_at: null, hover_started_at: null,
      highlighted_at: null, receiver_window: null, released_at: null, esc_at: null, layout_done_at: 0, result: "kept_window",
      destination: null, released: false, failure_reason: null, failure_phase: null, failed_session_ids: [], session_id_equal: true, scale: null, monitor: null, focus_stolen: false, errors: [] };
  }
  input(event: Pick<PointerEvent, "pointerId" | "timeStamp" | "isTrusted">, surface: InputEvidence["surface"]): void {
    if (!this.evidence) return;
    this.data.input_evidence = { pointer_id: event.pointerId, event_at: performance.timeOrigin + event.timeStamp, trusted: event.isTrusted, surface };
  }
  outside(at: number): void { this.data.outside_at ??= at; }
  transport(kind: RecordData["grabbed_kind"], count: number): void { this.data.grabbed_kind = kind; this.data.pane_count = count; }
  escaped(at: number): void { this.data.esc_at ??= at; }
  revealed(reveal: Reveal): void { Object.assign(this.data, reveal); }
  native(sample: NativeTiming): void {
    if (sample.start_alignment) this.data.start_alignment = sample.start_alignment;
    if (sample.native_started_at) this.data.native_started_at = sample.native_started_at;
    this.data.scale = sample.scale; this.data.monitor = sample.monitor;
    this.data.focus_stolen ||= sample.focus_stolen;
    if (sample.phase === "end") {
      this.data.released_at = sample.release?.at ?? sample.at; this.data.released = true;
      if (this.evidence && sample.release) this.data.release_point = { point: { ...sample.release }, receiver_window: sample.receiver ?? null,
        receiver_epoch: sample.receiver_epoch ?? null, client_x: sample.client_x ?? null, client_y: sample.client_y ?? null };
    }
    if (sample.esc_at) this.data.esc_at ??= sample.esc_at;
  }
  highlighted(at: number, hoverAt: number, receiver: string): void {
    this.data.highlighted_at = at; this.data.hover_started_at = hoverAt; this.data.receiver_window = receiver;
  }
  error(code: TearoutError): void { if (!this.data.errors.includes(code)) this.data.errors.push(code); }
  failure(reason: string, phase: string, sessions: string[] = []): void {
    this.data.failure_reason = reason; this.data.failure_phase = phase; this.data.failed_session_ids = [...sessions];
  }
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
    await invoke("tearout_log_record", { record: this.data });
  }
}

export const activeTearoutRecords = new Map<string, TearoutRecord>();
