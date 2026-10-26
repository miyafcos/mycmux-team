import { useEffect } from "react";
import { useSessionStateClock } from "../../hooks/useSessionStateClock";
import { MessageCircleQuestion } from "lucide-react";
import { useWorkspaceListStore } from "../../stores/workspaceListStore";
import { useSessionAttentionStore } from "../../stores/sessionAttentionStore";
import { useLiveBriefStore } from "../../stores/liveBriefStore";
import { yourTurnTargets, openYourTurn } from "./yourTurn";

import { recordRecentKeystroke } from "../../stores/recentInputStore";
import { useDashboardViewStore } from "../../stores/dashboardViewStore";
import { dashboardStrings } from "./dashboardStrings";

export function DashboardButton() {
  const open = useDashboardViewStore((state) => state.open);
  const toggle = useDashboardViewStore((state) => state.toggle);
  const workspaces = useWorkspaceListStore((state) => state.workspaces);
  const attention = useSessionAttentionStore((state) => state.attentionBySession);
  const signals = useSessionAttentionStore((state) => state.statusSignalsBySession);
  const briefs = useLiveBriefStore((state) => state.briefsBySession);
  const observations = useLiveBriefStore((state) => state.observationsBySession);
  const now = useSessionStateClock();
  const targets = yourTurnTargets(workspaces, attention, briefs, signals, observations, now);
  const turnLabel = `あなたの番${targets.length ? ` ${targets.length}` : ""}`;

  useEffect(() => {
    const record = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string; data?: string }>).detail;
      if (typeof detail?.sessionId === "string" && typeof detail.data === "string") {
        recordRecentKeystroke(detail.sessionId, detail.data);
      }
    };
    window.addEventListener("mycmux:keystroke", record);
    return () => window.removeEventListener("mycmux:keystroke", record);
  }, []);

  return (
    <div style={{ height: 36, display: "flex", alignItems: "center", flexShrink: 0 }}>
      <button type="button" className="cmux-title-btn cmux-your-turn" title="未解決の質問・承認を開く"
        aria-label={`${turnLabel} — 未解決の質問・承認を開く`} onClick={() => openYourTurn(targets[0])}>
        <MessageCircleQuestion size={14} aria-hidden="true" /><span>{turnLabel}</span>
      </button>
      <button
        type="button"
        className="cmux-title-btn"
        title={dashboardStrings.buttonTitle}
        aria-label={dashboardStrings.buttonTitle}
        aria-pressed={open}
        onClick={toggle}
        style={{ background: "none", border: "none", color: "var(--cmux-text-secondary)", cursor: "pointer", padding: "3px 6px", borderRadius: 3, display: "flex", alignItems: "center" }}
      >
        {/* Drawn at 1:1, so a 1-unit stroke is one device pixel and the
            half-integer corners keep it inside a single pixel column
            instead of splitting it across two. Measured: 6% of the ink
            reached full strength before, 75% after. */}
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true">
          <rect x="1.5" y="1.5" width="4" height="4" rx=".4" />
          <rect x="7.5" y="1.5" width="4" height="4" rx=".4" />
          <rect x="1.5" y="7.5" width="4" height="4" rx=".4" />
          <rect x="7.5" y="7.5" width="4" height="4" rx=".4" />
        </svg>
      </button>
    </div>
  );
}
