import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

type OverlaySize = "full" | "wide" | "dialog";
type OverlayLayer = "base" | "top";

interface OverlayShellProps {
  open: boolean;
  closing?: boolean;
  onClose: () => void;
  size?: OverlaySize;
  layer?: OverlayLayer;
  ariaLabel: string;
  id?: string;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
  onEscape?: () => boolean;
  children: ReactNode;
}

const sizeStyles: Record<OverlaySize, Pick<CSSProperties, "width" | "height">> = {
  full: {
    width: "var(--cmux-overlay-full-width)",
    height: "var(--cmux-overlay-full-height)",
  },
  wide: {
    width: "var(--cmux-overlay-wide-width)",
    height: "var(--cmux-overlay-wide-height)",
  },
  dialog: {
    width: "var(--cmux-overlay-dialog-width)",
    height: "var(--cmux-overlay-dialog-height)",
  },
};

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function isVisibleDisclosureTarget(element: HTMLElement): boolean {
  const closedDetails = element.closest("details:not([open])");
  if (!closedDetails) return true;
  return element.tagName === "SUMMARY" && element.parentElement === closedDetails;
}

function backdropStyle(layer: OverlayLayer): CSSProperties {
  return {
    position: "fixed",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "var(--cmux-overlay-gutter)",
    zIndex: layer === "top" ? "var(--cmux-overlay-z-top)" : "var(--cmux-overlay-z)",
  };
}

function panelStyle(size: OverlaySize): CSSProperties {
  // Fixed height: the dialog frame must not resize (and re-center) when
  // switching tabs — tab content scrolls inside instead.
  return {
    ...sizeStyles[size],
    background: "var(--cmux-popover)",
    border: "1px solid var(--cmux-border)",
    borderRadius: "var(--cmux-overlay-radius)",
    boxShadow: "var(--cmux-shadow-dialog)",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  };
}

export function OverlayShell({
  open,
  closing = false,
  onClose,
  size = "wide",
  layer = "base",
  ariaLabel,
  id,
  closeOnBackdrop = true,
  closeOnEscape = true,
  onEscape,
  children,
}: OverlayShellProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
  }, [open]);

  useEffect(() => {
    return () => {
      const previous = previouslyFocusedRef.current;
      if (previous && document.contains(previous)) previous.focus();
    };
  }, []);

  useEffect(() => {
    if (!open || closing) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const panel = panelRef.current;
      if (!panel) return;
      const dialogs = [...document.querySelectorAll<HTMLElement>(".cmux-overlay-panel[role='dialog']")]
        .filter((dialog) => !dialog.closest("[inert]"));
      if (dialogs[dialogs.length - 1] !== panel) return;
      if (event.key === "Tab") {
        const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
          .filter((element) => (
            element.getAttribute("aria-hidden") !== "true"
            && !element.closest("[inert], [hidden]")
            && isVisibleDisclosureTarget(element)
          ));
        if (focusable.length === 0) {
          event.preventDefault();
          panel.focus();
          return;
        }
        const active = document.activeElement as HTMLElement | null;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (active === panel || !active || !panel.contains(active)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        } else if (event.shiftKey && active === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
        return;
      }
      if (event.key === "Escape" && closeOnEscape) {
        event.preventDefault();
        if (onEscape?.()) return;
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closeOnEscape, closing, onClose, onEscape, open]);

  return (
    <div
      className={`cmux-overlay-backdrop${closing ? " is-closing" : ""}`}
      inert={closing ? true : undefined}
      aria-hidden={closing ? true : undefined}
      style={backdropStyle(layer)}
      onMouseDown={(event) => {
        if (!closing && closeOnBackdrop && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        id={id}
        ref={panelRef}
        className={`cmux-overlay-panel${closing ? " is-closing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        style={panelStyle(size)}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
