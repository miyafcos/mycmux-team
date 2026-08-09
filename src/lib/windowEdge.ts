// Drag tear-out edge detection (Phase 3c).
//
// While a pointer is captured, moves keep arriving after the cursor leaves the
// window; their client coordinates simply fall outside the viewport. That is
// the whole detection — no OS hit-testing involved. The margin keeps a drag
// that merely grazes the window edge (docked windows, maximized apps) from
// reading as "take this to a new window".

export const TEAR_OUT_EDGE_MARGIN_PX = 40;

export function isOutsideWindowViewport(
  clientX: number,
  clientY: number,
  viewportWidth: number,
  viewportHeight: number,
  margin: number = TEAR_OUT_EDGE_MARGIN_PX,
): boolean {
  return (
    clientX < -margin ||
    clientY < -margin ||
    clientX > viewportWidth + margin ||
    clientY > viewportHeight + margin
  );
}
