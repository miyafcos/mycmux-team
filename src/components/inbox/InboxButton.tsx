import { useCallback, useEffect, useState } from "react";
import { Inbox, X } from "lucide-react";
import { OverlayShell } from "../common/OverlayShell";
import { OVERLAY_EXIT_MS, useDeferredUnmount } from "../../hooks/useDeferredUnmount";
import { inboxSenderLabel, inboxStrings, listInboxEntries, openInboxEntry, type InboxEntry } from "../../lib/inbox";

function InboxPanel({ open, closing, onClose }: { open: boolean; closing: boolean; onClose: () => void }) {
  const [entries, setEntries] = useState<InboxEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError(false);
    void listInboxEntries().then((recent) => {
      if (active) setEntries(recent);
    }).catch(() => {
      if (active) setError(true);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [open, refresh]);
  return <OverlayShell open={open} closing={closing} onClose={onClose} size="dialog" ariaLabel={inboxStrings.title} id="inbox-panel">
    <header style={{ display: "flex", alignItems: "center", gap: 10, padding: 16, borderBottom: "1px solid var(--cmux-border)" }}>
      <div style={{ flex: 1 }}>
        <strong>{inboxStrings.title}</strong>
        <div style={{ fontSize: 12, color: "var(--cmux-text-secondary)", marginTop: 4 }}>{inboxStrings.recent}</div>
      </div>
      <button type="button" className="cmux-title-btn" disabled={loading || !open} onClick={() => setRefresh((value) => value + 1)}>{inboxStrings.refresh}</button>
      <button type="button" className="cmux-title-btn" aria-label={inboxStrings.close} onClick={onClose}><X size={14} /></button>
    </header>
    <div style={{ padding: 16, overflowY: "auto", minHeight: 0, color: "var(--cmux-text)" }}>
      {loading ? <p role="status">{inboxStrings.loading}</p> : error ? <p role="alert">{inboxStrings.failed}</p> :
        entries.length === 0 ? <p>{inboxStrings.empty}</p> :
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {entries.map((entry) => <li key={entry.path} style={{ borderBottom: "1px solid var(--cmux-border-hairline)", padding: "10px 0", display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
              <div>{entry.title}</div>
              <div style={{ color: "var(--cmux-text-secondary)", fontSize: 12, marginTop: 4 }}>
                {inboxSenderLabel(entry.from)} · {entry.receivedAt ? new Date(entry.receivedAt).toLocaleString() : ""}
              </div>
            </div>
            <button type="button" className="cmux-title-btn" disabled={!open} aria-label={entry.title + " " + inboxStrings.open} onClick={() => {
              onClose();
              void openInboxEntry(entry);
            }}>{inboxStrings.open}</button>
          </li>)}
        </ul>}
    </div>
  </OverlayShell>;
}

export function InboxButton() {
  const [open, setOpen] = useState(false);
  const { mounted, closing } = useDeferredUnmount(open, OVERLAY_EXIT_MS);
  const close = useCallback(() => setOpen(false), []);
  return <div style={{ height: 24, display: "flex", alignItems: "center" }}>
    <button type="button" className="cmux-title-btn" title={inboxStrings.title} aria-label={inboxStrings.title}
      aria-haspopup="dialog" aria-expanded={open} aria-controls="inbox-panel" onClick={() => setOpen((value) => !value)}
      style={{ background: "none", border: "none", color: "var(--cmux-text-secondary)", cursor: "pointer", padding: "3px 6px", display: "flex", alignItems: "center" }}>
      <Inbox size={14} aria-hidden="true" />
    </button>
    {mounted && <InboxPanel open={open} closing={closing} onClose={close} />}
  </div>;
}
