import { useCallback, useEffect, useRef, useState } from "react";

import { getTerminalWriteCounter, hasTerminalBuffer } from "../terminal/XTermWrapper";
import { readPaneTail } from "../layout/socketCommands";
import { useRecentInputStore } from "../../stores/recentInputStore";
import { attentionDetail, useSessionAttentionStore } from "../../stores/sessionAttentionStore";
import type { DashboardCardModel } from "./dashboardModel";
import { dashboardStrings } from "./dashboardStrings";

export function DashboardDetailPane({ card, now, onJump }: {
  card: DashboardCardModel | null;
  now: number;
  onJump: (card: DashboardCardModel) => void;
}) {
  const [lines, setLines] = useState<string[]>([]);
  const [unobserved, setUnobserved] = useState(false);
  const writeCounterRef = useRef<number | null>(null);
  const recentInput = useRecentInputStore((state) => card ? state.recentBySession[card.tab.sessionId] : undefined);
  const markSeen = useSessionAttentionStore((state) => state.markSeen);
  const refresh = useCallback(async () => {
    if (!card) return;
    const counter = getTerminalWriteCounter(card.tab.sessionId);
    if (writeCounterRef.current === counter && lines.length) return;
    writeCounterRef.current = counter;
    try {
      setLines(await readPaneTail(card.tab.sessionId, 40));
      setUnobserved(false);
    } catch {
      setLines([]);
      setUnobserved(true);
    }
  }, [card, lines.length]);

  useEffect(() => {
    writeCounterRef.current = null;
    setLines([]);
    setUnobserved(false);
    if (!card) return;
    void refresh();
    const interval = window.setInterval(() => {
      if (hasTerminalBuffer(card.tab.sessionId)) void refresh();
    }, 2_000);
    return () => window.clearInterval(interval);
  }, [card, refresh]);

  if (!card) return <aside style={paneStyle}><span style={{ color: "var(--cmux-text-secondary)", fontSize: 12 }}>{dashboardStrings.detailEmpty}</span></aside>;
  const detail = attentionDetail(card.attention);
  const elapsed = card.lastActivityAt ? `${Math.max(0, Math.floor((now - card.lastActivityAt) / 60_000))}m` : "";
  return <aside style={paneStyle}>
    <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
      <strong style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }}>{card.workspace.name} › {dashboardStrings.paneLocation(card.tabIndex + 1, card.paneIndex + 1)}</strong>
      <span style={statusStyle}>{groupLabel(card.group)}</span>
      <span style={{ marginLeft: "auto", color: "var(--cmux-text-tertiary)", fontSize: 11 }}>{elapsed}</span>
    </div>
    <div style={{ display: "grid", gap: 6, marginTop: 12, fontSize: 11, color: "var(--cmux-text-secondary)" }}>
      <div>{card.metadata?.cwd ?? ""}</div>
      {recentInput ? <div>{dashboardStrings.myInstructionLabel}: {recentInput.text}</div> : null}
      {detail ? <div>{dashboardStrings.agentAskingLabel}: {detail}</div> : null}
      {card.stall ? <div>{card.stall.reason}: {Math.max(0, Math.floor((now - card.stall.since) / 60_000))}m</div> : null}
    </div>
    <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
      <button type="button" style={buttonStyle} onClick={() => onJump(card)}>{dashboardStrings.jumpButtonTitle}</button>
      {card.attentionCategory === "done" && card.attention?.attentionId ? <button type="button" style={buttonStyle} onClick={() => markSeen(card.tab.id, card.attention?.attentionId ?? "")}>{dashboardStrings.markReadButton}</button> : null}
    </div>
    <div style={{ marginTop: 14, fontSize: 11, color: "var(--cmux-text-secondary)" }}>{dashboardStrings.tailTitle}</div>
    <pre style={{ flex: 1, minHeight: 0, overflow: "auto", margin: "6px 0 0", padding: 10, border: "1px solid var(--cmux-border)", borderRadius: "var(--cmux-radius-sm)", background: "var(--cmux-bg)", color: "var(--cmux-text)", fontSize: 11, whiteSpace: "pre-wrap", fontFamily: "monospace" }}>{unobserved ? dashboardStrings.unobservedBadge : lines.join("\n")}</pre>
  </aside>;
}

const paneStyle = { minWidth: "clamp(360px, 32vw, 520px)", width: "clamp(360px, 32vw, 520px)", display: "flex", flexDirection: "column" as const, padding: 12, borderLeft: "1px solid var(--cmux-border)", background: "var(--cmux-popover)", overflow: "hidden" };
const buttonStyle = { background: "transparent", border: "1px solid var(--cmux-border)", borderRadius: "var(--cmux-radius-sm)", color: "var(--cmux-text)", cursor: "pointer", fontSize: 11, padding: "4px 7px" };
const statusStyle = { flex: "0 0 auto", border: "1px solid var(--cmux-border)", borderRadius: 999, color: "var(--cmux-text-secondary)", fontSize: 11, padding: "1px 5px" };

function groupLabel(group: DashboardCardModel["group"]): string {
  if (group === "waiting") return dashboardStrings.groupWaiting;
  if (group === "stalled") return dashboardStrings.groupStalled;
  if (group === "done") return dashboardStrings.groupDone;
  if (group === "working") return dashboardStrings.groupWorking;
  return dashboardStrings.groupIdle;
}
