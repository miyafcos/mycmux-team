// Shared helper for clamping a context-menu/popover's preferred position so it
// stays fully inside the viewport, regardless of which corner it was opened near.
export function clampMenuPosition(
  preferredLeft: number,
  preferredTop: number,
  width: number,
  height: number,
): { left: number; top: number } {
  const pad = 8;
  let left = preferredLeft;
  let top = preferredTop;

  if (left + width + pad > window.innerWidth) {
    left = Math.max(pad, preferredLeft - width);
  }
  if (top + height + pad > window.innerHeight) {
    top = Math.max(pad, window.innerHeight - height - pad);
  }

  left = Math.max(pad, Math.min(left, window.innerWidth - width - pad));
  top = Math.max(pad, Math.min(top, window.innerHeight - height - pad));

  return { left, top };
}
