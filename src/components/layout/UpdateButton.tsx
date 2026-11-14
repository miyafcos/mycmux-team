import { useEffect, useRef, useState } from "react";
import { OVERLAY_EXIT_MS, useDeferredUnmount } from "../../hooks/useDeferredUnmount";
import { useDismissOnOutside } from "../../hooks/useDismissOnOutside";
import { useWindowRole } from "../../lib/windowContext";
import { useUpdateAvailabilityStore } from "../../stores/updateAvailabilityStore";
import { UpdateConfirmation } from "./UpdateConfirmation";
import { updateStrings } from "./updateStrings";

export function UpdateButton({ testProfile }: { testProfile: string | null | undefined }) {
  const update = useUpdateAvailabilityStore();
  const hasRole = useWindowRole();
  const visible = !import.meta.env.DEV && hasRole && testProfile === null && update.state !== "none";
  const [isOpen, setIsOpen] = useState(false);
  const { mounted, closing } = useDeferredUnmount(isOpen && visible, OVERLAY_EXIT_MS);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const laterButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => { if (!visible) setIsOpen(false); }, [visible]);
  useDismissOnOutside(isOpen && visible, rootRef, (reason) => {
    setIsOpen(false);
    if (reason === "escape") triggerRef.current?.focus();
  }, { preventDefaultOnEscape: true });
  useEffect(() => {
    if (!isOpen || !visible) return;
    const frame = window.requestAnimationFrame(() => {
      (laterButtonRef.current ?? panelRef.current)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen, visible]);

  if (!visible) return null;
  const label = updateStrings.available(update.version);
  return (
    <div ref={rootRef} style={{ position: "relative", height: 24, display: "flex", alignItems: "center" }}>
      <button
        ref={triggerRef}
        type="button"
        title={label}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls="update-panel"
        className="cmux-title-btn"
        onClick={() => setIsOpen((value) => !value)}
        style={{
          background: "none", border: "none", color: "var(--cmux-accent)",
          cursor: "pointer", padding: "3px 6px", display: "flex", alignItems: "center",
        }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      </button>
      {mounted && (
        <div
          ref={panelRef}
          id="update-panel"
          role="dialog"
          aria-label={updateStrings.heading}
          aria-hidden={closing || undefined}
          tabIndex={-1}
          className={`cmux-popover-panel${closing ? " is-closing" : ""}`}
          style={{
            position: "absolute", top: "100%", right: 0, marginTop: 4,
            width: 340, boxSizing: "border-box", maxWidth: "calc(100vw - 16px)", padding: 16,
            maxHeight: "calc(100vh - 56px)", overflowY: "auto",
            background: "var(--cmux-popover)", border: "1px solid var(--cmux-border)",
            borderRadius: "var(--cmux-radius-md)", boxShadow: "var(--cmux-shadow-popover)",
            zIndex: 100, pointerEvents: closing ? "none" : undefined,
          }}
        >
          <UpdateConfirmation laterButtonRef={laterButtonRef} onLater={() => { setIsOpen(false); triggerRef.current?.focus(); }} />
        </div>
      )}
    </div>
  );
}
