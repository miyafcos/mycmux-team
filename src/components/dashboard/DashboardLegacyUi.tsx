// Frozen presentation for the terminal transcript, outside the dashboard.
import type { ButtonHTMLAttributes } from "react";
import { CheckCheck, CircleCheck, CircleDashed, CircleHelp, Hourglass, ListChecks, LoaderCircle, MessageCircleQuestion, Moon, Pause, Search, Square, TimerOff, TriangleAlert, XCircle, type LucideIcon } from "lucide-react";
import type { DashboardDisplayState } from "./dashboardModel";
import { dashboardStrings } from "./dashboardStrings";
import { stateLabels } from "./stateLabels";

export type DashboardStatus = DashboardDisplayState | "needsReview" | "notStarted" | "dormant" | "sending" | "sent" | "failed";

export const dashboardStatusIcons: Record<DashboardStatus, LucideIcon> = {
  needsHuman: MessageCircleQuestion, needsReview: TriangleAlert, error: XCircle,
  running: LoaderCircle, noUpdate: TimerOff, done: CircleCheck, acknowledged: CheckCheck,
  idle: Pause, stopped: Square, delegated: Hourglass, delegationUnknown: Search,
  unknown: CircleHelp, notStarted: CircleDashed, dormant: Moon, sending: LoaderCircle,
  sent: CheckCheck, failed: XCircle,
};

export function LegacyDashboardGlyph({ icon: Icon, label, className = "" }: { icon: LucideIcon; label: string; className?: string }) {
  return <span className={`cmux-dashboard-glyph ${className}`} role="img" aria-label={label} title={label}><Icon size={15} aria-hidden="true" /></span>;
}

export function LegacyDashboardStatusMark({ state, label, className = "" }: { state: DashboardStatus; label?: string; className?: string }) {
  const text = label ?? (state === "notStarted" ? dashboardStrings.stateNotStarted
    : state === "needsReview" ? dashboardStrings.stateNeedsReview
      : state === "sending" ? dashboardStrings.composerMessageSending
        : state === "sent" ? dashboardStrings.composerMessageSent
          : state === "failed" ? dashboardStrings.composerMessageFailed
            : state === "dormant" ? dashboardStrings.stateStopped : stateLabels(state).tooltip);
  return <span className={`cmux-dashboard-status-mark is-${state} ${className}`} data-dashboard-status={state}>
    <LegacyDashboardGlyph icon={dashboardStatusIcons[state]} label={text} />
  </span>;
}

export function LegacyDashboardStatusLabel({ label }: { label: string }) {
  const state: DashboardStatus = label === dashboardStrings.stateNeedsAnswer || label === dashboardStrings.stateNeedsHuman || label === "返答待ち" ? "needsHuman"
    : label === dashboardStrings.stateNeedsReview ? "needsReview"
      : label === dashboardStrings.stateRunning || label === dashboardStrings.watchRunning ? "running"
        : label === dashboardStrings.stateIdle ? "idle"
          : label === dashboardStrings.stateStopped || label === "終了済み" ? "stopped"
            : label === dashboardStrings.stateTurnEnded ? "done"
              : label === dashboardStrings.stateDone || label === dashboardStrings.manualDoneBadge ? "acknowledged"
                : label === dashboardStrings.stateNoUpdate ? "noUpdate"
                  : label === dashboardStrings.stateError ? "error"
                    : label === dashboardStrings.stateDelegated ? "delegated"
                      : label === dashboardStrings.stateDelegationUnknown ? "delegationUnknown"
                        : "unknown";
  return <LegacyDashboardStatusMark state={state} label={label} />;
}

export function LegacyDashboardCount({ count, total, label, icon = ListChecks }: { count: number; total?: number; label: string; icon?: LucideIcon }) {
  if (count <= 0) return null;
  const Icon = icon;
  return <span className="cmux-dashboard-count" role="img" aria-label={label} title={label}>
    <Icon size={15} aria-hidden="true" /><b aria-hidden="true">{total === undefined ? count : `${count} / ${total}`}</b>
  </span>;
}

export function LegacyDashboardIconButton({ icon: Icon, label, className = "", ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label"> & { icon: LucideIcon; label: string }) {
  return <button type="button" {...props} className={`cmux-dashboard-icon-button ${className}`} aria-label={label} title={props.title ?? label}>
    <Icon size={16} aria-hidden="true" />
  </button>;
}
