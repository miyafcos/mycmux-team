import { useState } from "react";
import type { AgentRestoreChoice } from "../../lib/agentRestoreChoice";

export const resumeRecoveryStrings = {
  conflictTitle: "\u3053\u306e\u4f1a\u8a71\u306f\u5225\u306e\u30da\u30a4\u30f3\u3067\u52d5\u3044\u3066\u3044\u307e\u3059",
  conflictBody: "\u305d\u3061\u3089\u3092\u958b\u304f\u304b\u3001\u3053\u3061\u3089\u3067\u958b\u304d\u76f4\u305b\u307e\u3059\u3002\u5411\u3053\u3046\u304c\u7d42\u308f\u308b\u3068\u3001\u3053\u3053\u3067\u4e00\u5ea6\u3060\u3051\u81ea\u52d5\u3067\u958b\u304d\u76f4\u3057\u307e\u3059\u3002",
  hiddenOwner: "\u52d5\u3044\u3066\u3044\u308b\u4f1a\u8a71\u306f\u3001\u3069\u306e\u7a93\u306b\u3082\u8868\u793a\u3055\u308c\u3066\u3044\u307e\u305b\u3093\u3002\u300c\u3053\u3061\u3089\u3067\u958b\u304d\u76f4\u3059\u300d\u3067\u305d\u306e\u4f1a\u8a71\u3092\u6b62\u3081\u3066\u958b\u3051\u307e\u3059\u3002",
  openOwner: "\u305d\u3061\u3089\u3092\u958b\u304f",
  takeover: "\u3053\u3061\u3089\u3067\u958b\u304d\u76f4\u3059",
  fresh: "\u65b0\u3057\u3044\u4f1a\u8a71\u3067\u59cb\u3081\u308b",
  confirmTitle: "\u5411\u3053\u3046\u306e\u4f1a\u8a71\u3092\u6b62\u3081\u3066\u3001\u3053\u3053\u3067\u958b\u304d\u76f4\u3057\u307e\u3059\u304b\uff1f",
  confirmWorking: "\u5411\u3053\u3046\u306f\u4f5c\u696d\u4e2d\u3067\u3059\u3002\u6b62\u3081\u308b\u3068\u3001\u9032\u884c\u4e2d\u306e\u51e6\u7406\u304c\u4e2d\u65ad\u3055\u308c\u307e\u3059\u3002",
  confirmHidden: "\u7a93\u306b\u8868\u793a\u3055\u308c\u3066\u3044\u306a\u3044\u4f1a\u8a71\u3092\u6b62\u3081\u307e\u3059\u3002",
  confirmStop: "\u6b62\u3081\u3066\u958b\u304d\u76f4\u3059",
  cancel: "\u3084\u3081\u308b",
  restoreTitle: "\u4fdd\u5b58\u3055\u308c\u305f\u4f1a\u8a71\u3092\u78ba\u304b\u3081\u3066\u304f\u3060\u3055\u3044",
  restoreBody: "\u3053\u306e\u8a18\u9332\u306f\u81ea\u52d5\u30b8\u30e7\u30d6\u304b\u3089\u59cb\u307e\u308a\u3001\u4eba\u304c\u5bfe\u8a71\u3067\u6253\u3063\u305f\u767a\u8a71\u304c\u3042\u308a\u307e\u305b\u3093\u3002\u958b\u304f\u4f1a\u8a71\u3092\u9078\u3093\u3067\u304f\u3060\u3055\u3044\u3002",
  original: "\u5143\u306e\u4f1a\u8a71\u3092\u958b\u304f",
  saved: "\u3053\u306e\u307e\u307e\u958b\u304f",
  noOriginal: "\u5143\u306e\u5bfe\u8a71\u306e\u8a18\u9332\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093\u3067\u3057\u305f\u3002",
  candidateLabel: "\u5143\u306e\u4f1a\u8a71\u306e\u5019\u88dc",
  busy: "\u958b\u304d\u76f4\u3057\u3066\u3044\u307e\u3059\u2026",
  failed: "\u958b\u304d\u76f4\u305b\u307e\u305b\u3093\u3067\u3057\u305f\u3002\u3082\u3046\u4e00\u5ea6\u64cd\u4f5c\u3092\u9078\u3093\u3067\u304f\u3060\u3055\u3044\u3002",
  reopened: "\u5411\u3053\u3046\u306e\u4f1a\u8a71\u304c\u7d42\u308f\u3063\u305f\u306e\u3067\u3001\u3053\u3053\u3067\u958b\u304d\u76f4\u3057\u307e\u3057\u305f\u3002",
};

