import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import type { FeedbackImage } from "../../lib/ipc";
import { getFeedbackDestinationStatus, sendFeedback } from "./feedbackApi";
import { useToastStore } from "../../stores/toastStore";
import { OverlayShell } from "../common/OverlayShell";
import { dialogButtonStyle } from "../settings/tabStyles";
import { clearFeedbackDraft, loadFeedbackDraft, saveFeedbackDraft, hasFailedFeedbackDraft, rememberFeedbackSender, type FeedbackDraft } from "./feedbackDraft";
import { normalizeFeedbackImage } from "./feedbackImages";
import { feedbackCategories, feedbackFeatures, feedbackUrgencies, feedbackErrorMessage, feedbackStrings as strings } from "./feedbackStrings";
import { feedbackInputStyle, feedbackLabelStyle } from "./feedbackStyles";

interface Props { initialImages: FeedbackImage[]; captureMessage: string; onClose: () => void }
const groupStyle: CSSProperties = { border: 0, padding: 0, margin: 0, minWidth: 0 };
const choicesStyle: CSSProperties = { display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 };
const dataUrl = (image: FeedbackImage) => `data:${image.mime};base64,${image.data}`;

export function FeedbackDialog({ initialImages, captureMessage, onClose }: Props) {
  const [draft, setDraft] = useState(loadFeedbackDraft);
  const [failed, setFailed] = useState(hasFailedFeedbackDraft);
  const [images, setImages] = useState(() => initialImages.slice(0, 3));
  const [configured, setConfigured] = useState<boolean | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [imageMessage, setImageMessage] = useState("");
  const [preview, setPreview] = useState<FeedbackImage | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const imagesRef = useRef(images);
  const submitting = useRef(false);
  const addingRef = useRef(false);
  const active = useRef(true);
  const sent = useRef(false);

  useEffect(() => {
    active.current = true;
    void getFeedbackDestinationStatus().then(status => {
      if (typeof status?.configured !== "boolean") throw new Error("unknown_status");
      if (active.current) setConfigured(status.configured === true);
    }).catch(() => { if (active.current) { setError(strings.errors.storage); } });
    return () => { active.current = false; };
  }, []);
  useEffect(() => {
    rememberFeedbackSender(draft.sender);
    if (failed && !sent.current) saveFeedbackDraft(draft);
  }, [draft, failed]);
  useEffect(() => {
    document.addEventListener("paste", paste);
    return () => document.removeEventListener("paste", paste);
  }, []);

  const missing = [
    !draft.category && strings.category, !draft.feature && strings.feature,
    !draft.problem.trim() && strings.problem, !draft.urgency && strings.urgency, !draft.sender.trim() && strings.sender,
  ].flatMap(value => value ? [value] : []);
  const tooLong = Array.from(draft.problem).length > 4000 || Array.from(draft.want).length > 2000 || Array.from(draft.sender).length > 120;
  const canSend = configured === true && missing.length === 0 && !tooLong && !sending && !adding;
  function update(key: keyof FeedbackDraft, value: string) { setDraft(current => ({ ...current, [key]: value })); }
  function close() {
    if (!submitting.current) {
      if (!failed) clearFeedbackDraft();
      onClose();
    }
  }
  async function addImages(sources: File[]) {
    if (submitting.current || addingRef.current || !sources.length) return;
    addingRef.current = true; setAdding(true); setImageMessage("");
    const next = [...imagesRef.current];
    const overflow = sources.length + next.length > 3;
    let message = overflow ? strings.imageLimit : "";
    for (const source of sources.slice(0, 3 - next.length)) {
      try { next.push(await normalizeFeedbackImage(source)); }
      catch (reason) {
        const value = reason instanceof Error ? reason.message : reason;
        message = value === strings.imageTooLarge ? strings.imageTooLarge : strings.errors.invalidImage;
      }
      if (!active.current) { addingRef.current = false; return; }
    }
    if (active.current) { imagesRef.current = next; setImages(next); setImageMessage(message); setAdding(false); }
    addingRef.current = false;
  }
  function paste(event: globalThis.ClipboardEvent) {
    const target = event.target instanceof Element ? event.target.closest('[role="dialog"]') : null;
    if (!target || target !== formRef.current?.closest('[role="dialog"]') || !event.clipboardData) return;
    if (event.target instanceof Element && event.target.matches("input, textarea")
      && Array.from(event.clipboardData.types).includes("text/plain")) return;
    const files = Array.from(event.clipboardData.files).filter(file => file.type.startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    void addImages(files);
  }
  function remove(index: number) {
    if (submitting.current || addingRef.current) return;
    const next = imagesRef.current.filter((_, position) => position !== index);
    imagesRef.current = next; setImages(next); setImageMessage("");
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSend || submitting.current) return;
    submitting.current = true; setSending(true); setError("");
    try {
      await sendFeedback({ ...draft, images: imagesRef.current });
      sent.current = true; clearFeedbackDraft();
      useToastStore.getState().pushToast(strings.sent, "info");
      onClose();
    } catch (reason) {
      saveFeedbackDraft(draft);
      if (active.current) { setFailed(true); setError(feedbackErrorMessage(reason)); }
    }
    finally {
      submitting.current = false;
      if (active.current) setSending(false);
    }
  }
  function choices(options: readonly { value: string; label: string }[], key: "category" | "urgency", label: string) {
    return <fieldset style={groupStyle} aria-label={label}>
      <legend style={{ padding: 0 }}>{label}</legend>
      <div style={choicesStyle}>{options.map(option => <button key={option.value} type="button"
        aria-pressed={draft[key] === option.value} onClick={() => update(key, option.value)}
        style={{ ...dialogButtonStyle, borderColor: draft[key] === option.value ? "var(--cmux-accent)" : "var(--cmux-border)" }}>
        {option.label}
      </button>)}</div>
    </fieldset>;
  }
  return <OverlayShell open ariaLabel={strings.open} size="dialog" onClose={close}
    closeOnEscape={!sending && preview === null} closeOnBackdrop={!sending && preview === null}>
    <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--cmux-border)" }}>
      <h2 style={{ margin: 0, fontSize: 14, color: "var(--cmux-text)" }}>{strings.open}</h2>
    </div>
    <form ref={formRef} onSubmit={event => { void submit(event); }}
      style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, fontSize: 12, color: "var(--cmux-text)" }}>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 20 }}>
        {configured === undefined && !error && <p>{strings.checking}</p>}
        {configured === false && <p style={{ marginTop: 0 }}>{strings.errors.notConfigured}</p>}
        <fieldset disabled={sending} style={{ ...groupStyle, display: "grid", gap: 16 }}>
          <section aria-label={strings.screenshots}>
            <div>{strings.screenshots} ({strings.optional})</div>
            <p style={{ margin: "6px 0", lineHeight: 1.5 }}>{strings.reviewImages}</p>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {images.map((image, index) => <div key={index} style={{ display: "grid", gap: 4 }}>
                <button type="button" aria-label={strings.preview(index + 1)} disabled={sending}
                  style={{ ...dialogButtonStyle, padding: 3 }} onClick={() => setPreview(image)}>
                  <img src={dataUrl(image)} alt={strings.imageAlt(index + 1)} width={96} height={60} style={{ display: "block", objectFit: "contain" }} />
                </button>
                <button type="button" style={dialogButtonStyle} disabled={sending || adding} onClick={() => remove(index)}>{strings.remove}</button>
              </div>)}
            </div>
            <button type="button" style={{ ...dialogButtonStyle, marginTop: 8 }} disabled={sending || adding || images.length >= 3}
              onClick={() => imageInput.current?.click()}>{strings.addImage}</button>
            <input ref={imageInput} type="file" aria-label={strings.addImage} accept="image/*" multiple hidden
              onChange={event => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; void addImages(files); }} />
            {captureMessage && <p style={{ fontSize: 11, marginBottom: 0 }}>{captureMessage}</p>}
            {imageMessage && <p role="alert">{imageMessage}</p>}
          </section>
          {choices(feedbackCategories, "category", strings.category)}
          <label style={feedbackLabelStyle}>{strings.feature}
            <select aria-label={strings.feature} value={draft.feature} onChange={event => update("feature", event.target.value)} style={feedbackInputStyle}>
              <option value="">{strings.choose}</option>
              {feedbackFeatures.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label style={feedbackLabelStyle}>{strings.problem}
            <textarea aria-label={strings.problem} value={draft.problem} maxLength={4000} rows={4}
              onChange={event => update("problem", event.target.value)} style={{ ...feedbackInputStyle, resize: "vertical" }} />
          </label>
          <label style={feedbackLabelStyle}>{strings.want} ({strings.optional})
            <textarea aria-label={strings.want} value={draft.want} maxLength={2000} rows={3}
              onChange={event => update("want", event.target.value)} style={{ ...feedbackInputStyle, resize: "vertical" }} />
          </label>
          {choices(feedbackUrgencies, "urgency", strings.urgency)}
          <label style={feedbackLabelStyle}>{strings.sender}
            <input aria-label={strings.sender} value={draft.sender} maxLength={120} autoComplete="name"
              onChange={event => update("sender", event.target.value)} style={feedbackInputStyle} />
          </label>
        </fieldset>
        <p>{strings.attached}</p>
        <p role="status" style={{ marginBottom: 0 }}>{tooLong ? strings.tooLong : missing.length ? strings.missing(missing) : ""}</p>
        {error && <p role="alert" style={{ color: "var(--cmux-red)" }}>{error}</p>}
      </div>
      <div style={{ padding: "12px 20px", display: "flex", gap: 8, justifyContent: "flex-end", borderTop: "1px solid var(--cmux-border)" }}>
        <button type="submit" style={dialogButtonStyle} disabled={!canSend}>{sending ? strings.sending : strings.send}</button>
        <button type="button" style={dialogButtonStyle} disabled={sending} onClick={close}>{strings.cancel}</button>
      </div>
    </form>
    {preview && <OverlayShell open size="wide" layer="top" ariaLabel={strings.previewTitle} onClose={() => setPreview(null)}>
      <div style={{ minHeight: 0, flex: 1, padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
        <img src={dataUrl(preview)} alt={strings.previewTitle} style={{ minHeight: 0, flex: 1, width: "100%", objectFit: "contain" }} />
        <button type="button" style={{ ...dialogButtonStyle, alignSelf: "flex-end" }} onClick={() => setPreview(null)}>{strings.close}</button>
      </div>
    </OverlayShell>}
  </OverlayShell>;
}
