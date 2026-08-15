import { describe, expect, it } from "vitest";

import { resolveMinimapDropZone } from "../../src/components/dashboard/minimapModel";

const rect = { left: 0, right: 100, top: 0, bottom: 60, width: 100, height: 60 };

describe("resolveMinimapDropZone", () => {
  it("uses the Oracle 22 percent edge clamped to 10 through 15 pixels", () => {
    expect(resolveMinimapDropZone({ ...rect, right: 40, width: 40 }, 9, 30)).toBe("left");
    expect(resolveMinimapDropZone({ ...rect, right: 40, width: 40 }, 11, 30)).toBe("center");
    expect(resolveMinimapDropZone(rect, 15, 30)).toBe("left");
    expect(resolveMinimapDropZone(rect, 16, 30)).toBe("center");
    expect(resolveMinimapDropZone({ ...rect, right: 200, width: 200 }, 15, 30)).toBe("left");
    expect(resolveMinimapDropZone({ ...rect, right: 200, width: 200 }, 16, 30)).toBe("center");
  });

  it("keeps an edge preview for four pixels after its boundary", () => {
    expect(resolveMinimapDropZone(rect, 18, 30, "left")).toBe("left");
    expect(resolveMinimapDropZone(rect, 19, 30, "left")).toBe("left");
    expect(resolveMinimapDropZone(rect, 20, 30, "left")).toBe("center");
  });

  it("uses horizontal zones before vertical zones at corners", () => {
    expect(resolveMinimapDropZone(rect, 8, 8)).toBe("left");
    expect(resolveMinimapDropZone(rect, 50, 8)).toBe("up");
    expect(resolveMinimapDropZone(rect, 50, 52)).toBe("down");
  });
});
