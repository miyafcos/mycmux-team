import { useLayoutEffect, useState, type RefObject } from "react";
import { clampMenuPosition } from "../lib/menuPosition";

export function usePopoverPosition(
  open: boolean,
  surfaceRef: RefObject<HTMLElement | null>,
  anchorRef: RefObject<HTMLElement | null>,
  point?: { x: number; y: number } | null,
) {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const pointX = point?.x;
  const pointY = point?.y;

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    const anchor = anchorRef.current;
    if (!open || !surface || !anchor) {
      setPosition(null);
      return;
    }
    const update = () => {
      const bounds = surface.getBoundingClientRect();
      const origin = anchor.getBoundingClientRect();
      const rightAligned = origin.right - bounds.width;
      const next = clampMenuPosition(
        pointX ?? (rightAligned >= 8 ? rightAligned : origin.left),
        pointY ?? origin.bottom + 6,
        bounds.width,
        bounds.height,
      );
      setPosition(previous => previous?.left === next.left && previous.top === next.top ? previous : next);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(surface);
    observer.observe(anchor);
    const pane = anchor.closest<HTMLElement>("[data-dnd-pane-id]");
    if (pane) observer.observe(pane);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    window.addEventListener("mycmux:terminal-layout-change", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("mycmux:terminal-layout-change", update);
    };
  }, [open, surfaceRef, anchorRef, pointX, pointY]);

  return position;
}
