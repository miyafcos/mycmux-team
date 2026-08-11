import { useCallback, useState } from "react";

import { OVERLAY_EXIT_MS, useDeferredUnmount } from "../../hooks/useDeferredUnmount";
import { AiLogIcon } from "../icons/ChromeIcons";
import { AiLogPanel } from "./AiLogPanel";

/**
 * Title-bar entry point for the AI log dashboard. Plain toggle, no badge: the
 * dashboard reads a local database on demand and nothing about it should nag
 * from the title bar.
 */
export function AiLogButton() {
  const [open, setOpen] = useState(false);
  const { mounted, closing } = useDeferredUnmount(open, OVERLAY_EXIT_MS);

  const closePanel = useCallback(() => setOpen(false), []);

  return (
    <div style={{ position: "relative", height: 24, display: "flex", alignItems: "center" }}>
      <button
        type="button"
        className="cmux-title-btn"
        title="AIログ分析"
        aria-label="AIログ分析"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="ailog-panel"
        onClick={() => setOpen((value) => !value)}
        style={{
          background: "none",
          border: "none",
          color: "var(--cmux-text-secondary)",
          cursor: "pointer",
          padding: "3px 6px",
          borderRadius: 3,
          display: "flex",
          alignItems: "center",
        }}
      >
        <AiLogIcon />
      </button>
      <AiLogPanel open={open} visible={mounted} closing={closing} onClose={closePanel} />
    </div>
  );
}
