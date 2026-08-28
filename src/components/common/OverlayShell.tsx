import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

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

interface OverlayIsolationState {
  depth: number;
  restore: Map<HTMLElement, { inert: boolean; ariaHidden: string | null }>;
}

const overlayIsolationByRoot = new WeakMap<HTMLElement, OverlayIsolationState>();

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
  const isolationWasOpenedRef = useRef(false);
  const portalTarget = typeof document === "undefined"
    ? null
    : document.querySelector<HTMLElement>("[data-cmux-themed-root]") ?? document.body;

  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
  }, [open]);

  const backgroundIsolationActive = open || closing;
  useEffect(() => {
    if (!backgroundIsolationActive || (closing && !isolationWasOpenedRef.current)) return;
    isolationWasOpenedRef.current = true;
    if (!portalTarget) return;
    const isolation = overlayIsolationByRoot.get(portalTarget) ?? {
      depth: 0,
      restore: new Map<HTMLElement, { inert: boolean; ariaHidden: string | null }>(),
    };
    if (isolation.depth === 0) overlayIsolationByRoot.set(portalTarget, isolation);
    isolation.depth += 1;
    if (isolation.depth === 1) {
      for (const element of portalTarget.children) {
        if (!(element instanceof HTMLElement) || element.hasAttribute("data-cmux-overlay-root")) continue;
        isolation.restore.set(element, {
          inert: element.hasAttribute("inert"),
          ariaHidden: element.getAttribute("aria-hidden"),
        });
        element.setAttribute("inert", "");
        element.setAttribute("aria-hidden", "true");
      }
    }
    return () => {
      isolation.depth -= 1;
      if (isolation.depth !== 0) return;
      for (const [element, previous] of isolation.restore) {
        if (previous.inert) element.setAttribute("inert", "");
        else element.removeAttribute("inert");
        if (previous.ariaHidden === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", previous.ariaHidden);
      }
      isolation.restore.clear();
      overlayIsolationByRoot.delete(portalTarget);
    };
  }, [backgroundIsolationActive, closing, portalTarget]);

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

  const overlay = (
    <div
      data-cmux-overlay-root="true"
      className={`cmux-overlay-backdrop${closing ? " is-closing" : ""}`}
      inert={closing ? true : undefined}
      aria-hidden={closing ? true : undefined}
      style={backdropStyle(layer)}
      onMouseDown={(event) => {
        if (!closing && closeOnBackdrop && (event.button ?? 0) === 0 && event.target === event.currentTarget) onClose();
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
  return portalTarget ? createPortal(overlay, portalTarget) : overlay;
}
