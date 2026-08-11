import { memo } from "react";

import { AgentKindIcon } from "../icons/AgentIcons";
import { useRecentInputStore } from "../../stores/recentInputStore";
import { attentionDetail } from "../../stores/sessionAttentionStore";
import type { DashboardCardModel } from "./dashboardModel";
import { dashboardStrings } from "./dashboardStrings";

function elapsedLabel(at: number, now: number): string {
  if (!at) return "";
  return `${Math.max(0, Math.floor((now - at) / 60_000))}m`;
}

function statusColor(status: DashboardCardModel["status"]): string {
  if (status === "error") return "var(--status-error)";
  if (status === "waiting") return "var(--status-waiting)";
  if (status === "working") return "var(--status-working)";
  if (status === "done") return "var(--status-done)";
  if (status === "stalled") return "var(--cmux-yellow)";
  return "var(--cmux-text-tertiary)";
}

function groupLabel(group: DashboardCardModel["group"]): string {
  if (group === "waiting") return dashboardStrings.groupWaiting;
  if (group === "stalled") return dashboardStrings.groupStalled;
  if (group === "done") return dashboardStrings.groupDone;
  if (group === "working") return dashboardStrings.groupWorking;
  return dashboardStrings.groupIdle;
}

function InfoLine({ label, value, mono = false }: { label?: string; value: string; mono?: boolean }) {
  return <div style={{ display: "flex", gap: 6, minWidth: 0, fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-text-secondary)" }}>
    {label ? <span style={{ flex: "0 0 auto" }}>{label}</span> : null}
    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: mono ? "monospace" : undefined }}>{value}</span>
  </div>;
}

export const DashboardCard = memo(function DashboardCard({
  card,
  selected,
  now,
  urgent = false,
  onSelect,
  onJump,
}: {
  card: DashboardCardModel;
  selected: boolean;
  now: number;
  urgent?: boolean;
  onSelect: (tabId: string) => void;
  onJump: (card: DashboardCardModel) => void;
}) {
  const asking = attentionDetail(card.attention);
  const recentInput = useRecentInputStore((state) => state.recentBySession[card.tab.sessionId]);
  const stallReason = card.stall?.reason === "pty_dead"
    ? dashboardStrings.stallPtyDead
    : card.stall?.reason === "queued_input"
      ? dashboardStrings.stallQueuedInput
      : card.stall ? dashboardStrings.stallNoOutput : null;
  return <article
    role="button"
    tabIndex={-1}
    onClick={() => onSelect(card.tab.id)}
    style={{
      minWidth: 0,
      border: `1px solid ${selected ? "var(--cmux-accent)" : "var(--cmux-border)"}`,
      borderLeft: `3px solid ${statusColor(card.status)}`,
      borderRadius: "var(--cmux-radius-md)",
      padding: urgent ? 12 : 10,
      background: urgent ? "color-mix(in srgb, var(--cmux-surface) 88%, var(--cmux-accent))" : "var(--cmux-surface)",
      opacity: card.group === "done" ? 0.62 : 1,
      outline: selected ? "2px solid var(--cmux-focus-ring)" : "none",
      cursor: "pointer",
    }}
  >
    <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
      <AgentKindIcon kind={card.agentKind === "none" ? undefined : card.agentKind} size={14} />
      <strong style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "var(--cmux-font-size-sm)" }}>{card.label}</strong>
      {card.background ? <span style={badgeStyle}>{dashboardStrings.backgroundBadge}</span> : null}
      {card.unobserved ? <span style={badgeStyle}>{dashboardStrings.unobservedBadge}</span> : null}
      <span style={{ ...badgeStyle, marginLeft: "auto", color: statusColor(card.status) }}>{groupLabel(card.group)}</span>
      <span style={{ color: "var(--cmux-text-tertiary)", fontSize: "var(--cmux-font-size-xs)" }}>{elapsedLabel(card.lastActivityAt, now)}</span>
    </div>
    <div style={{ marginTop: 7, display: "grid", gap: 4 }}>
      <InfoLine value={`${card.workspace.name} › ${dashboardStrings.paneLocation(card.tabIndex + 1, card.paneIndex + 1)}${card.metadata?.cwd ? ` · ${card.metadata.cwd.split(/[\\/]/).filter(Boolean).pop()}` : ""}`} />
      {card.group !== "done" && recentInput ? <InfoLine label={dashboardStrings.myInstructionLabel} value={recentInput.text} /> : null}
      {card.group !== "done" && asking ? urgent
        ? <div style={{ color: "var(--cmux-text-secondary)", fontSize: "var(--cmux-font-size-xs)", lineHeight: "15px", maxHeight: 30, overflow: "hidden" }}>{dashboardStrings.agentAskingLabel}: {asking}</div>
        : <InfoLine label={dashboardStrings.agentAskingLabel} value={asking} /> : null}
      {card.group !== "done" && stallReason && card.stall ? <InfoLine label={stallReason} value={dashboardStrings.stallSince(Math.max(0, Math.floor((now - card.stall.since) / 60_000)))} /> : null}
      {card.group !== "done" && card.lastLog ? <InfoLine value={card.lastLog} mono /> : null}
    </div>
    {urgent ? <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
      <button type="button" style={buttonStyle} onClick={(event) => { event.stopPropagation(); onJump(card); }}>{dashboardStrings.jumpButton}</button>
    </div> : null}
  </article>;
});

const badgeStyle = { flex: "0 0 auto", border: "1px solid var(--cmux-border)", borderRadius: 999, padding: "1px 5px", fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-text-secondary)" };
const buttonStyle = { background: "transparent", border: "1px solid var(--cmux-border)", borderRadius: "var(--cmux-radius-sm)", color: "var(--cmux-text)", cursor: "pointer", fontSize: "var(--cmux-font-size-xs)", padding: "3px 7px" };
