import { invoke } from "@tauri-apps/api/core";
import { startTearoutFrames, finishTearoutFrames } from "./frameMetrics";
import type { ReleasePoint, ConsumeFailureReason } from "./release";
import type { DockTarget } from "../../stores/detachedDockStore";
import type { TearoutRefusalSource } from "./operation";

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
export interface NativeTiming { native_start_delay_ms?: number | null; start_alignment?: StartAlignment | null; native_started_at: number | null; at: number; phase: "move" | "end"; scale: number; monitor: string | null; focus_stolen: boolean; esc_at?: number | null; release?: ReleasePoint | null; receiver?: string | null; receiver_epoch?: number; client_x?: number; client_y?: number }
export type FailureCheckpoint = "consume" | "receiver_validation" | "receipt_timeout" | "attachment_timeout" | "other";
export type ReleaseDecision = "no_receiver" | "no_hit" | "layout_changed" | "expired" | "receipt_timeout" | "approved"
  | "no_release_point" | "esc_cancelled" | "receiver_timeout" | "cancelled" | "identity_changed";
export type DockStageName = "prepare_wait" | "prepared" | "phase_shown" | "phase_committed" | "publish_wait" | "published"
  | "delivery_sent" | "receipt_wait" | "receipt" | "attachment_prepared_wait" | "attachment_prepared" | "consume_wait" | "consumed"
  | "session_alive_wait" | "session_alive" | "layout" | "attachment_wait" | "attached";
