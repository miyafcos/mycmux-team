export const PRESEND_FRAME_HEIGHT_PX = 100;
export const PRESEND_FRAME_GAP_PX = 2;
/** Retain the original hysteresis while reserving enough terminal height. */
export function isComposerPaneTall(height: number, wasTall: boolean, readingVisible: boolean): boolean {
  return height >= (wasTall ? 200 : 224) + (readingVisible ? PRESEND_FRAME_HEIGHT_PX + PRESEND_FRAME_GAP_PX : 0);
}
