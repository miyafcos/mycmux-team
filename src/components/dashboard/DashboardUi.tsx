import { createContext, useContext, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Check, CheckCheck, Hourglass, LoaderCircle, MessageSquareReply, Minus, Moon, Pause, Search, Square, TriangleAlert, X, type LucideIcon } from "lucide-react";
import type { DashboardDisplayState } from "./dashboardModel";
import { dashboardStrings } from "./dashboardStrings";
import { stateLabels } from "./stateLabels";
import "./DashboardUi.css";
import { LegacyDashboardGlyph, LegacyDashboardStatusMark, LegacyDashboardStatusLabel, LegacyDashboardCount, LegacyDashboardIconButton } from "./DashboardLegacyUi";

const DashboardUiScopeContext = createContext(true);
export function DashboardUiScope({ dashboard, children }: { dashboard: boolean; children: ReactNode }) {
  return <DashboardUiScopeContext.Provider value={dashboard}>{dashboard ? children : <div className="cmux-dashboard-legacy-ui" style={{ display: "contents" }}>{children}</div>}</DashboardUiScopeContext.Provider>;
}

export type DashboardStatus = DashboardDisplayState | "needsReview" | "notStarted" | "dormant" | "sending" | "sent" | "failed";

export const dashboardStatusIcons: Record<DashboardStatus, LucideIcon | null> = {
  needsHuman: MessageSquareReply, needsReview: TriangleAlert, error: X,
  running: LoaderCircle, noUpdate: null, done: Check, acknowledged: CheckCheck,
  idle: Pause, stopped: Square, delegated: Hourglass, delegationUnknown: Search,
  unknown: null, notStarted: Minus, dormant: Moon, sending: LoaderCircle,
  sent: CheckCheck, failed: X,
};

export function DashboardGlyph({ icon: Icon, label, className = "" }: { icon: LucideIcon; label: string; className?: string }) {
  if (!useContext(DashboardUiScopeContext)) return <LegacyDashboardGlyph icon={Icon} label={label} className={className} />;
  return <span className={`cmux-dashboard-glyph ${className}`} role="img" aria-label={label} title={label}><Icon aria-hidden="true" /></span>;
}

export function DashboardStatusMark({ state, label, className = "", hasElapsed = false }: { state: DashboardStatus; label?: string; className?: string; hasElapsed?: boolean }) {
  if (!useContext(DashboardUiScopeContext)) return <LegacyDashboardStatusMark state={state} label={label} className={className} />;
  const text = label ?? (state === "notStarted" ? dashboardStrings.stateNotStarted
    : state === "needsReview" ? dashboardStrings.stateNeedsReview
      : state === "sending" ? dashboardStrings.composerMessageSending
        : state === "sent" ? dashboardStrings.composerMessageSent
          : state === "failed" ? dashboardStrings.composerMessageFailed
            : state === "dormant" ? dashboardStrings.stateStopped : stateLabels(state).tooltip);
  const Icon = dashboardStatusIcons[state];
  const hidden = state === "unknown" || (state === "noUpdate" && hasElapsed);
  return <span className={`cmux-dashboard-status-mark is-${state}${hidden ? " cmux-dashboard-sr-only" : ""} ${className}`} data-dashboard-status={state} role="img" aria-label={text} title={text}>
    {Icon ? <Icon aria-hidden="true" /> : state === "noUpdate" && !hasElapsed ? <span aria-hidden="true">{dashboardStrings.stateNoUpdate}</span> : null}
  </span>;
}

export function DashboardStatusLabel({ label }: { label: string }) {
  if (!useContext(DashboardUiScopeContext)) return <LegacyDashboardStatusLabel label={label} />;
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
  return <DashboardStatusMark state={state} label={label} />;
}

export function DashboardCount({ count, total, label, icon }: { count: number; total?: number; label: string; icon?: LucideIcon }) {
  if (!useContext(DashboardUiScopeContext)) return <LegacyDashboardCount count={count} total={total} label={label} icon={icon} />;
  if (count <= 0 && total === undefined) return null;
  return <span className="cmux-dashboard-count" role="img" aria-label={label} title={label}>
    <b aria-hidden="true">{total === undefined ? count : `${count} / ${total}`}</b>
  </span>;
}

export function DashboardIconButton({ icon: Icon, label, className = "", ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label"> & { icon: LucideIcon; label: string }) {
  if (!useContext(DashboardUiScopeContext)) return <LegacyDashboardIconButton icon={Icon} label={label} className={className} {...props} />;
  return <button type="button" {...props} className={`cmux-dashboard-icon-button ${className}`} aria-label={label} title={props.title ?? label}>
    <Icon aria-hidden="true" />
  </button>;
}
