import { useEffect, useRef, useState, type FormEvent } from "react";
import { getFeedbackDestinationStatus, saveFeedbackDestination, removeFeedbackDestination } from "./feedbackApi";
import { dialogButtonStyle, sectionHeadingStyle } from "../settings/tabStyles";
import { feedbackErrorMessage, feedbackStrings as strings } from "./feedbackStrings";
import { feedbackInputStyle, feedbackLabelStyle } from "./feedbackStyles";

export function FeedbackDestinationSection() {
  const [configured, setConfigured] = useState<boolean | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [statusFailed, setStatusFailed] = useState(false);
  const keyInput = useRef<HTMLInputElement>(null);
  const targetInput = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  useEffect(() => {
    let active = true;
    void getFeedbackDestinationStatus().then(status => {
      if (typeof status?.configured !== "boolean") throw new Error("unknown_status");
      if (active) setConfigured(status.configured === true);
    }).catch(() => { if (active) { setStatusFailed(true); setError(strings.errors.storage); } });
    return () => { active = false; };
  }, []);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    const key = (keyInput.current?.value ?? "").trim();
    const target = (targetInput.current?.value ?? "").trim();
    if (!/^xoxb-[A-Za-z0-9-]+$/.test(key) || key.length > 512 || !/^[CGUW][A-Z0-9]{1,63}$/.test(target)) {
      setError(strings.errors.invalidDestination);
      return;
    }
    // Inputs are uncontrolled: protected values never enter React state, local storage, or a status response.
    if (keyInput.current) keyInput.current.value = "";
    if (targetInput.current) targetInput.current.value = "";
    pending.current = true; setBusy(true); setError("");
    try {
      const status = await saveFeedbackDestination(key, target);
      setConfigured(status.configured === true); setEditing(false);
    } catch (reason) { setError(feedbackErrorMessage(reason)); }
    finally { pending.current = false; setBusy(false); }
  }
  async function remove() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const status = await removeFeedbackDestination();
      setConfigured(status.configured === true); setConfirming(false);
    } catch (reason) { setError(feedbackErrorMessage(reason)); }
    finally { pending.current = false; setBusy(false); }
  }
  return (
    <section aria-label={strings.destinationHeading} style={{ marginTop: 20, color: "var(--cmux-text)", fontSize: 12 }}>
      <h3 style={sectionHeadingStyle}>{strings.destinationHeading}</h3>
      <p role="status">{configured === undefined ? statusFailed ? strings.statusFailed : strings.checking : configured ? strings.configured : strings.unconfigured}</p>
      {(configured !== undefined || statusFailed) && !editing && !confirming && <div style={{ display: "flex", gap: 8 }}>
        <button type="button" style={dialogButtonStyle} onClick={() => { setEditing(true); setError(""); }}>{strings.configure}</button>
        {configured !== false && <button type="button" style={dialogButtonStyle} onClick={() => { setConfirming(true); setError(""); }}>{strings.remove}</button>}
      </div>}
      {editing && <form onSubmit={event => { void save(event); }}>
        <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 10, minWidth: 0 }}>
          <label style={feedbackLabelStyle}>{strings.token}
            <input ref={keyInput} aria-label={strings.token} type="password" autoComplete="new-password" spellCheck={false} maxLength={512} style={feedbackInputStyle} />
          </label>
          <label style={feedbackLabelStyle}>{strings.destination}
            <input ref={targetInput} aria-label={strings.destination} autoComplete="off" spellCheck={false} maxLength={64} style={feedbackInputStyle} />
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="submit" disabled={busy} style={dialogButtonStyle}>{busy ? strings.saving : strings.save}</button>
            <button type="button" disabled={busy} style={dialogButtonStyle} onClick={() => { setEditing(false); setError(""); }}>{strings.cancel}</button>
          </div>
        </fieldset>
      </form>}
      {confirming && <div>
        <p>{strings.confirmRemove}</p>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" disabled={busy} style={dialogButtonStyle} onClick={() => { void remove(); }}>{strings.removeDestination}</button>
          <button type="button" disabled={busy} style={dialogButtonStyle} onClick={() => setConfirming(false)}>{strings.back}</button>
        </div>
      </div>}
      {error && <p role="alert" style={{ color: "var(--cmux-red)" }}>{error}</p>}
    </section>
  );
}
