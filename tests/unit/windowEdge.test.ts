import { describe, expect, it } from "vitest";
import { TEAR_OUT_EDGE_MARGIN_PX, isOutsideWindowViewport } from "../../src/lib/windowEdge";

const WIDTH = 1200;
const HEIGHT = 800;

describe("isOutsideWindowViewport", () => {
  it("is inside anywhere within the viewport", () => {
    expect(isOutsideWindowViewport(0, 0, WIDTH, HEIGHT)).toBe(false);
    expect(isOutsideWindowViewport(600, 400, WIDTH, HEIGHT)).toBe(false);
    expect(isOutsideWindowViewport(WIDTH, HEIGHT, WIDTH, HEIGHT)).toBe(false);
  });

  it("tolerates the margin band so edge-grazing drags do not tear out", () => {
    expect(isOutsideWindowViewport(-TEAR_OUT_EDGE_MARGIN_PX, 400, WIDTH, HEIGHT)).toBe(false);
    expect(isOutsideWindowViewport(WIDTH + TEAR_OUT_EDGE_MARGIN_PX, 400, WIDTH, HEIGHT)).toBe(false);
    expect(isOutsideWindowViewport(600, HEIGHT + TEAR_OUT_EDGE_MARGIN_PX, WIDTH, HEIGHT)).toBe(false);
  });

  it("is outside past the margin on any edge", () => {
    expect(isOutsideWindowViewport(-TEAR_OUT_EDGE_MARGIN_PX - 1, 400, WIDTH, HEIGHT)).toBe(true);
    expect(isOutsideWindowViewport(600, -TEAR_OUT_EDGE_MARGIN_PX - 1, WIDTH, HEIGHT)).toBe(true);
    expect(isOutsideWindowViewport(WIDTH + TEAR_OUT_EDGE_MARGIN_PX + 1, 400, WIDTH, HEIGHT)).toBe(true);
    expect(isOutsideWindowViewport(600, HEIGHT + TEAR_OUT_EDGE_MARGIN_PX + 1, WIDTH, HEIGHT)).toBe(true);
  });

  it("honours a custom margin", () => {
    expect(isOutsideWindowViewport(-10, 400, WIDTH, HEIGHT, 0)).toBe(true);
    expect(isOutsideWindowViewport(-10, 400, WIDTH, HEIGHT, 20)).toBe(false);
  });
});