export interface DockStage { side: "child" | "receiver"; stage: DockStageName; at: number }
export interface DockDiagnostics {
  failure_checkpoint?: FailureCheckpoint; recovery_reason?: string; revoke_reason?: string; dock_stages?: DockStage[];
  receiver_cleanup_reason?: string; release_cancel_reason?: string; restore_unconfirmed?: boolean;
  transferred_session_ids?: string[]; consume_failure_reason?: ConsumeFailureReason;
}
export function mergeDockDiagnostics(into: DockDiagnostics, update: DockDiagnostics): void {
  if (update.failure_checkpoint) into.failure_checkpoint = update.failure_checkpoint;
  if (update.recovery_reason) into.recovery_reason = update.recovery_reason;
  if (update.revoke_reason) into.revoke_reason = update.revoke_reason;
  if (update.receiver_cleanup_reason) into.receiver_cleanup_reason = update.receiver_cleanup_reason;
  if (update.release_cancel_reason) into.release_cancel_reason = update.release_cancel_reason;
  if (update.restore_unconfirmed) into.restore_unconfirmed = true;
  if (update.transferred_session_ids) into.transferred_session_ids = [...update.transferred_session_ids];
  if (update.consume_failure_reason) into.consume_failure_reason = update.consume_failure_reason;
  for (const stage of update.dock_stages ?? []) {
    into.dock_stages ??= [];
    if (!into.dock_stages.some(previous => previous.side === stage.side && previous.stage === stage.stage)) into.dock_stages.push({ ...stage });
  }
}
export interface RecordData {
  input_evidence: InputEvidence | null; release_point: ReleaseEvidence | null;
  drag_id: string; pane_id: string; source_window: string; switch_on: boolean; down_at: number;
  grabbed_kind: "pane" | "tab" | "workspace"; pane_count: number;
  start_alignment: StartAlignment | null;
  refusal_source: TearoutRefusalSource | null; blocker_id: string | null; blocker_phase: "moving" | "restoring" | null;
  native_start_delay_ms: number | null;
  outside_at: number | null; shown_at: number | null; visible_at: number | null; native_started_at: number | null;
  hover_started_at: number | null; highlighted_at: number | null; receiver_window: string | null;
  released_at: number | null; esc_at: number | null; layout_done_at: number; result: TearoutResult; destination: ReturnType<typeof destination>;
  released: boolean; failure_reason: string | null; failure_phase: string | null; failed_session_ids: string[];
  session_id_equal: boolean | null; scale: number | null; monitor: string | null; focus_stolen: boolean; errors: TearoutError[];
  attempted_destination: ReturnType<typeof destination>; failure_checkpoint: FailureCheckpoint | null;
  recovery_reason: string | null; revoke_reason: string | null; dock_stages: DockStage[];
  receiver_cleanup_reason: string | null; release_cancel_reason: string | null; restore_unconfirmed: boolean;
  release_receiver_window: string | null; transferred_session_ids: string[]; failure_phase_before_restore: string | null;
  consume_failure_reason: ConsumeFailureReason | null;
  highlight_at_release: boolean | null; highlight_cleared_at: number | null; release_decision: ReleaseDecision | null;
  release_target_kind: NonNullable<ReturnType<typeof destination>>["kind"] | null;
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
  private highlights: { at: number; active: boolean }[] = [];
  private data: RecordData;
  constructor(public readonly id: string, paneId: string, source: string, downAt: number,
    grabbedKind: RecordData["grabbed_kind"] = "pane", paneCount = 1) {
    startTearoutFrames(id);
    this.data = { input_evidence: null, release_point: null, drag_id: id, pane_id: paneId, source_window: source, switch_on: true, down_at: downAt,
      grabbed_kind: grabbedKind, pane_count: paneCount,
      refusal_source: null, blocker_id: null, blocker_phase: null, native_start_delay_ms: null,
      start_alignment: null, outside_at: null, shown_at: null, visible_at: null, native_started_at: null, hover_started_at: null,
      highlighted_at: null, receiver_window: null, released_at: null, esc_at: null, layout_done_at: 0, result: "kept_window",
      destination: null, attempted_destination: null, failure_checkpoint: null, recovery_reason: null, revoke_reason: null, dock_stages: [],
      receiver_cleanup_reason: null, release_cancel_reason: null, restore_unconfirmed: false,
      release_receiver_window: null, transferred_session_ids: [], failure_phase_before_restore: null, consume_failure_reason: null,
      highlight_at_release: null, highlight_cleared_at: null, release_decision: null, release_target_kind: null,
      released: false, failure_reason: null, failure_phase: null, failed_session_ids: [], session_id_equal: true, scale: null, monitor: null, focus_stolen: false, errors: [] };
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
    if (sample.native_start_delay_ms != null) this.data.native_start_delay_ms = sample.native_start_delay_ms;
    if (sample.start_alignment) this.data.start_alignment = sample.start_alignment;
    if (sample.native_started_at) this.data.native_started_at = sample.native_started_at;
    this.data.scale = sample.scale; this.data.monitor = sample.monitor;
    this.data.focus_stolen ||= sample.focus_stolen;
    if (sample.phase === "end") {
      this.data.released_at = sample.release?.at ?? sample.at; this.data.released = true;
      // Cleanup of the painted frame after pointer-up must not rewrite history.
      this.releaseHighlight();
      this.data.release_receiver_window = sample.receiver ?? null;
      if (this.evidence && sample.release) this.data.release_point = { point: { ...sample.release }, receiver_window: sample.receiver ?? null,
        receiver_epoch: sample.receiver_epoch ?? null, client_x: sample.client_x ?? null, client_y: sample.client_y ?? null };
    }
    if (sample.esc_at) this.data.esc_at ??= sample.esc_at;
  }
  highlighted(at: number, hoverAt: number, receiver: string): void {
    if (this.data.highlighted_at === null || at >= this.data.highlighted_at) {
      this.data.highlighted_at = at; this.data.hover_started_at = hoverAt;
      if (!this.data.attempted_destination) this.data.receiver_window = receiver;
    }
    this.updateHighlight(at, true);
  }
  clearedHighlight(at: number, afterRelease = false): void {
    this.data.highlight_cleared_at = Math.max(at, this.data.highlight_cleared_at ?? at);
    if (!afterRelease) this.updateHighlight(at, false);
  }
  private updateHighlight(at: number, active: boolean): void {
    this.highlights.push({ at, active });
    this.highlights.sort((a, b) => a.at - b.at);
    this.highlights = this.highlights.slice(-64);
    this.releaseHighlight();
  }
  private releaseHighlight(): void {
    if (this.data.released_at === null) return;
    this.data.highlight_at_release = this.highlights.filter(event => event.at <= this.data.released_at!).slice(-1)[0]?.active === true;
  }
  attempted(target: DockTarget, receiver: string): void {
    this.data.attempted_destination = destination(target); this.data.receiver_window = receiver;
    this.data.release_target_kind = destination(target)!.kind;
  }
  decision(value: ReleaseDecision, target?: DockTarget | null): void {
    this.data.release_decision ??= value;
    if (target) this.data.release_target_kind = destination(target)!.kind;
  }
  diagnostics(update: DockDiagnostics): void {
    const details: DockDiagnostics = { dock_stages: this.data.dock_stages };
    mergeDockDiagnostics(details, update);
    this.data.failure_checkpoint = details.failure_checkpoint ?? this.data.failure_checkpoint;
    this.data.recovery_reason = details.recovery_reason ?? this.data.recovery_reason;
    this.data.revoke_reason = details.revoke_reason ?? this.data.revoke_reason;
    this.data.receiver_cleanup_reason = details.receiver_cleanup_reason ?? this.data.receiver_cleanup_reason;
    this.data.release_cancel_reason = details.release_cancel_reason ?? this.data.release_cancel_reason;
    this.data.restore_unconfirmed ||= details.restore_unconfirmed === true;
    this.data.transferred_session_ids = details.transferred_session_ids ?? this.data.transferred_session_ids;
    this.data.consume_failure_reason = details.consume_failure_reason ?? this.data.consume_failure_reason;
  }
  error(code: TearoutError): void { if (!this.data.errors.includes(code)) this.data.errors.push(code); }
  refusal(source: TearoutRefusalSource, blockerId: string | null, phase: "moving" | "restoring"): void {
    this.data.refusal_source = source; this.data.blocker_id = blockerId; this.data.blocker_phase = phase;
  }
  failure(reason: string, phase: string, sessions: string[] = [], beforeRestore?: string): void {
    this.data.failure_reason = reason; this.data.failure_phase = phase; this.data.failed_session_ids = [...sessions];
    this.data.failure_phase_before_restore = beforeRestore ?? null;
  }
  identity(equal: boolean | null): void { this.data.session_id_equal = equal; }
  forRetire(target: DockTarget, receiver?: string): RecordData {
    if (receiver) this.attempted(target, receiver);
    finishTearoutFrames(this.id);
    return { ...this.data, dock_stages: this.data.dock_stages.map(stage => ({ ...stage })), result: "docked", destination: destination(target) };
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
