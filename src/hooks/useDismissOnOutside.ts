import { useEffect, useRef, type RefObject } from "react";

/** Why the popover was asked to close. */
export type DismissReason = "outside" | "escape";

export type DismissRef = RefObject<HTMLElement | null>;

/** Anything that can answer "is this node inside me?" — an element, in practice. */
interface DismissContainer {
  contains(node: Node | null): boolean;
}

export interface UseDismissOnOutsideOptions {
  /**
   * Call preventDefault() on the Escape keydown that dismisses. Off by default:
   * popovers layered over the terminal must let xterm see the key.
   */
  preventDefaultOnEscape?: boolean;
}

/**
 * True when a pointer event landed outside every mounted container.
 *
 * With no container mounted the answer is false: the popover cannot be open, so
 * a stray event must not close anything.
 */
export function isOutsideDismiss(
  target: EventTarget | null,
  containers: Array<DismissContainer | null | undefined>,
): boolean {
  const mounted = containers.filter((container): container is DismissContainer => Boolean(container));
  if (mounted.length === 0) return false;
  return !mounted.some((container) => container.contains(target as Node | null));
}

/**
 * Close-on-outside-click plus close-on-Escape for popovers, menus and inline
 * panels. Both gestures always apply — a popover that closes on one but not the
 * other is a bug, and hand-rolled copies of this effect used to disagree.
 *
 * Listeners live on `window` in the capture phase (so a child calling
 * stopPropagation cannot trap the popover open) and are attached only while
 * `active` is true.
 *
 * Pass every element that counts as "inside": the popover itself, and the
 * trigger when it sits outside the popover subtree. Modals with their own
 * backdrop do not need this hook — the backdrop already catches outside clicks.
 */
export function useDismissOnOutside(
  active: boolean,
  refs: DismissRef | DismissRef[],
  onDismiss: (reason: DismissReason) => void,
  options: UseDismissOnOutsideOptions = {},
): void {
  // refs arrays and inline callbacks get a fresh identity on nearly every
  // render; reading them from a ref at event time keeps the listeners attached
  // for the whole open/close cycle instead of churning once per keystroke.
  const latest = useRef({ refs, onDismiss, options });
  latest.current = { refs, onDismiss, options };

  useEffect(() => {
    if (!active) return;

    const containers = (): Array<HTMLElement | null> => {
      const current = latest.current.refs;
      return (Array.isArray(current) ? current : [current]).map((ref) => ref.current);
    };

    const onMouseDown = (event: MouseEvent) => {
      if (!isOutsideDismiss(event.target, containers())) return;
      latest.current.onDismiss("outside");
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (latest.current.options.preventDefaultOnEscape) event.preventDefault();
      latest.current.onDismiss("escape");
    };

    window.addEventListener("mousedown", onMouseDown, true);
    // Right-click outside must dismiss too: it does not always deliver a
    // mousedown (and used to leave menus stranded open under the suppressed
    // native context menu).
    window.addEventListener("contextmenu", onMouseDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("contextmenu", onMouseDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [active]);
}
