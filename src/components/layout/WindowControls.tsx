import { useEffect, useState, type CSSProperties } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { titleBarStrings } from "./titleBarStrings";

const buttonStyle: CSSProperties = {
  background: "none", border: "none", color: "var(--cmux-text-secondary)",
  cursor: "pointer", padding: "3px 6px", display: "flex", alignItems: "center",
};

/** Shared by the main title bar and Windows native tear-out bands. */
export function WindowControls({ onClose, closing = false, closeLabel = titleBarStrings.close,
  closeHint = closeLabel }: { onClose?: () => void; closing?: boolean; closeLabel?: string; closeHint?: string }) {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const win = getCurrentWindow();
    let live = true;
    const refresh = () => { void win.isMaximized().then(value => { if (live) setMaximized(value); }).catch(() => {}); };
    refresh();
    const resize = win.onResized(refresh);
    const move = win.onMoved(refresh);
    return () => {
      live = false;
      void resize.then(stop => stop());
      void move.then(stop => stop());
    };
  }, []);
  const maximizeLabel = maximized ? titleBarStrings.restore : titleBarStrings.maximize;
  return <>
    <button type="button" className="cmux-title-btn" style={buttonStyle}
      aria-label={titleBarStrings.minimize} title={titleBarStrings.minimize}
      onClick={() => { void getCurrentWindow().minimize().catch(console.error); }}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
    </button>
    <button type="button" className="cmux-title-btn" style={buttonStyle}
      aria-label={maximizeLabel} title={maximizeLabel}
      onClick={() => { void getCurrentWindow().toggleMaximize().catch(console.error); }}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {maximized ? <><rect x="5" y="7" width="12" height="12" rx="1" />
          <path d="M7 7V6a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-1" /></>
          : <rect x="4" y="4" width="16" height="16" rx="1" />}
      </svg>
    </button>
    <button type="button" className="cmux-title-btn cmux-title-btn--close" style={buttonStyle}
      aria-label={closeLabel} title={closeHint} disabled={closing}
      onClick={onClose ?? (() => { void getCurrentWindow().close().catch(console.error); })}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>
  </>;
}
