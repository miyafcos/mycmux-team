import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { buildHtmlReviewRequest, htmlReviewStrings as s, type HtmlReviewCapture, type ReviewPageRevision } from "../../lib/htmlReviewDraft";
import { captureHtmlReviewTarget, searchHtmlReviewTargets, validateHtmlReviewCapture } from "../../lib/htmlReviewCapture";
import type { WebPaneNode } from "./webPaneApi";
import "./HtmlReviewDraftBar.css";

interface Props { tabId: string; sourcePath: string; previewPath: string; reloadKey: string }

/** Local request composition only. Copying does not create or deliver a work order. */
export default function HtmlReviewDraftBar({ tabId, sourcePath, previewPath, reloadKey }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [comment, setComment] = useState("");
  const [targets, setTargets] = useState<{ page: ReviewPageRevision; nodes: WebPaneNode[] } | null>(null);
  const [capture, setCapture] = useState<HtmlReviewCapture | null>(null);
  const [imageReady, setImageReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const epoch = useRef(0);
  const inFlight = useRef(false);
  const expectedUrl = convertFileSrc(previewPath);

  useEffect(() => {
    epoch.current++;
    inFlight.current = false;
    setBusy(false); setTargets(null); setCapture(null); setImageReady(false); setMessage(""); setError("");
    return () => { epoch.current++; };
  }, [tabId, sourcePath, previewPath, reloadKey]);

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
        setError(stale ? s.stale : text.includes(s.outside) ? s.outside : text.includes(s.clipboard) ? s.clipboard : s.failed);
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
  const select = (node: WebPaneNode) => void run(async (current) => {
    if (!targets) return;
    setCapture(null); setImageReady(false); setMessage(s.capturing);
    const next = await captureHtmlReviewTarget(tabId, expectedUrl, sourcePath, targets.page, node);
    if (current()) { setCapture(next); setMessage(""); }
  });
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
    epoch.current++; inFlight.current = false;
    setBusy(false); setOpen(!open); setTargets(null); setCapture(null); setImageReady(false); setMessage(""); setError("");
  };

  return <section className={`html-review-draft${open ? " is-open" : ""}`} aria-label={s.title}>
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
      {targets && !capture && <ul className="html-review-draft__targets" aria-label={s.query}>
        {targets.nodes.map((node) => <li key={node.ref}>
          <button type="button" disabled={busy || !node.inViewport} title={node.inViewport ? node.name : s.outside}
            onClick={() => select(node)}>{node.tag} : {node.name || node.role}</button>
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
