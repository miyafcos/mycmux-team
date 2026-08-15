import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

import { readPaneTail } from "../layout/socketCommands";
import { getTerminalWriteCounter, hasTerminalBuffer } from "../terminal/XTermWrapper";
import { dashboardStrings } from "./dashboardStrings";

const TAIL_LINES = 40;
const POLL_MS = 2_000;

/**
 * 生端末の末尾を出す telemetry-unavailable 用のフォールバック部品。
 * 会話の正本は livebrief 側なので、通常のチャット導線では表示しない。
 */
export function DashboardTerminalTab({ sessionId }: { sessionId: string }) {
  const [lines, setLines] = useState<string[]>([]);
  const [unreadable, setUnreadable] = useState(false);
  const writeCounterRef = useRef<number | null>(null);
  const linesLengthRef = useRef(0);

  const refresh = useCallback(async () => {
    const counter = getTerminalWriteCounter(sessionId);
    if (writeCounterRef.current === counter && linesLengthRef.current) return;
    writeCounterRef.current = counter;
    try {
      const next = await readPaneTail(sessionId, TAIL_LINES);
      linesLengthRef.current = next.length;
      setLines(next);
      setUnreadable(false);
    } catch {
      linesLengthRef.current = 0;
      setLines([]);
      setUnreadable(true);
    }
  }, [sessionId]);

  useEffect(() => {
    let disposed = false;
    let timeoutId: number | undefined;
    writeCounterRef.current = null;
    linesLengthRef.current = 0;
    setLines([]);
    setUnreadable(false);
    void refresh();
    const scheduleRefresh = () => {
      timeoutId = window.setTimeout(async () => {
        if (hasTerminalBuffer(sessionId)) await refresh();
        if (!disposed) scheduleRefresh();
      }, POLL_MS);
    };
    scheduleRefresh();
    return () => {
      disposed = true;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [refresh, sessionId]);

  return <div style={wrapStyle}>
    <div style={titleStyle}>{dashboardStrings.terminalTailTitle}</div>
    <pre style={preStyle}>{unreadable ? dashboardStrings.terminalUnreadable : lines.join("\n")}</pre>
  </div>;
}

const wrapStyle: CSSProperties = { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" };
const titleStyle: CSSProperties = {
  color: "var(--cmux-text-secondary)",
  fontSize: "var(--cmux-font-size-sm)",
  marginBottom: 6,
};
const preStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "auto",
  margin: 0,
  padding: 10,
  border: "1px solid var(--cmux-border)",
  borderRadius: "var(--cmux-radius-sm)",
  background: "var(--cmux-bg)",
  color: "var(--cmux-text)",
  fontSize: "var(--cmux-font-size-xs)",
  fontFamily: "var(--cmux-dash-body-font)",
  whiteSpace: "pre-wrap",
};
