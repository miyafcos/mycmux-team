import { describe, expect, it } from "vitest";
import { getSessionTableRowMetrics } from "../../src/components/ailog/sessionTableRowHeight";

describe("getSessionTableRowMetrics", () => {
  it("fits a single chip row in compact density", () => {
    expect(getSessionTableRowMetrics("compact", 1)).toEqual({ rowHeight: 31, lineHeight: 1.25 });
  });

  it("fits a single chip row in relaxed density", () => {
    expect(getSessionTableRowMetrics("relaxed", 1)).toEqual({ rowHeight: 39, lineHeight: 1.8 });
  });

  it("uses the same rounded font scaling as the active UI tokens", () => {
    expect(getSessionTableRowMetrics("relaxed", 1.5)).toEqual({ rowHeight: 50, lineHeight: 1.8 });
  });
});
