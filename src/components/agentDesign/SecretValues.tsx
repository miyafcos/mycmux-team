import { useEffect, useRef, useState } from "react";
import type { DocumentMask } from "../../lib/agentDesignApi";
import { agentDesignStrings as s } from "./agentDesignStrings";
export type RevealValue = (index: number) => Promise<string>;
export function SecretValue({ mask, reveal }: { mask: DocumentMask; reveal?: RevealValue }) {
  const [value, setValue] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const live = useRef(true);
  const epoch = useRef(0); const secret = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    live.current = true;
    const hide = () => { epoch.current++; setValue(null); setLoading(false); };
    const visibility = () => { if (document.hidden) hide(); };
    window.addEventListener("blur", hide); document.addEventListener("visibilitychange", visibility);
    return () => { live.current = false; epoch.current++; window.removeEventListener("blur", hide); document.removeEventListener("visibilitychange", visibility); };
  }, []);
  useEffect(() => {
    if (value == null) return;
    const timer = setTimeout(() => { epoch.current++; setValue(null); }, 15000);
    const blockCopy = (event: ClipboardEvent) => {
      const selection = window.getSelection();
      if (secret.current && selection && Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index)).some(range => range.intersectsNode(secret.current!))) event.preventDefault();
    };
    document.addEventListener("copy", blockCopy, true);
    return () => { clearTimeout(timer); document.removeEventListener("copy", blockCopy, true); };
  }, [value]);
  return <span className="ad-secret-value" data-secret-index={mask.index}>
    <span ref={secret} className="ad-secret-text" onCopy={event => event.preventDefault()}>{value == null ? "\u2022\u2022\u2022\u2022" : value || s.emptySecret}</span>
    <button type="button" disabled={!reveal || loading} aria-label={(value == null ? s.showSecret : s.hideSecret) + ": " + mask.label + " (" + mask.line + ")"} onClick={() => {
      if (value != null) { epoch.current++; setValue(null); return; }
      if (!reveal) return; const request = ++epoch.current; setLoading(true); setError(false);
      void reveal(mask.index).then(next => { if (live.current && request === epoch.current) setValue(next); })
        .catch(() => { if (live.current && request === epoch.current) setError(true); })
        .finally(() => { if (live.current && request === epoch.current) setLoading(false); });
    }}>{loading ? s.loadingSecret : value == null ? s.showSecret : s.hideSecret}</button>
    {error && <span role="status" className="ad-secret-error">{s.secretError}</span>}
  </span>;
}
export function SecretValues({ masks, reveal }: { masks: DocumentMask[]; reveal?: RevealValue }) {
  if (!masks.length) return null;
  return <section className="ad-secret-values" aria-label={s.maskedValues}><p>{s.secretsNotice}</p>{masks.map(mask =>
    <div key={mask.index}><span>{mask.label} / {mask.line} {s.linesUnit}</span><SecretValue mask={mask} reveal={reveal} /></div>)}</section>;
}
export function SourceText({ body, masks = [], reveal, highlightLine }: { body: string; masks?: DocumentMask[]; reveal?: RevealValue; highlightLine?: number }) {
  const lines = body.match(/[^\n]*\n|[^\n]+$/g) ?? [""];
  let start = 0;
  return <pre className="ad-document ad-document-source" aria-label={s.sourceDocument}>{lines.map((line, index) => {
    const begin = start; const end = begin + line.length; start = end;
    const pieces = []; let cursor = begin;
    for (const mask of masks.filter(m => m.start >= begin && m.start < end)) {
      pieces.push(body.slice(cursor, mask.start));
      pieces.push(<SecretValue key={mask.index} mask={mask} reveal={reveal} />);
      cursor = Math.min(end, mask.start + 4);
    }
    pieces.push(body.slice(cursor, end));
    return <span className={"ad-source-line" + (highlightLine === index + 1 ? " ad-evidence-line" : "")} data-source-line={index + 1} key={index}><span className="ad-line-number" aria-hidden="true">{index + 1}</span><code>{pieces}</code></span>;
  })}</pre>;
}
