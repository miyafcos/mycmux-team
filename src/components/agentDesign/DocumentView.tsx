import { useEffect, useId, useRef, useState } from "react";
import type { DesignDocument } from "../../lib/agentDesignApi";
import { MarkdownView } from "../skills/MarkdownView";
import { SecretValues, SourceText, type RevealValue } from "./SecretValues";
import { agentDesignStrings as s, bytes } from "./agentDesignStrings";

export function DocumentView({ document: doc, reveal, onFile, highlightLine }: { document: DesignDocument; reveal?: RevealValue; onFile?: (relative: string, offset?: number) => void; highlightLine?: number }) {
  const [source, setSource] = useState(highlightLine != null);
  const [notice, setNotice] = useState("");
  const host = useRef<HTMLDivElement>(null);
  const headingPrefix = "ad-heading-" + useId().replace(/:/g, "");
  const markdown = doc.html != null;
  const raw = doc.body ?? "";
  const metadata = Object.entries(doc.frontmatter ?? {});
  const toc = doc.toc ?? [];
  const masks = doc.masks ?? [];
  useEffect(() => { if (source && highlightLine != null) host.current?.querySelector<HTMLElement>('[data-source-line="' + highlightLine + '"]')?.scrollIntoView?.({ block: "center" }); }, [source, highlightLine, doc.body]);
  return <div ref={host} className="ad-document-view">
    {doc.files && <nav className="ad-document-files" aria-label={s.documentFiles}>
      <div><strong>{s.documentFiles} ({doc.fileCount ?? doc.files.length})</strong>{doc.parent != null && <button type="button" disabled={!onFile} onClick={() => onFile?.(doc.parent!)}>{s.parentFolder}</button>}</div>
      <div className="ad-file-list">{doc.files.map(file => <button type="button" key={file.id} data-ad-file={file.id}
        title={file.reason ? s.documentReasons[file.reason] ?? s.documentError : file.name}
        disabled={!onFile || Boolean(file.reason)} aria-pressed={file.id === doc.relative} onClick={() => onFile?.(file.id)}>
        <span>{file.directory ? "\u25b8 " : ""}{file.name}</span>{file.private && <small>{s.maskedFile}</small>}
      </button>)}</div>
      {doc.nextOffset != null && <button type="button" disabled={!onFile} onClick={() => onFile?.(doc.folder ?? (doc.relative?.split("/")[0] ?? "0") + "/", doc.nextOffset!)}>{s.moreFiles}</button>}
    </nav>}
    {doc.path && <code className="ad-path">{doc.path}</code>}
    {doc.truncated && <p role="status">{s.truncatedDocument} ({bytes(doc.size.bytes)})</p>}
    {doc.reason && <p role="status">{s.documentReasons[doc.reason] ?? s.documentError}</p>}
    {doc.body != null && markdown && <nav className="ad-document-tools" aria-label={s.documentDisplay}>
      <button type="button" aria-pressed={!source} onClick={() => setSource(false)}>{s.renderedDocument}</button>
      <button type="button" aria-pressed={source} onClick={() => setSource(true)}>{s.sourceDocument}</button>
    </nav>}
    {notice && <p role="status">{notice}</p>}
    {doc.body != null && (markdown && !source ? <>
      {metadata.length > 0 && <table className="ad-frontmatter" aria-label={s.documentMetadata}>
        <caption>{s.documentMetadata}</caption><tbody>{metadata.map(([name, value]) => <tr key={name}>
          <th scope="row">{name}</th><td>{typeof value === "string" ? value : JSON.stringify(value)}</td>
        </tr>)}</tbody>
      </table>}
      <SecretValues masks={masks} reveal={reveal} />
      {raw.length >= 2000 && toc.length > 1 && <nav className="ad-document-toc" aria-label={s.documentToc}>
        <strong>{s.documentToc}</strong>{toc.map((heading, index) => <button type="button" key={index}
          style={{ paddingLeft: (heading.level - 1) * 10 + 8 }} onClick={() => {
            host.current?.querySelectorAll<HTMLElement>("[id]").forEach(el => {
              if (el.id === headingPrefix + "-" + index) el.scrollIntoView({ block: "start", behavior: "smooth" });
            });
          }}>{heading.text}</button>)}
      </nav>}
      <MarkdownView html={doc.html!} headingPrefix={headingPrefix} notify={setNotice} />
    </> : <SourceText body={raw} masks={masks} reveal={reveal} highlightLine={highlightLine} />)}
  </div>;
}
