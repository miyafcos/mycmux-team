import { windowLabel } from "../../lib/windowContext";
import { memo } from "react";
import { Layers, PanelsTopLeft } from "lucide-react";
import { DashboardCount, DashboardGlyph, DashboardStatusMark } from "./DashboardUi";
import type { CSSProperties } from "react";

import { useLiveBriefStore } from "../../stores/liveBriefStore";
import { dormantAgentDescription } from "../../lib/agentDormancy";
import { useRecentInputStore } from "../../stores/recentInputStore";
import { dashboardStrings } from "./dashboardStrings";
import { dashboardActivity } from "./dashboardActivity";
import { firstLine } from "./attentionModel";
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
    fontSize: "var(--cmux-font-size-xs)",
    background: `color-mix(in srgb, ${color} 15%, transparent)`,
    color,
  };
}

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
  const dormantDescription = card.neverStarted || card.telemetryHealth === "live" ? undefined : dormantAgentDescription(card.mark);
  const recentInput = useRecentInputStore((store) => store.recentBySession[card.tab.sessionId]);
  const listEvents = useLiveBriefStore((store) => store.listEventsBySession[card.tab.sessionId]);
  const instruction = card.latestInstruction
    ?? (listEvents ? latestInstructionFromEvents(listEvents) : null)
    ?? recentInput?.text
    ?? null;
  // 最後に言ったことを 1 行だけ。複数行は先頭行で切り、どれも無ければ行ごと出さない。
  const preview = firstLine(dashboardActivity(card)) ?? firstLine(card.brief?.pendingPrompt)
    ?? firstLine(card.activityText)
    ?? firstLine(card.checkpoint)
    ?? firstLine(instruction)
    ?? firstLine(card.task)
    ?? firstLine(card.lastLog)
    ?? firstLine(card.metadata?.cwd);
  const labels = stateLabels(state);
  const elapsedMinutes = card.noUpdateMinutes
    ?? (card.lastActivityAt ? Math.max(0, Math.floor((now - card.lastActivityAt) / 60_000)) : null);
  const agentColor = card.mark?.color.fg ?? "var(--cmux-text-tertiary)";
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
        {card.windowLabel && card.windowLabel !== windowLabel() ? <DashboardGlyph icon={PanelsTopLeft} label={dashboardStrings.peerWindow} className="cmux-dashboard-peer-window" /> : null}
        {hideWorkspaceBadge ? null : <span className="cmux-dash-row-workspace">{card.workspace.name}</span>}
      </span>
      {preview && preview !== dashboardStrings.stateRunning ? <span className="cmux-dash-row-preview">{preview === dashboardStrings.modelResponseWait ? <DashboardStatusMark state="running" label={preview} /> : preview === dashboardStrings.turnStateUnknown ? <DashboardStatusMark state="unknown" label={preview} /> : preview === dashboardStrings.stateDelegationUnknown ? <DashboardStatusMark state="delegationUnknown" label={preview} /> : card.brief?.autonomy?.armedBackgroundCount && preview === dashboardStrings.backgroundWork(card.brief.autonomy.armedBackgroundCount) ? <DashboardCount icon={Layers} count={card.brief.autonomy.armedBackgroundCount} label={preview} /> : preview}</span> : null}
      <span className="cmux-dash-row-status">
        <DashboardStatusMark state={card.neverStarted ? "notStarted" : state} label={card.neverStarted ? dashboardStrings.stateNotStarted : labels.tooltip} />
        {dormantDescription ? <DashboardStatusMark state="dormant" label={dormantDescription} /> : null}
        {elapsedMinutes === null ? null : <span className="cmux-dash-row-elapsed">{card.telemetryHealth === "live" ? dashboardStrings.lastActivityAgo(elapsedMinutes) : dashboardStrings.elapsed(elapsedMinutes)}</span>}
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
