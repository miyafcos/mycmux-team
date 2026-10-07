import { listen } from "@tauri-apps/api/event";
import { WEB_PANE_URL_EVENT, type WebPaneUrlEvent } from "./webPaneApi";
import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { buildHtmlReviewRequest, htmlReviewStrings as s, type HtmlReviewCapture, type ReviewPageRevision, type ReviewTarget } from "../../lib/htmlReviewDraft";
import { cancelHtmlReviewPicker, chooseHtmlReviewElement, captureHtmlReviewTarget, readHtmlReviewSelection, searchHtmlReviewTargets, validateHtmlReviewCapture } from "../../lib/htmlReviewCapture";
import "./HtmlReviewDraftBar.css";

interface Props { tabId: string; sourcePath: string; previewPath: string; reloadKey: string }

/** Local request composition only. Copying does not create or deliver a work order. */
export default function HtmlReviewDraftBar({ tabId, sourcePath, previewPath, reloadKey }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [comment, setComment] = useState("");
  const [targets, setTargets] = useState<{ page: ReviewPageRevision; nodes: ReviewTarget[] } | null>(null);
  const [capture, setCapture] = useState<HtmlReviewCapture | null>(null);
  const [imageReady, setImageReady] = useState(false);
  const [picking, setPicking] = useState(false);
  const picker = useRef<{ tabId: string; token: string } | null>(null);
  const stopPicker = useCallback(() => {
    const active = picker.current; picker.current = null;
    if (active) void cancelHtmlReviewPicker(active.tabId, active.token).catch(() => undefined);
  }, []);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const epoch = useRef(0);
  const inFlight = useRef(false);
  const expectedUrl = convertFileSrc(previewPath);

  useEffect(() => {
    epoch.current++;
    inFlight.current = false;
    stopPicker(); setPicking(false);
    setBusy(false); setTargets(null); setCapture(null); setImageReady(false); setMessage(""); setError("");
    return () => { epoch.current++; stopPicker(); };
  }, [tabId, sourcePath, previewPath, reloadKey, stopPicker]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const listening = listen<WebPaneUrlEvent>(WEB_PANE_URL_EVENT, ({ payload }) => {
      if (disposed || payload.tabId !== tabId) return;
      try { if (new URL(payload.url).href === new URL(expectedUrl).href) return; } catch { /* Invalid URLs also invalidate a draft. */ }
      epoch.current++; inFlight.current = false; stopPicker();
      setBusy(false); setPicking(false); setTargets(null); setCapture(null); setImageReady(false);
      setMessage(""); setError(s.stale);
    });
    void listening.then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(() => undefined);
    return () => { disposed = true; unlisten?.(); };
  }, [tabId, expectedUrl, stopPicker]);

  const run = async (operation: (current: () => boolean) => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const token = ++epoch.current;
    const current = () => epoch.current === token;
    setBusy(true); setError("");
    try { await operation(current); }
    catch (caught) {
      if (current()) {
        const text = String(caught);
        const stale = text.includes("review-stale") || text.includes("stale ref") || text.includes(s.stale);
        setError(stale ? s.stale : (text.includes(s.outside) || text.includes("review-outside")) ? s.outside : text.includes(s.clipboard) ? s.clipboard : s.failed);
        setMessage("");
        if (stale) { setCapture(null); setTargets(null); }
      }
    } finally {
      if (current()) { inFlight.current = false; setBusy(false); }
    }
  };
  const search = () => void run(async (current) => {
    setCapture(null); setImageReady(false); setTargets(null); setMessage(s.searching);
    const next = await searchHtmlReviewTargets(tabId, expectedUrl, query);
    if (current()) { setTargets(next); setMessage(next.nodes.length ? "" : s.empty); }
  });
  const select = (node: ReviewTarget) => void run(async (current) => {
    if (!targets) return;
    setCapture(null); setImageReady(false); setMessage(s.capturing);
    const next = await captureHtmlReviewTarget(tabId, expectedUrl, sourcePath, targets.page, node);
    if (current()) { setCapture(next); setMessage(""); }
  });
  const selectRange = () => void run(async (current) => {
    setCapture(null); setImageReady(false); setTargets(null); setMessage(s.capturing);
    const selected = await readHtmlReviewSelection(tabId, expectedUrl);
    if (!current()) return;
    if (!selected.node) { setMessage(s.noSelection); return; }
    const next = await captureHtmlReviewTarget(tabId, expectedUrl, sourcePath, selected.page, selected.node);
    if (current()) { setCapture(next); setMessage(""); }
  });
  const pickScreen = () => void run(async (current) => {
    setCapture(null); setImageReady(false); setTargets(null); setMessage(s.picking); setPicking(true);
    const token = crypto.randomUUID();
    picker.current = { tabId, token };
    try {
      const selected = await chooseHtmlReviewElement(tabId, expectedUrl, token, current);
      if (!current()) return;
      setPicking(false);
      if (!selected) { setMessage(s.pickCancelled); return; }
      setMessage(s.capturing);
      const next = await captureHtmlReviewTarget(tabId, expectedUrl, sourcePath, selected.page, selected.node);
      if (current()) { setCapture(next); setMessage(""); }
    } finally {
      if (picker.current?.token === token) picker.current = null;
      if (current()) setPicking(false);
    }
  });
  const cancelPicking = () => {
    epoch.current++; inFlight.current = false; stopPicker();
    setBusy(false); setPicking(false); setMessage(s.pickCancelled); setError("");
  };
  const copy = () => void run(async (current) => {
    if (!capture || !imageReady) return;
    setMessage("");
    await validateHtmlReviewCapture(capture, expectedUrl);
    if (!current()) return;
    try { await navigator.clipboard.writeText(buildHtmlReviewRequest(capture, comment)); }
    catch { throw new Error(s.clipboard); }
    if (current()) setMessage(s.copied);
  });
  const toggle = () => {
    epoch.current++; inFlight.current = false; stopPicker(); setPicking(false);
    setBusy(false); setOpen(!open); setTargets(null); setCapture(null); setImageReady(false); setMessage(""); setError("");
  };

  return <section className={`html-review-draft${open ? " is-open" : ""}`} aria-label={s.title}
    onKeyDown={(event) => { if (picking && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelPicking(); } }}>
    <div className="html-review-draft__heading">
      <button type="button" aria-expanded={open} onClick={toggle}>{open ? s.close : s.open}</button>
      {open && <span>{s.hint}</span>}
    </div>
    {open && <div className="html-review-draft__body">
      <div className="html-review-draft__search">
        <input aria-label={s.query} value={query} maxLength={200} disabled={busy}
          placeholder={s.query} onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing && !busy) search(); }} />
        <button type="button" disabled={busy} onClick={search}>{s.search}</button>
      </div>
      <div className="html-review-draft__methods">
        <button type="button" disabled={busy} onClick={selectRange}>{s.selection}</button>
        <button type="button" disabled={busy} onClick={pickScreen}>{s.pick}</button>
        {picking && <button type="button" onClick={cancelPicking}>{s.cancelPick}</button>}
      </div>
      {targets && !capture && <ul className="html-review-draft__targets" aria-label={s.query}>
        {targets.nodes.map((node) => <li key={node.ref}>
          <button type="button" disabled={busy || !node.inViewport} title={node.inViewport ? node.name : s.outside}
            onClick={() => select(node)}>{node.tag} : {node.name || node.role}{node.anchor?.heading && <small>{node.anchor.heading}</small>}</button>
        </li>)}
      </ul>}
      {capture && <div className="html-review-draft__selected">
        <img src={convertFileSrc(capture.screenshot.path)} alt={capture.node.name || capture.node.tag}
          onLoad={() => setImageReady(true)} onError={() => { setImageReady(false); setCapture(null); setError(s.failed); }} />
        <div>
          <strong>{capture.node.name || capture.node.tag}</strong>
          <textarea aria-label={s.comment} value={comment} maxLength={2000} disabled={busy}
            placeholder={s.comment} onChange={(event) => { setComment(event.target.value); setMessage(""); }} />
          <button type="button" disabled={busy || !imageReady || !comment.trim()} onClick={copy}>{s.copy}</button>
        </div>
      </div>}
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
      <small>{s.pending}</small>
    </div>}
  </section>;
}
