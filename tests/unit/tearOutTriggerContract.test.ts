import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  TEAR_OUT_DRAG_THRESHOLD_PX,
  TEAR_OUT_DWELL_MS,
  WORKSPACE_DRAG_HORIZONTAL_THRESHOLD_PX,
  WORKSPACE_DRAG_VERTICAL_THRESHOLD_PX,
  isTearOutDistanceArmed,
} from "../../src/lib/tearOutDiagnostics";
import { TEAR_OUT_EDGE_MARGIN_PX, isOutsideWindowViewport } from "../../src/lib/windowEdge";

const repoRoot = resolve(import.meta.dirname, "../..");

describe("tear-out trigger contract", () => {
  it("pins the pre-instrumentation numeric conditions", () => {
    expect(TEAR_OUT_DRAG_THRESHOLD_PX).toBe(9);
    expect(WORKSPACE_DRAG_VERTICAL_THRESHOLD_PX).toBe(5);
    expect(WORKSPACE_DRAG_HORIZONTAL_THRESHOLD_PX).toBe(24);
    expect(TEAR_OUT_EDGE_MARGIN_PX).toBe(40);
    expect(TEAR_OUT_DWELL_MS).toBe(0);
    expect(isOutsideWindowViewport(-40, 100, 1_200, 800)).toBe(false);
    expect(isOutsideWindowViewport(-41, 100, 1_200, 800)).toBe(true);
    expect(isTearOutDistanceArmed(40)).toBe(false);
    expect(isTearOutDistanceArmed(41)).toBe(true);
  });

  it("keeps pane/tab instrumentation wired around the existing target resolution", () => {
    const source = readFileSync(resolve(repoRoot, "src/hooks/usePaneDragSource.ts"), "utf8");
    expect(source).toContain("Math.hypot(dx, dy) < threshold");
    expect(source).toContain("isOutsideWindowViewport(");
    expect(source).toContain("target = canDropTarget(dragItem, candidate) ? candidate : null;");
    expect(source).toContain("trace?.arm(pointer);");
    expect(source).toContain("trace?.commitPending(workspaceId, focusSessionId);");
    expect(source).toContain("trace?.windowCreateRequested();");
    expect(source).toContain("trace?.sourceDetached();");
    expect(source).toContain("trace?.committed();");
  });

  it("keeps workspace instrumentation wired without adding a dwell gate", () => {
    const source = readFileSync(resolve(repoRoot, "src/components/layout/TabBar.tsx"), "utf8");
    expect(source).toContain("Math.abs(e.clientY - startY.current) < WORKSPACE_DRAG_VERTICAL_THRESHOLD_PX");
    expect(source).toContain("Math.abs(e.clientX - startX.current) < WORKSPACE_DRAG_HORIZONTAL_THRESHOLD_PX");
    expect(source).toContain("const outside = isOutsideWindowViewport(");
    expect(source).toContain("tearOutTraceRef.current?.arm(pointer);");
    expect(source).toContain("trace?.commitPending(workspace.id, primaryWorkspaceSessionId(workspace));");
    expect(source).toContain("trace?.windowCreateRequested();");
    expect(source).not.toMatch(/tearOutReady[\s\S]{0,300}setTimeout/);
  });

  it("never renders the measurement HUD without the Vite development guard", () => {
    const source = readFileSync(resolve(repoRoot, "src/components/layout/TabBar.tsx"), "utf8");
    const hudStart = source.indexOf("function TearOutDiagnosticsHud");
    const renderStart = source.indexOf("return (", hudStart);
    const guard = source.indexOf("if (!import.meta.env.DEV || !measurement) return null;", hudStart);
    expect(hudStart).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(hudStart);
    expect(guard).toBeLessThan(renderStart);
  });
});
