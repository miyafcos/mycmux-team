import { useCallback, useEffect, useMemo, useState } from "react";

import {
  freezeExpectation,
  sendIntervention,
  targetKey,
  type InterventionAction,
  type InterventionResult,
} from "../../lib/livebrief";
import { connectLiveBriefStore, useLiveBriefStore } from "../../stores/liveBriefStore";
import { dashboardStrings } from "./dashboardStrings";

export function LiveBriefBlock({ sessionId, targetLabel }: { sessionId: string; targetLabel: string }) {
  const [draftByTarget, setDraftByTarget] = useState<Record<string, string>>({});
  const [resultByTarget, setResultByTarget] = useState<Record<string, InterventionResult>>({});
  const [inFlightByTarget, setInFlightByTarget] = useState<Record<string, boolean>>({});
  const brief = useLiveBriefStore((state) => state.briefsBySession[sessionId]);
  const key = brief ? targetKey(brief) : null;

  useEffect(() => connectLiveBriefStore(), []);

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
    if (result.type === "confirmed") return dashboardStrings.interventionConfirmed;
    if (result.type === "conflict") return dashboardStrings.interventionConflict;
    if (result.type === "busy") return dashboardStrings.interventionBusy;
    if (result.type === "writtenAwaitingEvidence") return dashboardStrings.interventionWritten;
    if (result.type === "rejectedBeforeWrite") return dashboardStrings.interventionRejected(result.reason);
    if (result.type === "indeterminatePartial") return dashboardStrings.interventionIndeterminate;
    return dashboardStrings.interventionUnconfirmed;
  }, [result]);

  if (!brief) {
    return <section style={blockStyle}>
      <div style={bannerStyle}><strong>{dashboardStrings.liveBriefTitle}</strong><span>{targetLabel}</span></div>
      <div style={resultStyle}>{dashboardStrings.telemetryUnlinked}</div>
    </section>;
  }
  const healthNote = brief.telemetryHealth === "live"
    ? null
    : brief.telemetryHealth === "unlinked"
      ? dashboardStrings.telemetryUnlinked
      : dashboardStrings.telemetryUnavailable;
  return <section data-livebrief-interactive="true" style={blockStyle}>
    <div style={bannerStyle}><strong>{dashboardStrings.liveBriefTitle}</strong><span>{targetLabel} · {brief.agentKind} · PTY {brief.ptyGeneration}</span></div>
    {healthNote ? <div style={resultStyle}>{healthNote}</div> : null}
    {brief.task ? <div><span style={labelStyle}>{dashboardStrings.liveBriefTaskLabel}</span>{brief.task}</div> : null}
    {brief.activityText ? <div><span style={labelStyle}>{dashboardStrings.liveBriefActivityLabel}</span>{brief.activityText}</div> : null}
    {brief.checkpoint ? <div><span style={labelStyle}>{dashboardStrings.liveBriefCheckpointLabel}</span>{brief.checkpoint}</div> : null}
    {brief.pendingPrompt ? <div style={{ marginTop: 8 }}><span style={labelStyle}>{dashboardStrings.liveBriefQuestionLabel}</span>{brief.pendingPrompt}</div> : null}
    {brief.pendingOptions.length ? <div style={actionsStyle}>{brief.pendingOptions.map((option) => <button key={option.id} type="button" disabled={!enabled} style={buttonStyle} onClick={() => void submit({ type: "choose", optionId: option.id })}>{option.label}</button>)}</div> : null}
    {brief.pendingInputKind === "freeText" || brief.pendingInputKind === "blocker" ? <div style={actionsStyle}>
      <input value={draft} disabled={!enabled} aria-label={dashboardStrings.liveBriefReplyAriaLabel} onChange={(event) => key && setDraftByTarget((previous) => ({ ...previous, [key]: event.target.value }))} onKeyDown={(event) => { if (event.nativeEvent.isComposing || event.key !== "Enter") return; event.preventDefault(); if (draft.trim()) void submit({ type: "replyText", text: draft }); }} style={inputStyle} />
      <button type="button" disabled={!enabled || !draft.trim()} style={buttonStyle} onClick={() => void submit({ type: "replyText", text: draft })}>{dashboardStrings.liveBriefSendReply}</button>
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
