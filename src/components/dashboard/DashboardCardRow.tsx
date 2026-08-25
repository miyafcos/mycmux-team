import { memo } from "react";
import type { CSSProperties } from "react";

import { agentKindColor } from "../../lib/agentKindColors";
import { useLiveBriefStore } from "../../stores/liveBriefStore";
import { useRecentInputStore } from "../../stores/recentInputStore";
import { dashboardStrings } from "./dashboardStrings";
import { instrumentLineFromTelemetry, instrumentSlotsFromTelemetry } from "./instrumentLine";
import { resolveDisplayState, type DashboardCardModel, type DashboardDisplayState } from "./dashboardModel";
import { latestInstruction as latestInstructionFromEvents } from "./liveTimelineModel";
import { stateLabels } from "./stateLabels";
import "./DashboardCardRow.css";

export function displayStateLabel(state: DashboardDisplayState): string {
  return stateLabels(state).primary;
}

export function displayStateColor(state: DashboardDisplayState): string {
  if (state === "needsHuman") return "var(--status-waiting)";
  if (state === "error") return "var(--status-error)";
  if (state === "running") return "var(--status-working)";
  if (state === "noUpdate") return "var(--cmux-status-stall)";
  if (state === "done" || state === "acknowledged") return "var(--status-done)";
  return "var(--cmux-text-tertiary)";
}

export function stallLabel(reason: string): string {
  if (reason === "pty_dead") return dashboardStrings.stallPtyDead;
  if (reason === "queued_input") return dashboardStrings.stallQueuedInput;
  return dashboardStrings.stallNoOutput;
}

export function statePillStyle(color: string): CSSProperties {
  return {
    flex: "0 0 auto",
    borderRadius: "4px",
    padding: "0 6px",
    fontSize: 10,
    background: `color-mix(in srgb, ${color} 15%, transparent)`,
    color,
  };
}

export const instructionBlockStyle: CSSProperties = {
  background: "color-mix(in srgb, var(--cmux-accent) 10%, transparent)",
  borderLeft: "2px solid var(--cmux-accent)",
  borderRadius: "0 var(--cmux-radius-md) var(--cmux-radius-md) 0",
  padding: "var(--cmux-space-2) var(--cmux-space-5)",
};

function CardRow({ card, selected, open, now, hideWorkspaceBadge, onSelect, onJump }: {
  card: DashboardCardModel;
  selected: boolean;
  open: boolean;
  now: number;
  hideWorkspaceBadge: boolean;
  onSelect: (tabId: string) => void;
  onJump: (card: DashboardCardModel) => void;
}) {
  const state = resolveDisplayState(card);
  const recentInput = useRecentInputStore((store) => store.recentBySession[card.tab.sessionId]);
  const listEvents = useLiveBriefStore((store) => store.listEventsBySession[card.tab.sessionId]);
  const instruction = card.latestInstruction
    ?? (listEvents ? latestInstructionFromEvents(listEvents) : null)
    ?? recentInput?.text
    ?? null;
  const preview = card.brief?.pendingPrompt
    ?? card.activityText
    ?? card.checkpoint
    ?? instruction
    ?? card.task
    ?? card.lastLog
    ?? card.metadata?.cwd
    ?? dashboardStrings.listEmpty;
  const labels = stateLabels(state);
  const stateColor = displayStateColor(state);
  const elapsedMinutes = card.noUpdateMinutes
    ?? (card.lastActivityAt ? Math.max(0, Math.floor((now - card.lastActivityAt) / 60_000)) : null);
  const agentColor = agentKindColor(card.agentKind === "none" ? undefined : card.agentKind)?.fg
    ?? "var(--cmux-text-tertiary)";
  const tone = state === "needsHuman" ? " is-ask" : state === "error" || state === "noUpdate" ? " is-error" : "";
  const instrumentSid = card.metadata?.agentSessionId ?? card.brief?.agentSessionId ?? card.tab.agentSessionId;
  const instrumentSlots = instrumentSlotsFromTelemetry(card.telemetry, instrumentSid, { compactContext: true });
  const instrumentTitle = instrumentLineFromTelemetry(card.telemetry, instrumentSid);

  return <button
    type="button"
    className={`cmux-dash-row${tone}${selected ? " is-selected" : ""}${open && !selected ? " is-open" : ""}`}
    data-dashboard-row={card.tab.id}
    data-dashboard-open={open || undefined}
    data-dashboard-active={selected || undefined}
    data-dashboard-state={state}
    aria-pressed={selected}
    onClick={() => onSelect(card.tab.id)}
    onDoubleClick={() => onJump(card)}
    style={{ boxShadow: selected ? "0 0 0 1px var(--cmux-accent)" : undefined }}
  >
    <span className="cmux-dash-row-agent" aria-hidden="true" style={{ background: agentColor }} />
    <span className="cmux-dash-row-body">
      <span className="cmux-dash-row-title">
        <strong>{card.label}</strong>
        {hideWorkspaceBadge ? null : <span className="cmux-dash-row-workspace">{card.workspace.name}</span>}
      </span>
      <span className="cmux-dash-row-preview">{preview}</span>
      <span className="cmux-dash-row-status">
        <span title={labels.tooltip} aria-label={labels.tooltip} style={statePillStyle(stateColor)}>{card.neverStarted ? dashboardStrings.stateNotStarted : labels.primary}</span>
        <span className="cmux-dash-row-activity">{labels.activityLabel}</span>
        {elapsedMinutes === null ? null : <span className="cmux-dash-row-elapsed">{dashboardStrings.elapsed(elapsedMinutes)}</span>}
      </span>
      {instrumentSlots.length ? <span className="cmux-dash-row-instrument" data-dashboard-instrument={card.tab.id} title={instrumentTitle}>
        {instrumentSlots.map((slot) => (
          <span key={slot.kind} className="cmux-dash-row-instrument-slot" data-instrument-slot={slot.kind}>{slot.text}</span>
        ))}
      </span> : null}
    </span>
  </button>;
}

export const DashboardCardRow = memo(CardRow);
