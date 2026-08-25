import { describe, expect, it } from "vitest";

import { selectionFromPivotCell } from "../../src/components/ailog/crossTableModel";

describe("selectionFromPivotCell", () => {
  it("keeps an exact model and project intersection", () => {
    expect(selectionFromPivotCell("project", "model", "mycmux", "gpt-5.6-sol")).toEqual({
      project: { key: "mycmux", label: "mycmux" },
      model: { key: "gpt-5.6-sol", label: "gpt-5.6-sol" },
    });
  });

  it("does not widen an unknown model intersection to project-only", () => {
    expect(selectionFromPivotCell("project", "model", "mycmux", "(unknown)")).toBeNull();
  });

  it("does not widen an unknown project intersection to model-only", () => {
    expect(selectionFromPivotCell("project", "model", "(unknown)", "gpt-5.6-sol")).toBeNull();
  });
});
