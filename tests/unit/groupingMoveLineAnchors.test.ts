import { describe, expect, it } from "vitest";

import {
  groupingLeadInPath,
  groupingLineEndAnchor,
  groupingMeasuredMoveLines,
  groupingMoveLinePath,
  type GroupingLineRect,
} from "../../src/components/layout/groupingMoveLines";

function pointInsideRect(anchor: GroupingLineRect, sibling: GroupingLineRect): boolean {
  const x = anchor.left + anchor.width / 2;
  const y = anchor.top + anchor.height / 2;
  return x > sibling.left
    && x < sibling.left + sibling.width
    && y > sibling.top
    && y < sibling.top + sibling.height;
}

function rectsIntersect(left: GroupingLineRect, right: GroupingLineRect): boolean {
  return left.left < right.left + right.width
    && right.left < left.left + left.width
    && left.top < right.top + right.height
    && right.top < left.top + left.height;
}

function inflatedLeadIn(rect: GroupingLineRect, orientation: "horizontal" | "vertical"): GroupingLineRect {
  return orientation === "horizontal"
    ? { left: rect.left, top: rect.top - 2, width: rect.width, height: 4 }
    : { left: rect.left - 2, top: rect.top, width: 4, height: rect.height };
}

function paneFramesWithOpening(
  pane: GroupingLineRect,
  opening: GroupingLineRect,
  orientation: "horizontal" | "vertical",
): GroupingLineRect[] {
  const frame = 2;
  const top = { left: pane.left, top: pane.top, width: pane.width, height: frame };
  const right = { left: pane.left + pane.width - frame, top: pane.top, width: frame, height: pane.height };
  const bottom = { left: pane.left, top: pane.top + pane.height - frame, width: pane.width, height: frame };
  const left = { left: pane.left, top: pane.top, width: frame, height: pane.height };
  if (orientation === "horizontal") {
    const openingTop = Math.max(pane.top, opening.top - 4);
    const openingBottom = Math.min(pane.top + pane.height, opening.top + opening.height + 4);
    return [
      top,
      bottom,
      { ...left, height: Math.max(0, openingTop - pane.top) },
      { ...left, top: openingBottom, height: Math.max(0, pane.top + pane.height - openingBottom) },
      { ...right, height: Math.max(0, openingTop - pane.top) },
      { ...right, top: openingBottom, height: Math.max(0, pane.top + pane.height - openingBottom) },
    ].filter((rect) => rect.width > 0 && rect.height > 0);
  }
  const openingLeft = Math.max(pane.left, opening.left - 4);
  const openingRight = Math.min(pane.left + pane.width, opening.left + opening.width + 4);
  return [
    left,
    right,
    { ...top, width: Math.max(0, openingLeft - pane.left) },
    { ...top, left: openingRight, width: Math.max(0, pane.left + pane.width - openingRight) },
    { ...bottom, width: Math.max(0, openingLeft - pane.left) },
    { ...bottom, left: openingRight, width: Math.max(0, pane.left + pane.width - openingRight) },
  ].filter((rect) => rect.width > 0 && rect.height > 0);
}

function sampleMainCurve(
  from: GroupingLineRect,
  to: GroupingLineRect,
  orientation: "horizontal" | "vertical",
): Array<{ x: number; y: number }> {
  const x0 = orientation === "horizontal" ? from.left + from.width : from.left + from.width / 2;
  const y0 = orientation === "horizontal" ? from.top + from.height / 2 : from.top + from.height;
  const x3 = orientation === "horizontal" ? to.left : to.left + to.width / 2;
  const y3 = orientation === "horizontal" ? to.top + to.height / 2 : to.top;
  const delta = orientation === "horizontal"
    ? Math.max(24, (x3 - x0) * 0.5)
    : Math.max(24, (y3 - y0) * 0.5);
  const x1 = orientation === "horizontal" ? x0 + delta : x0;
  const y1 = orientation === "horizontal" ? y0 : y0 + delta;
  const x2 = orientation === "horizontal" ? x3 - delta : x3;
  const y2 = orientation === "horizontal" ? y3 : y3 - delta;
  return Array.from({ length: 101 }, (_, index) => {
    const t = index / 100;
    const inverse = 1 - t;
    return {
      x: inverse ** 3 * x0 + 3 * inverse ** 2 * t * x1 + 3 * inverse * t ** 2 * x2 + t ** 3 * x3,
      y: inverse ** 3 * y0 + 3 * inverse ** 2 * t * y1 + 3 * inverse * t ** 2 * y2 + t ** 3 * y3,
    };
  });
}

