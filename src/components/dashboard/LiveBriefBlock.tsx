import { useCallback, useEffect, useMemo, useState } from "react";

import {
  freezeExpectation,
  getLiveBriefs,
  onLiveBriefUpdate,
  sendIntervention,
  targetKey,
  type InterventionAction,
  type InterventionResult,
  type LiveSessionBrief,
} from "../../lib/livebrief";

type BriefMap = Record<string, LiveSessionBrief>;

function mergeBrief(previous: BriefMap, incoming: LiveSessionBrief): BriefMap {
  const current = previous[incoming.ptySessionId];
  if (current && (current.serviceEpoch !== incoming.serviceEpoch || current.briefRevision >= incoming.briefRevision)) return previous;
  return { ...previous, [incoming.ptySessionId]: incoming };
}

export function LiveBriefBlock({ sessionId, targetLabel }: { sessionId: string; targetLabel: string }) {
  const [briefs, setBriefs] = useState<BriefMap>({});
  const [draftByTarget, setDraftByTarget] = useState<Record<string, string>>({});
  const [resultByTarget, setResultByTarget] = useState<Record<string, InterventionResult>>({});
  const [inFlightByTarget, setInFlightByTarget] = useState<Record<string, boolean>>({});
  const brief = briefs[sessionId];
  const key = brief ? targetKey(brief) : null;

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onLiveBriefUpdate((incoming) => {
      if (!disposed) setBriefs((previous) => mergeBrief(previous, incoming));
    }).then((nextUnlisten) => { if (disposed) nextUnlisten(); else unlisten = nextUnlisten; });
    void getLiveBriefs().then((snapshot) => {
      if (!disposed) setBriefs((previous) => snapshot.reduce((next, incoming) => mergeBrief(next, incoming), previous));
    }).catch(() => {});
    return () => { disposed = true; unlisten?.(); };
  }, []);

  const enabled = Boolean(brief && key && brief.telemetryHealth === "live" && brief.operationalState === "needsHuman" && !inFlightByTarget[key]);
  const draft = key ? draftByTarget[key] ?? "" : "";
  const result = key ? resultByTarget[key] : undefined;

  const submit = useCallback(async (action: InterventionAction) => {
    if (!brief || !key) return;
    const expectation = freezeExpectation(brief);
    if (!expectation) return;
    setInFlightByTarget((previous) => ({ ...previous, [key]: true }));
    try {
      const next = await sendIntervention(expectation, action);
      setResultByTarget((previous) => ({ ...previous, [key]: next }));
    } catch {
      setResultByTarget((previous) => ({ ...previous, [key]: { type: "rejectedBeforeWrite", reason: "transport" } }));
    } finally {
      setInFlightByTarget((previous) => ({ ...previous, [key]: false }));
    }
  }, [brief, key]);

  const resultText = useMemo(() => {
    if (!result) return null;
    if (result.type === "confirmed") return "Input confirmed in the transcript.";
    if (result.type === "conflict") return "The target changed; nothing was sent.";
    if (result.type === "busy") return "An intervention for this prompt is already in progress.";
    if (result.type === "rejectedBeforeWrite") return `Nothing was sent: ${result.reason}.`;
    if (result.type === "indeterminatePartial") return "Write outcome is indeterminate. Open the terminal; do not resend automatically.";
    return "Write was not confirmed. The prompt remains actionable; do not resend automatically.";
  }, [result]);

  if (!brief) return null;
  return <section data-livebrief-interactive="true" style={blockStyle}>
    <div style={bannerStyle}><strong>Live brief (experimental)</strong><span>{targetLabel} · {brief.agentKind} · PTY {brief.ptyGeneration} · {brief.telemetryHealth}</span></div>
    {brief.task ? <div><span style={labelStyle}>Task</span>{brief.task}</div> : null}
    {brief.activityText ? <div><span style={labelStyle}>Now</span>{brief.activityText}</div> : null}
    {brief.checkpoint ? <div><span style={labelStyle}>Checkpoint</span>{brief.checkpoint}</div> : null}
    {brief.pendingPrompt ? <div style={{ marginTop: 8 }}><span style={labelStyle}>Question</span>{brief.pendingPrompt}</div> : null}
    {brief.pendingOptions.length ? <div style={actionsStyle}>{brief.pendingOptions.map((option) => <button key={option.id} type="button" disabled={!enabled} style={buttonStyle} onClick={() => void submit({ type: "choose", optionId: option.id })}>{option.label}</button>)}</div> : null}
    {brief.pendingInputKind === "freeText" || brief.pendingInputKind === "blocker" ? <div style={actionsStyle}>
      <input value={draft} disabled={!enabled} aria-label="Live intervention reply" onChange={(event) => key && setDraftByTarget((previous) => ({ ...previous, [key]: event.target.value }))} onKeyDown={(event) => { if (event.nativeEvent.isComposing || event.key !== "Enter") return; event.preventDefault(); if (draft.trim()) void submit({ type: "replyText", text: draft }); }} style={inputStyle} />
      <button type="button" disabled={!enabled || !draft.trim()} style={buttonStyle} onClick={() => void submit({ type: "replyText", text: draft })}>Send reply</button>
    </div> : null}
    {resultText ? <div style={resultStyle}>{resultText}</div> : null}
  </section>;
}

const blockStyle = { display: "grid", gap: 5, marginTop: 12, padding: 9, border: "1px solid var(--cmux-border)", borderRadius: "var(--cmux-radius-sm)", background: "color-mix(in srgb, var(--cmux-accent) 7%, transparent)", fontSize: "var(--cmux-font-size-xs)" };
const bannerStyle = { display: "flex", justifyContent: "space-between", gap: 8, color: "var(--cmux-text-secondary)" };
const labelStyle = { display: "inline-block", width: 78, color: "var(--cmux-text-secondary)" };
const actionsStyle = { display: "flex", flexWrap: "wrap" as const, gap: 6, marginTop: 4 };
const buttonStyle = { background: "transparent", border: "1px solid var(--cmux-border)", borderRadius: "var(--cmux-radius-sm)", color: "var(--cmux-text)", cursor: "pointer", fontSize: "var(--cmux-font-size-xs)", padding: "4px 7px" };
const inputStyle = { flex: 1, minWidth: 160, background: "var(--cmux-bg)", border: "1px solid var(--cmux-border)", borderRadius: "var(--cmux-radius-sm)", color: "var(--cmux-text)", fontSize: "var(--cmux-font-size-xs)", padding: "4px 6px" };
const resultStyle = { color: "var(--cmux-text-secondary)", marginTop: 3 };
