import { describe, expect, it } from "vitest";
import { isComposerPaneTall, PRESEND_FRAME_HEIGHT_PX, PRESEND_FRAME_GAP_PX } from "../../src/lib/paneComposerVisibility";

describe("composer height hysteresis", () => {
  it.each([
    [false, 199, false, 200, true, 223, false, 224, true],
    [true, 301, false, 302, true, 325, false, 326, true],
  ] as const)("reserves the frame and outer gap only when visible: %s", (visible, low, lowValue, high, highValue, enterLow, enterLowValue, enterHigh, enterHighValue) => {
    expect(isComposerPaneTall(low, true, visible)).toBe(lowValue);
    expect(isComposerPaneTall(high, true, visible)).toBe(highValue);
    expect(isComposerPaneTall(enterLow, false, visible)).toBe(enterLowValue);
    expect(isComposerPaneTall(enterHigh, false, visible)).toBe(enterHighValue);
  });
  it("keeps the actual frame at 100px and adds the existing 2px outer gap", () => {
    expect(PRESEND_FRAME_HEIGHT_PX).toBe(100);
    expect(PRESEND_FRAME_GAP_PX).toBe(2);
  });
});
