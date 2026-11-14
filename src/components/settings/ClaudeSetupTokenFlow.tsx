import { useEffect, useRef, useState, type CSSProperties } from "react";
import { open } from "@tauri-apps/plugin-shell";
import type { CliAccountProfile } from "../../lib/ipc";
import { isSetupTokenActive, useClaudeSetupTokenStore, type RegistrationOrigin } from "../../stores/claudeSetupTokenStore";
import { setupTokenStrings as S } from "../layout/tabAccountStrings";

const buttonStyle: CSSProperties = { padding: "2px 7px", borderRadius: 3, border: "1px solid var(--cmux-border)",
  background: "none", color: "var(--cmux-text-secondary)", fontSize: "inherit", fontFamily: "inherit", cursor: "pointer" };
export function ClaudeSetupTokenFlow({ profile, surface = "settings", ownerKey = "settings", registered = false, disabled = false, onSaved, onInteractionChange, onClosed }: {
  profile: Pick<CliAccountProfile, "id" | "label">;
  surface?: RegistrationOrigin["surface"];
  ownerKey?: string;
  registered?: boolean;
  disabled?: boolean;
  onSaved?: (state: "saved" | "mismatch") => void | Promise<void>;
  onInteractionChange?: (active: boolean) => void;
  onClosed?: () => void;
}) {
  const setup = useClaudeSetupTokenStore();
  const origin = setup.registrationOrigins.claude;
  const ownsRegistration = origin?.surface === surface && origin.provider === "claude" && origin.profileId === profile.id && origin.ownerKey === ownerKey;
  const event = setup.event?.profile_id === profile.id ? setup.event : null;
  const completion = setup.completionOrigin;
  const completionEvent = completion ? (setup.event?.login_id === completion.loginId
    ? setup.event : setup.endedEvents.find(ended => ended.login_id === completion.loginId)) : null;
  const ownsCompletion = completion?.origin.surface === surface && completion.origin.provider === "claude"
    && completion.origin.profileId === profile.id && completion.origin.ownerKey === ownerKey && completionEvent?.profile_id === profile.id;
  const active = isSetupTokenActive(event) || setup.pendingProfileId === profile.id;
  const elsewhere = (isSetupTokenActive(setup.event) && !event) || (!!setup.pendingProfileId && setup.pendingProfileId !== profile.id);
  const [confirming, setConfirming] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  const [urlFailed, setUrlFailed] = useState(false);
  const flowRef = useRef<HTMLDivElement>(null);
  const registerRef = useRef<HTMLButtonElement>(null);
  const [restoreFocus, setRestoreFocus] = useState(false);
  const [dismissedLogin, setDismissedLogin] = useState<string | null>(null);
  const [failureDismissed, setFailureDismissed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const beginRef = useRef<HTMLButtonElement>(null);
  const resultDismissRef = useRef<HTMLButtonElement>(null);
  const resultFocusOnMount = useRef(setup.resultFocus);
  const previousRegistration = useRef({ active, ownsRegistration });
  const interactionCallback = useRef(onInteractionChange);
  interactionCallback.current = onInteractionChange;
  useEffect(() => {
    interactionCallback.current?.((confirming && (!origin || ownsRegistration)) || (ownsRegistration && active));
    return () => interactionCallback.current?.(false);
  }, [active, confirming, ownsRegistration, origin]);
  useEffect(() => { if (active && !ownsRegistration) setConfirming(false); }, [active, ownsRegistration]);
  useEffect(() => { if (confirming && !active && (!origin || ownsRegistration)) beginRef.current?.focus(); }, [confirming, active, origin, ownsRegistration]);
  useEffect(() => { if (ownsRegistration && event?.state === "code_available") inputRef.current?.focus(); }, [event?.login_id, event?.state, ownsRegistration]);
  useEffect(() => {
    const previous = previousRegistration.current;
    previousRegistration.current = { active, ownsRegistration };
    if (previous.active && previous.ownsRegistration && !active && event && !isSetupTokenActive(event)
      && !(surface === "launcher" && event.state === "saved")
      && resultDismissRef.current && (document.activeElement === document.body || flowRef.current?.contains(document.activeElement))) {
      resultDismissRef.current.focus();
      if (surface !== "settings") useClaudeSetupTokenStore.setState({ resultFocus: { ownerKey, loginId: event.login_id } });
    }
  }, [active, ownsRegistration, event?.login_id, event?.state, surface, ownerKey]);
  useEffect(() => {
    const pendingFocus = resultFocusOnMount.current;
    if (pendingFocus && setup.resultFocus === pendingFocus && pendingFocus.ownerKey === ownerKey
      && pendingFocus.loginId === event?.login_id && !active && resultDismissRef.current) {
      if (document.activeElement === document.body || flowRef.current?.contains(document.activeElement)) resultDismissRef.current.focus();
      useClaudeSetupTokenStore.setState({ resultFocus: null });
    }
  }, [setup.resultFocus, ownerKey, event?.login_id, active]);
  useEffect(() => {
    if (restoreFocus && !active && !confirming) { registerRef.current?.focus(); setRestoreFocus(false); }
  }, [restoreFocus, active, confirming]);
  const savedCallback = useRef(onSaved);
  savedCallback.current = onSaved;
  useEffect(() => { void setup.connect().catch(() => {}); }, [setup.connect]);
  useEffect(() => {
    setCodeSent(false); setUrlFailed(false);
    const input = inputRef.current;
    return () => { if (input) input.value = ""; };
  }, [event?.login_id, event?.state]);
  useEffect(() => {
    if (ownsCompletion && (completionEvent?.state === "saved" || completionEvent?.state === "mismatch") && setup.claimCompletion(completionEvent.login_id)) {
      void Promise.resolve(savedCallback.current?.(completionEvent.state)).catch(() => {});
    }
  }, [completionEvent?.login_id, completionEvent?.state, ownsCompletion, setup.claimCompletion]);
  const submit = async () => {
    const input = inputRef.current;
    if (!input || !event || codeSent) return;
    const value = input.value;
    input.value = "";
    if (await setup.submit(event.login_id, value)) setCodeSent(true);
  };
  const message = (reason: string | undefined) => S.failures[reason as keyof typeof S.failures] ?? S.failures.capture_failed;
  const failure = !failureDismissed && setup.failureProfileId === profile.id ? setup.failure : null;
  const close = () => {
    setConfirming(false); setDismissedLogin(event?.login_id ?? null); setFailureDismissed(true);
    if (setup.resultFocus?.ownerKey === ownerKey) useClaudeSetupTokenStore.setState({ resultFocus: null });
    if (!origin || ownsRegistration) { setRestoreFocus(true); onClosed?.(); }
    if (ownsRegistration && origin) setup.clearRegistrationOrigin(origin);
  };
  return <div ref={flowRef} tabIndex={-1} data-claude-setup-token="true" style={{ display: "grid", gap: 4, minWidth: 0 }}
    onKeyDown={event => {
      if (event.key === "Escape" || (!active && !confirming)) return;
      event.stopPropagation();
      if (event.key !== "Tab") return;
      event.preventDefault();
      const controls = [...(flowRef.current?.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input") ?? [])]
        .filter(control => !control.disabled);
      const at = controls.findIndex(control => control === document.activeElement);
      const next = event.shiftKey ? (at <= 0 ? controls.length - 1 : at - 1) : (at + 1) % controls.length;
      (controls[next] ?? flowRef.current)?.focus();
    }} onMouseDown={event => event.stopPropagation()}>
    {!active && !confirming && <button ref={registerRef} type="button" style={{ ...buttonStyle, justifySelf: "start" }} disabled={disabled || elsewhere}
      onClick={() => { setFailureDismissed(false); setConfirming(true); }}>{registered ? S.registerAgain : S.useInTab}</button>}
    {elsewhere && <div role="status">{S.busyElsewhere}</div>}
    {confirming && !active && <div style={{ display: "grid", gap: 4 }}>
      <p style={{ margin: 0 }}>{S.confirm(profile.label)}</p>
      <div style={{ display: "flex", gap: 4 }}>
        <button ref={beginRef} type="button" style={buttonStyle} disabled={disabled || elsewhere} onClick={() => {
          setup.startRegistration({ surface, provider: "claude", profileId: profile.id, ownerKey });
          setConfirming(false); setFailureDismissed(false); void setup.begin(profile.id); flowRef.current?.focus();
        }}>{S.begin}</button>
        <button type="button" style={buttonStyle} onClick={close}>{S.dismiss}</button>
      </div>
    </div>}
    {active && <div style={{ display: "grid", gap: 4 }}>
      <div role="status">{!event || event.state === "starting" ? S.starting : event.state === "checking_owner" ? S.checking : S.waiting}</div>
      {ownsRegistration && event?.state === "code_available" && <>
        {event.url && <>
          <div>{S.fallback}</div>
          <span style={{ overflowWrap: "anywhere" }}>{event.url}</span>
          <button type="button" style={{ ...buttonStyle, justifySelf: "start" }} onClick={() => {
            void open(event.url!).catch(() => setUrlFailed(true));
          }}>{S.openUrl}</button>
          {urlFailed && <div role="alert">{S.urlFailed}</div>}
        </>}
        <form onSubmit={event => { event.preventDefault(); void submit(); }} style={{ display: "grid", gap: 4 }}>
          <label>{S.codePrompt}
            <input ref={inputRef} type="password" aria-label={S.codeLabel} autoComplete="off" spellCheck={false}
              disabled={codeSent} maxLength={4096} style={{ display: "block", width: "100%", boxSizing: "border-box", minWidth: 0,
                border: "1px solid var(--cmux-border)", borderRadius: 3, padding: 4, fontSize: "inherit",
                color: "var(--cmux-text)", background: "var(--cmux-bg)" }} />
          </label>
          <button type="submit" style={{ ...buttonStyle, justifySelf: "start" }} disabled={codeSent}>{S.sendCode}</button>
          {codeSent && <div role="status">{S.codeSent}</div>}
        </form>
      </>}
      {event && event.state !== "checking_owner" && <button type="button" style={{ ...buttonStyle, justifySelf: "start" }} onClick={() => void setup.cancel(event.login_id)}>{S.cancel}</button>}
    </div>}
    {!active && event && !isSetupTokenActive(event) && event.login_id !== dismissedLogin && <div role={event.state === "saved" || event.state === "cancelled" ? "status" : "alert"}>
      {event.state === "saved" ? S.saved : message(event.reason ?? event.state)}
      <button ref={resultDismissRef} type="button" style={buttonStyle} onClick={close}>{S.dismiss}</button>
    </div>}
    {failure && <div role="alert">{message(failure)}
      {!active && <button type="button" style={buttonStyle} onClick={close}>{S.dismiss}</button>}
    </div>}
  </div>;
}
