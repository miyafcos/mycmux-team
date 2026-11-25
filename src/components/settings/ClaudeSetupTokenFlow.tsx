import { useEffect, useRef, useState, type CSSProperties } from "react";
import { open } from "@tauri-apps/plugin-shell";
import type { CliAccountProfile } from "../../lib/ipc";
import { isSetupTokenActive, useClaudeSetupTokenStore } from "../../stores/claudeSetupTokenStore";
import { setupTokenStrings as S } from "../layout/tabAccountStrings";

const buttonStyle: CSSProperties = {
  padding: "2px 7px", borderRadius: 3, border: "1px solid var(--cmux-border)",
  background: "none", color: "var(--cmux-text-secondary)", fontSize: "inherit", fontFamily: "inherit", cursor: "pointer",
};

export function ClaudeSetupTokenFlow({ profile, registered, continueRegistration, disabled }: {
  profile: Pick<CliAccountProfile, "id" | "label">;
  registered: boolean;
  continueRegistration: boolean;
  disabled: boolean;
}) {
  const setup = useClaudeSetupTokenStore();
  const event = setup.event?.profile_id === profile.id ? setup.event : null;
  const active = isSetupTokenActive(event) || setup.pendingProfileId === profile.id;
  const elsewhere = (isSetupTokenActive(setup.event) && !event)
    || (setup.pendingProfileId !== null && setup.pendingProfileId !== profile.id);
  const [confirming, setConfirming] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [hideFailure, setHideFailure] = useState(false);
  const [manualOpenFailed, setManualOpenFailed] = useState(false);
  const registerRef = useRef<HTMLButtonElement>(null);
  const beginRef = useRef<HTMLButtonElement>(null);
  const flowRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLButtonElement>(null);
  const loginId = event?.login_id;
  const state = event?.state;
  const wasActive = useRef(active);
  const submission = event?.login_id === setup.codeSubmission?.loginId ? setup.codeSubmission : null;

  useEffect(() => {
    if (confirming && !active) beginRef.current?.focus();
  }, [confirming, active]);
  useEffect(() => {
    const input = inputRef.current;
    if (input && (document.activeElement === document.body || flowRef.current?.contains(document.activeElement))) input.focus();
    return () => { if (input) input.value = ""; };
  }, [event?.login_id, event?.state]);
  useEffect(() => {
    if (wasActive.current && !active
      && (document.activeElement === document.body || flowRef.current?.contains(document.activeElement))) resultRef.current?.focus();
    wasActive.current = active;
  }, [active, loginId, state]);

  const close = () => {
    setConfirming(false);
    setDismissed(event?.login_id ?? null);
    setHideFailure(true);
    requestAnimationFrame(() => registerRef.current?.focus());
  };
  const message = (reason: string | undefined) => S.failures[reason as keyof typeof S.failures] ?? S.failures.capture_failed;
  const failure = hideFailure || setup.failureProfileId !== profile.id ? null : setup.failure;
  const result = !active && event && event.login_id !== dismissed ? event : null;
  const registerLabel = continueRegistration && !registered ? S.continueRegistration : registered ? S.registerAgain : S.useInTab;

  return (
    <div ref={flowRef} tabIndex={-1} data-claude-setup-token="true" style={{ display: "grid", gap: 4, minWidth: 0 }}
      onKeyDown={event => {
        if (event.key !== "Tab" || (!active && !confirming)) return;
        const controls = [...(flowRef.current?.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input") ?? [])]
          .filter(control => !control.disabled);
        if (!controls.length) return;
        event.preventDefault();
        event.stopPropagation();
        const at = controls.findIndex(control => control === document.activeElement);
        const next = event.shiftKey ? (at <= 0 ? controls.length - 1 : at - 1) : (at + 1) % controls.length;
        controls[next]?.focus();
      }}>
      {!active && !confirming && <button ref={registerRef} type="button" style={{ ...buttonStyle, justifySelf: "start" }}
        disabled={disabled || elsewhere} onClick={() => { setHideFailure(false); setConfirming(true); }}>{registerLabel}</button>}
      {elsewhere && <div role="status">{S.busyElsewhere}</div>}
      {confirming && !active && <div style={{ display: "grid", gap: 4 }}>
        <p style={{ margin: 0 }}>{S.confirm(profile.label)}</p>
        <div>{S.approvalBrowser}</div>
        <div style={{ display: "flex", gap: 4 }}>
          <button ref={beginRef} type="button" style={buttonStyle} disabled={disabled || elsewhere} onClick={() => {
            setConfirming(false);
            setManualOpenFailed(false);
            void setup.begin(profile.id);
            flowRef.current?.focus();
          }}>{S.begin}</button>
          <button type="button" style={buttonStyle} onClick={close}>{S.dismiss}</button>
        </div>
      </div>}
      {active && <div style={{ display: "grid", gap: 4 }}>
        <div role="status">{
          !event || event.state === "starting" ? S.starting :
          event.state === "confirming" ? S.confirming :
          event.state === "checking_owner" ? S.checking : S.waiting
        }</div>
        {event?.state === "code_available" && <>
          {event.url && <>
            <div>{S.fallback}</div>
            <span style={{ overflowWrap: "anywhere" }}>{event.url}</span>
            <button type="button" style={{ ...buttonStyle, justifySelf: "start" }} onClick={() => {
              setManualOpenFailed(false);
              void open(event.url!).catch(() => setManualOpenFailed(true));
            }}>{S.openUrl}</button>
            {(setup.browserOpenFailed || manualOpenFailed) && <div role="alert">{S.urlFailed}</div>}
          </>}
          <form onSubmit={domEvent => {
            domEvent.preventDefault();
            const input = inputRef.current;
            if (!input || submission) return;
            const code = input.value;
            input.value = "";
            void setup.submit(event.login_id, code);
          }} style={{ display: "grid", gap: 4 }}>
            <label>{S.codePrompt}
              <input ref={inputRef} type="password" aria-label={S.codeLabel} autoComplete="off" spellCheck={false}
                disabled={!!submission} maxLength={4096} style={{ display: "block", width: "100%", boxSizing: "border-box", minWidth: 0,
                  border: "1px solid var(--cmux-border)", borderRadius: 3, padding: 4, font: "inherit",
                  color: "var(--cmux-text)", background: "var(--cmux-bg)" }} />
            </label>
            <button type="submit" style={{ ...buttonStyle, justifySelf: "start" }} disabled={!!submission}>{S.sendCode}</button>
            {submission?.accepted && <div role="status">{S.codeSent}</div>}
          </form>
        </>}
        {event && event.state !== "checking_owner" && <button type="button" style={{ ...buttonStyle, justifySelf: "start" }}
          onClick={() => void setup.cancel(event.login_id)}>{S.cancel}</button>}
      </div>}
      {result && <div role={result.state === "saved" || result.state === "cancelled" ? "status" : "alert"}>
        {result.state === "saved" ? S.saved : message(result.reason ?? result.state)}
        {result.state === "saved" && result.status && result.status.owner_check !== "verified" && <div>{S.ownerUnverified}</div>}
        <button ref={resultRef} type="button" style={buttonStyle} onClick={close}>{S.dismiss}</button>
      </div>}
      {failure && <div role="alert">{message(failure)}
        {!active && <button type="button" style={buttonStyle} onClick={close}>{S.dismiss}</button>}
      </div>}
    </div>
  );
}