describe("groupingLineEndAnchor", () => {
  const horizontalChip = { left: 120, top: 40, width: 80, height: 20 };
  const horizontalWorkspace = { left: 20, top: 20, width: 300, height: 200 };
  const verticalChip = { left: 120, top: 100, width: 40, height: 20 };
  const verticalWorkspace = { left: 20, top: 20, width: 300, height: 200 };

  it("falls back to the original chip rectangle when no workspace was measured", () => {
    const horizontal = groupingLineEndAnchor(horizontalChip, null, [], "horizontal");
    const vertical = groupingLineEndAnchor(verticalChip, null, [], "vertical");
    expect(horizontal).toEqual({ anchor: horizontalChip, leadIn: null });
    expect(horizontal.anchor).toBe(horizontalChip);
    expect(vertical).toEqual({ anchor: verticalChip, leadIn: null });
    expect(vertical.anchor).toBe(verticalChip);
  });

  it("omits zero-length lead-ins at the workspace edge", () => {
    expect(groupingLineEndAnchor(
      { ...horizontalChip, left: horizontalWorkspace.left },
      horizontalWorkspace,
      [],
      "horizontal",
    )).toEqual({
      anchor: { left: 20, top: 40, width: 0, height: 20 },
      leadIn: null,
    });
    expect(groupingLineEndAnchor(
      { ...verticalChip, top: verticalWorkspace.top },
      verticalWorkspace,
      [],
      "vertical",
    )).toEqual({
      anchor: { left: 120, top: 20, width: 40, height: 0 },
      leadIn: null,
    });
  });

  it("creates clear horizontal and vertical lead-ins", () => {
    expect(groupingLineEndAnchor(horizontalChip, horizontalWorkspace, [], "horizontal")).toEqual({
      anchor: { left: 20, top: 40, width: 0, height: 20 },
      leadIn: { left: 20, top: 50, width: 100, height: 0 },
    });
    expect(groupingLineEndAnchor(verticalChip, verticalWorkspace, [], "vertical")).toEqual({
      anchor: { left: 120, top: 20, width: 40, height: 0 },
      leadIn: { left: 140, top: 20, width: 0, height: 80 },
    });
  });

  it("suppresses lead-ins that cross sibling chips and keeps anchors outside them", () => {
    const horizontalSibling = { left: 60, top: 45, width: 20, height: 10 };
    const horizontal = groupingLineEndAnchor(
      horizontalChip,
      horizontalWorkspace,
      [horizontalSibling],
      "horizontal",
    );
    expect(horizontal.leadIn).toBeNull();
    expect(pointInsideRect(horizontal.anchor, horizontalSibling)).toBe(false);

    const verticalSibling = { left: 130, top: 50, width: 20, height: 20 };
    const vertical = groupingLineEndAnchor(
      verticalChip,
      verticalWorkspace,
      [verticalSibling],
      "vertical",
    );
    expect(vertical.leadIn).toBeNull();
    expect(pointInsideRect(vertical.anchor, verticalSibling)).toBe(false);
  });

  it("treats edge contact as non-intersection", () => {
    const touchingHorizontal = { left: 60, top: 50, width: 20, height: 10 };
    const touchingVertical = { left: 140, top: 50, width: 20, height: 20 };
    const horizontal = groupingLineEndAnchor(
      horizontalChip,
      horizontalWorkspace,
      [touchingHorizontal],
      "horizontal",
    );
    expect(horizontal.leadIn).not.toBeNull();
    expect(pointInsideRect(horizontal.anchor, touchingHorizontal)).toBe(false);
    const vertical = groupingLineEndAnchor(
      verticalChip,
      verticalWorkspace,
      [touchingVertical],
      "vertical",
    );
    expect(vertical.leadIn).not.toBeNull();
    expect(pointInsideRect(vertical.anchor, touchingVertical)).toBe(false);
  });

  it("suppresses a lead-in when its four-pixel painted thickness crosses a sibling", () => {
    const siblingTouchingCentreLine = { left: 60, top: 50, width: 20, height: 8 };
    expect(groupingLineEndAnchor(
      horizontalChip,
      horizontalWorkspace,
      [siblingTouchingCentreLine],
      "horizontal",
    ).leadIn).not.toBeNull();
    expect(groupingLineEndAnchor(
      horizontalChip,
      horizontalWorkspace,
      [siblingTouchingCentreLine],
      "horizontal",
      4,
    ).leadIn).toBeNull();
  });

  it("keeps anchors and four-pixel lead-ins clear across 200 deterministic patterns", () => {
    let state = 0x5eed1234;
    const next = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
    const workspace = { left: 20, top: 20, width: 360, height: 260 };

    for (let pattern = 0; pattern < 200; pattern += 1) {
      for (const orientation of ["horizontal", "vertical"] as const) {
        const chip = {
          left: 180 + Math.floor(next() * 120),
          top: 100 + Math.floor(next() * 100),
          width: 48 + Math.floor(next() * 48),
          height: 18 + Math.floor(next() * 10),
        };
        const siblingCount = Math.floor(next() * 9);
        const siblings: GroupingLineRect[] = [];
        if (pattern % 17 === 0) {
          siblings.push(orientation === "horizontal"
            ? { left: workspace.left - 6, top: chip.top + chip.height / 2 - 4, width: 12, height: 8 }
            : { left: chip.left + chip.width / 2 - 4, top: workspace.top - 6, width: 8, height: 12 });
        }
        while (siblings.length < siblingCount) {
          const sibling = {
            left: 30 + Math.floor(next() * 300),
            top: 30 + Math.floor(next() * 210),
            width: 12 + Math.floor(next() * 48),
            height: 10 + Math.floor(next() * 30),
          };
          if (!pointInsideRect(chip, sibling)) siblings.push(sibling);
        }

        const result = groupingLineEndAnchor(chip, workspace, siblings, orientation, 4);
        const source = orientation === "horizontal"
          ? { left: -100, top: result.anchor.top, width: 60, height: Math.max(1, result.anchor.height) }
          : { left: result.anchor.left, top: -100, width: Math.max(1, result.anchor.width), height: 60 };
        expect(groupingMoveLinePath(source, result.anchor, orientation)).toMatch(/^M .* C /);
        const failures = siblings.filter((sibling) => pointInsideRect(result.anchor, sibling));
        expect(failures, `pattern=${pattern} orientation=${orientation} chip=${JSON.stringify(chip)} siblings=${JSON.stringify(siblings)}`)
          .toEqual([]);
        if (result.leadIn) {
          const crossed = siblings.filter((sibling) => rectsIntersect(inflatedLeadIn(result.leadIn!, orientation), sibling));
          expect(crossed, `pattern=${pattern} orientation=${orientation} leadIn=${JSON.stringify(result.leadIn)} siblings=${JSON.stringify(siblings)}`)
            .toEqual([]);
        }
        const inWorkspaceObstacles = siblings.filter((sibling) => (
          orientation === "horizontal" ? sibling.left >= workspace.left : sibling.top >= workspace.top
        ));
        const crossedByMain = inWorkspaceObstacles.filter((sibling) => sampleMainCurve(source, result.anchor, orientation)
          .some((point) => point.x > sibling.left && point.x < sibling.left + sibling.width
            && point.y > sibling.top && point.y < sibling.top + sibling.height));
        expect(crossedByMain, `pattern=${pattern} orientation=${orientation} main=${JSON.stringify({ source, anchor: result.anchor })}`)
          .toEqual([]);
      }
    }
  });

  it("keeps the complete rendered route clear of every after-chip and pane frame across 200 deterministic patterns", () => {
    let state = 0x71ab5eed;
    const next = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
    const workspace = { left: 120, top: 20, width: 360, height: 300 };
    for (let pattern = 0; pattern < 200; pattern += 1) {
      for (const orientation of ["horizontal", "vertical"] as const) {
        const target = {
          left: 300 + Math.floor(next() * 80),
          top: 100 + Math.floor(next() * 100),
          width: 64,
          height: 22,
        };
        const source = orientation === "horizontal"
          ? { left: 10, top: 30 + Math.floor(next() * 240), width: 70, height: 22 }
          : { left: 130 + Math.floor(next() * 280), top: -60, width: 70, height: 22 };
        const obstacles = Array.from({ length: 1 + Math.floor(next() * 8) }, (_, index) => ({
          left: 130 + Math.floor(next() * 140),
          top: 30 + Math.floor(next() * 250),
          width: 12 + Math.floor(next() * 36),
          height: 10 + Math.floor(next() * 26),
          id: `obstacle-${index}`,
        })).filter((rect) => !rectsIntersect(rect, target));
        const pane = {
          left: 170 + Math.floor(next() * 60),
          top: 50 + Math.floor(next() * 140),
          width: 36 + Math.floor(next() * 36),
          height: 42 + Math.floor(next() * 70),
        };
        const paneFrames = [
          { left: pane.left, top: pane.top, width: pane.width, height: 2 },
          { left: pane.left + pane.width - 2, top: pane.top, width: 2, height: pane.height },
          { left: pane.left, top: pane.top + pane.height - 2, width: pane.width, height: 2 },
          { left: pane.left, top: pane.top, width: 2, height: pane.height },
        ];
        const sourcePane = {
          left: source.left - 10,
          top: source.top - 10,
          width: source.width + 20,
          height: source.height + 20,
        };
        const destinationPane = {
          left: target.left - 10,
          top: target.top - 10,
          width: target.width + 20,
          height: target.height + 20,
        };
        const allPaneFrames = [
          ...paneFrames,
          ...paneFramesWithOpening(sourcePane, source, orientation),
          ...paneFramesWithOpening(destinationPane, target, orientation),
        ];
        const line = {
          tabId: "target",
          label: "target",
          fromWorkspaceId: "before",
          toWorkspaceId: "after",
          fromRect: null,
          toRect: null,
        };
        const measured = groupingMeasuredMoveLines({
          lines: [line],
          fromRects: new Map([[line.tabId, source]]),
          toRects: new Map([[line.tabId, target]]),
          afterChipRects: new Map([[line.tabId, target], ...obstacles.map((rect) => [rect.id, rect] as const)]),
          paneRects: new Map([
            ["pane-obstacle", pane],
            ["source-pane", sourcePane],
            ["destination-pane", destinationPane],
          ]),
          sourcePaneIds: new Map([[line.tabId, "source-pane"]]),
          destinationPaneIds: new Map([[line.tabId, "destination-pane"]]),
          workspaceRects: new Map([[line.toWorkspaceId, workspace]]),
          orientation,
        })[0];
        const routeSegments = measured.routePoints
          ? measured.routePoints.slice(1).map((point, index) => [measured.routePoints![index], point] as const)
          : sampleMainCurve(measured.fromRect!, measured.toRect!, orientation)
            .slice(1).map((point, index, points) => [index === 0
              ? sampleMainCurve(measured.fromRect!, measured.toRect!, orientation)[0]
              : points[index - 1], point] as const);
        if (measured.leadIn) {
          const lead = measured.leadIn;
          routeSegments.push(orientation === "horizontal"
            ? [{ x: lead.left, y: lead.top }, { x: lead.left + lead.width, y: lead.top }]
            : [{ x: lead.left, y: lead.top }, { x: lead.left, y: lead.top + lead.height }]);
        }
        const crossed = [...obstacles, ...allPaneFrames].filter((obstacle) => routeSegments.some(([from, to]) => rectsIntersect({
          left: Math.min(from.x, to.x) - 2,
          top: Math.min(from.y, to.y) - 2,
          width: Math.abs(to.x - from.x) + 4,
          height: Math.abs(to.y - from.y) + 4,
        }, obstacle)));
        expect(crossed, `pattern=${pattern} orientation=${orientation} route=${JSON.stringify(measured)}`).toEqual([]);
        const end = measured.routePoints?.at(-1) ?? (measured.leadIn
          ? orientation === "horizontal"
            ? { x: measured.leadIn.left + measured.leadIn.width, y: measured.leadIn.top }
            : { x: measured.leadIn.left, y: measured.leadIn.top + measured.leadIn.height }
          : orientation === "horizontal"
            ? { x: measured.toRect!.left, y: measured.toRect!.top + measured.toRect!.height / 2 }
            : { x: measured.toRect!.left + measured.toRect!.width / 2, y: measured.toRect!.top });
        if (orientation === "horizontal") {
          expect(end.y).toBe(target.top + target.height / 2);
          expect([target.left, target.left + target.width]).toContain(end.x);
        } else {
          expect(end.x).toBe(target.left + target.width / 2);
          expect([target.top, target.top + target.height]).toContain(end.y);
        }
      }
    }
  });
});

describe("groupingLeadInPath", () => {
  it("builds and rounds horizontal and vertical straight paths", () => {
    expect(groupingLeadInPath(
      { left: 10, top: 50, width: 30, height: 0 },
      "horizontal",
    )).toBe("M 10 50 L 40 50");
    expect(groupingLeadInPath(
      { left: 25, top: 10, width: 0, height: 30 },
      "vertical",
    )).toBe("M 25 10 L 25 40");
    expect(groupingLeadInPath(
      { left: 10.123, top: 50.456, width: 30.111, height: 0 },
      "horizontal",
    )).toBe("M 10.12 50.46 L 40.23 50.46");
  });
});