export type ResumeRecoveryModel = { type: "conflict"; hiddenOwner: boolean } | { type: "restore"; choice: AgentRestoreChoice };
export interface AgentResumeRecoveryPanelProps {
  model: ResumeRecoveryModel;
  confirmation: { working: boolean; hidden: boolean } | null;
  busy: boolean;
  error: boolean;
  onOpenOwner(): void;
  onTakeover(): void;
  onFresh(): void;
  onOriginal(id: string): void;
  onSaved(): void;
  onConfirm(yes: boolean): void;
}

export function AgentResumeRecoveryPanel(props: AgentResumeRecoveryPanelProps) {
  const candidates = props.model.type === "restore" ? props.model.choice.candidates : [];
  const [selected, setSelected] = useState(candidates[0] ?? "");
  const original = candidates.includes(selected) ? selected : candidates[0];
  const s = resumeRecoveryStrings;
  const buttonStyle = { padding: "7px 10px", border: "1px solid var(--cmux-border, #555)", borderRadius: 5, background: "var(--cmux-surface, #222)", color: "inherit", cursor: "pointer" };
  return <div data-agent-resume-recovery={props.model.type} style={{ position: "absolute", inset: 0, zIndex: 60, overflow: "auto", display: "grid", placeItems: "center", padding: 16, background: "var(--cmux-bg, #181818)", color: "var(--cmux-text, #ededed)", fontFamily: "var(--cmux-font-ui)", fontSize: 13 }}>
    <div role={props.confirmation ? "alertdialog" : "region"} aria-label={props.confirmation ? s.confirmTitle : props.model.type === "conflict" ? s.conflictTitle : s.restoreTitle} style={{ maxWidth: 520, width: "100%" }}>
      {props.confirmation ? <>
        <strong>{s.confirmTitle}</strong>
        {props.confirmation.working && <p>{s.confirmWorking}</p>}
        {props.confirmation.hidden && <p>{s.confirmHidden}</p>}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
          <button style={buttonStyle} onClick={() => props.onConfirm(true)}>{s.confirmStop}</button>
          <button style={buttonStyle} onClick={() => props.onConfirm(false)}>{s.cancel}</button>
        </div>
      </> : <>
        <strong>{props.model.type === "conflict" ? s.conflictTitle : s.restoreTitle}</strong>
        <p>{props.model.type === "conflict" ? s.conflictBody : s.restoreBody}</p>
        {props.model.type === "conflict" && props.model.hiddenOwner && <p>{s.hiddenOwner}</p>}
        {props.model.type === "restore" && candidates.length === 0 && <p>{s.noOriginal}</p>}
        {props.model.type === "restore" && candidates.length > 1 && <select aria-label={s.candidateLabel} value={original} onChange={event => setSelected(event.target.value)}>{candidates.map(id => <option key={id} value={id}>{id}</option>)}</select>}
        {props.error && <p role="alert">{s.failed}</p>}
        {props.busy && <p role="status">{s.busy}</p>}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
          {props.model.type === "conflict" ? <>
            <button style={buttonStyle} disabled={props.busy || props.model.hiddenOwner} onClick={props.onOpenOwner}>{s.openOwner}</button>
            <button style={buttonStyle} disabled={props.busy} onClick={props.onTakeover}>{s.takeover}</button>
          </> : <>
            <button style={buttonStyle} disabled={props.busy || !original} onClick={() => original && props.onOriginal(original)}>{s.original}</button>
            <button style={buttonStyle} disabled={props.busy} onClick={props.onSaved}>{s.saved}</button>
          </>}
          <button style={buttonStyle} disabled={props.busy} onClick={props.onFresh}>{s.fresh}</button>
        </div>
      </>}
    </div>
  </div>;
}
