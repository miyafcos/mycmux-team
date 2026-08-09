import { describe, expect, it } from "vitest";
import {
  SAVE_RETRY_DELAYS_MS,
  saveRetryDelayMs,
} from "../../src/components/layout/SocketListener";

describe("autosave failure retry ladder", () => {
  it("walks 5s → 15s → 30s for consecutive failures", () => {
    expect(saveRetryDelayMs(0)).toBe(5000);
    expect(saveRetryDelayMs(1)).toBe(15000);
    expect(saveRetryDelayMs(2)).toBe(30000);
  });

  it("caps at the last rung instead of growing without bound", () => {
    expect(saveRetryDelayMs(3)).toBe(30000);
    expect(saveRetryDelayMs(50)).toBe(SAVE_RETRY_DELAYS_MS[SAVE_RETRY_DELAYS_MS.length - 1]);
  });

  it("treats a reset ladder (or a negative count) as the first rung", () => {
    expect(saveRetryDelayMs(-1)).toBe(SAVE_RETRY_DELAYS_MS[0]);
  });
});
