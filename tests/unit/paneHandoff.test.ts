import { describe, expect, it } from "vitest";
import {
  isPaneDropTargetEligible,
  resolvePaneDropZone,
} from "../../src/lib/paneHandoff";

describe("pane drop zones", () => {
  it("keeps regular center and edge zone resolution deterministic", () => {
    const rect = { left: 0, right: 1_000, top: 0, bottom: 600, width: 1_000, height: 600 };

    expect(resolvePaneDropZone(rect, 500, 300)).toBe("center");
    expect(resolvePaneDropZone(rect, 10, 300)).toBe("left");
    expect(resolvePaneDropZone(rect, 500, 590)).toBe("down");
  });

  it("reaches an outer third of the width and an outer quarter of the height", () => {
    const rect = { left: 0, right: 1_000, top: 0, bottom: 600, width: 1_000, height: 600 };

    // A share of the pane, not a pixel cap: the old 24-72px band left the
    // window edge of a wide pane answering "center" until the last few pixels.
    expect(resolvePaneDropZone(rect, 330, 300)).toBe("left");
    expect(resolvePaneDropZone(rect, 340, 300)).toBe("center");
    expect(resolvePaneDropZone(rect, 670, 300)).toBe("right");
    expect(resolvePaneDropZone(rect, 500, 148)).toBe("up");
    expect(resolvePaneDropZone(rect, 500, 152)).toBe("center");
  });

  it("scales a narrow pane's band with the pane", () => {
    const rect = { left: 0, right: 240, top: 0, bottom: 400, width: 240, height: 400 };

    expect(resolvePaneDropZone(rect, 78, 200)).toBe("left");
    expect(resolvePaneDropZone(rect, 82, 200)).toBe("center");
  });

  it("settles a corner by depth into each band, not by raw pixels", () => {
    const rect = { left: 0, right: 1_000, top: 0, bottom: 600, width: 1_000, height: 600 };

    // 100px into a 333px band is shallower than 60px into a 150px band, so the
    // horizontal split wins even though the pointer is closer to the top edge.
    expect(resolvePaneDropZone(rect, 100, 60)).toBe("left");
    expect(resolvePaneDropZone(rect, 200, 30)).toBe("up");
  });

  it("keeps the zone in hand for four pixels past the boundary", () => {
    const rect = { left: 0, right: 1_000, top: 0, bottom: 600, width: 1_000, height: 600 };

    expect(resolvePaneDropZone(rect, 336, 300)).toBe("center");
    expect(resolvePaneDropZone(rect, 336, 300, "left")).toBe("left");
    expect(resolvePaneDropZone(rect, 339, 300, "left")).toBe("center");
  });
});

describe("pane drop target eligibility", () => {
  const target = (workspaceId: string, paneId: string, zone: "center" | "left" | "right" | "up" | "down") => ({
    kind: "pane" as const,
    workspaceId,
    paneId,
    zone,
  });

  it("rejects every zone when a whole pane targets itself", () => {
    const source = { kind: "pane" as const, workspaceId: "workspace-a", paneId: "pane-a" };
    for (const zone of ["center", "left", "right", "up", "down"] as const) {
      expect(isPaneDropTargetEligible(source, target("workspace-a", "pane-a", zone), 3))
        .toBe(false);
    }
  });

  it("rejects every self-zone for a pane's only tab", () => {
    const source = { kind: "tab" as const, workspaceId: "workspace-a", paneId: "pane-a" };
    for (const zone of ["center", "left", "right", "up", "down"] as const) {
      expect(isPaneDropTargetEligible(source, target("workspace-a", "pane-a", zone), 1))
        .toBe(false);
    }
  });

  it("allows only edge splits when a multi-tab pane targets itself", () => {
    const source = { kind: "tab" as const, workspaceId: "workspace-a", paneId: "pane-a" };
    expect(isPaneDropTargetEligible(source, target("workspace-a", "pane-a", "center"), 2))
      .toBe(false);
    for (const zone of ["left", "right", "up", "down"] as const) {
      expect(isPaneDropTargetEligible(source, target("workspace-a", "pane-a", zone), 2))
        .toBe(true);
    }
  });

  it("uses both workspace and pane identity before treating a target as self", () => {
    const source = { kind: "tab" as const, workspaceId: "workspace-a", paneId: "pane-a" };
    expect(isPaneDropTargetEligible(source, target("workspace-b", "pane-a", "center"), 1))
      .toBe(true);
    expect(isPaneDropTargetEligible(source, target("workspace-a", "pane-b", "center"), 1))
      .toBe(true);
  });
});
