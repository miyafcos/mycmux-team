import { useEffect, useState } from "react";
import { cropLiveTailScreen, isLiveTailDoneRow, liveTailBodyRows, type LiveTailCrop } from "../../lib/liveTail/crop";
import { getTerminalBufferLines, isTerminalParsingCurrentOutput } from "./XTermWrapper";
import { getTerminalWriteCounter, isTerminalBufferWritePending } from "./terminalCache";
import { agentTabStrings } from "./agentTabStrings";

// This preference belongs to a tab for this app lifetime, including remounts.
const expandedTabs = new Map<string, boolean>();
interface Screen { crop: LiveTailCrop; body: string[] }

export function AgentTabLiveStrip({ sessionId, tabId, agentKind, live, needsInput }: {
  sessionId: string; tabId: string | null; agentKind: string; live: boolean; needsInput: boolean;
}) {
  const key = tabId ?? sessionId;
  const [choice, setChoice] = useState(() => ({ key, expanded: expandedTabs.get(key) ?? false }));
  const expanded = choice.key === key ? choice.expanded : expandedTabs.get(key) ?? false;
  const [screen, setScreen] = useState<Screen | null>(null);
  const [pulsing, setPulsing] = useState(false);
  useEffect(() => {
    setScreen(null); setPulsing(false);
    if (!live) return;
    let observed: number | null = null, read: number | null = null, writtenAt: number | null = null;
    let latest: Screen | null = null, retained: Screen | null = null;
    let pendingSince: number | null = null;
    const sample = () => {
      const counter = getTerminalWriteCounter(sessionId);
      if (observed !== null && counter > observed) writtenAt = Date.now();
      else if (observed !== null && counter < observed) { read = null; writtenAt = null; latest = null; retained = null; pendingSince = null; setScreen(null); setPulsing(false); }
      observed = counter;
      if (!isTerminalParsingCurrentOutput(sessionId)) {
        if (isTerminalBufferWritePending(sessionId)) {
          pendingSince ??= Date.now();
          // Skip an in-flight parse without consuming its counter or evidence.
          // New writes cannot extend a continuously unreadable backlog.
          if (Date.now() - pendingSince < 3000) return;
        } else pendingSince = null;
        read = null; writtenAt = null; latest = null; retained = null; setScreen(null); setPulsing(false); return;
      }
      pendingSince = null;
      // The first visible sample reads the existing screen without claiming a
      // recent write. Subsequent reads require a changed write counter.
      if (read !== counter) {
        const rows = getTerminalBufferLines(sessionId, 40);
        latest = { crop: cropLiveTailScreen(rows, agentKind), body: liveTailBodyRows(rows, agentKind, 8) };
        read = counter;
      }
      const recent = writtenAt !== null && Date.now() - writtenAt < 3000;
      if (latest && (latest.crop.state === "working" || latest.crop.state === "done" || latest.crop.state === "error")) {
        retained = latest; setScreen(latest);
      } else if (recent) {
        // A redraw may temporarily erase markers. Keep recognized evidence,
        // otherwise show only actual body rows backed by an observed write.
        setScreen(retained ?? (latest?.body.length ? latest : null));
      } else {
        retained = null; setScreen(null);
      }
      setPulsing(recent);
    };
    sample();
    const timer = window.setInterval(sample, 250);
    return () => window.clearInterval(timer);
  }, [sessionId, agentKind, live]);

  if (!live) return null;
  const crop = screen?.crop;
  const state = needsInput ? "ask"
    : crop && (crop.state === "unknown" || crop.state === "unreadable") ? "active" : crop?.state;
  if (state !== "ask" && state !== "working" && state !== "done" && state !== "error" && state !== "active") return null;
  const status = state === "ask" ? agentTabStrings.liveAnswerWaiting
    : state === "done" ? agentTabStrings.liveDone(crop?.doneAt ?? null, crop?.doneElapsedSec ?? null) : null;
  const rows = state === "active" ? screen?.body.slice(-2) ?? []
    : state === "error" ? crop?.rows ?? []
    : crop?.rows.slice(-2).filter((row, index, tail) =>
      state !== "working" || index === tail.length - 1 || !isLiveTailDoneRow(row, agentKind)) ?? [];
  const toggle = () => {
    expandedTabs.set(key, !expanded); setChoice({ key, expanded: !expanded });
  };
  return <button type="button" className="agent-tab-live-strip" data-agent-tab-live-state={state}
    data-agent-tab-live-pulsing={(state === "working" || state === "active") && pulsing ? "true" : undefined}
    aria-expanded={expanded} onClick={toggle}>
    {status ? <span className="agent-tab-live-strip__status">{status}</span> : null}
    {/* The active question already has its own card. Never echo it here. */}
    {state !== "ask" ? <span className="agent-tab-live-strip__rows">
      {expanded ? <span className="agent-tab-live-strip__body">{screen?.body.join("\n")}</span>
        : state !== "done" ? rows.map((row, index) => <span key={index} className="agent-tab-live-strip__row">{row}</span>) : null}
    </span> : null}
  </button>;
}
