import { describe, expect, it } from "vitest";
import {
  ARTIFACT_EXTENSION_PATTERN,
  sourceKindFromPath,
  sourceKindLabel,
} from "../../src/lib/artifactSourceKind";
import { isArtifactPreviewUri } from "../../src/components/terminal/terminalLinkProvider";
import { useDashboardViewStore } from "../../src/stores/dashboardViewStore";
import { sourceKindFromPath as storeSourceKindFromPath } from "../../src/stores/workspaceLayoutStore";
import type { ArtifactSourceKind } from "../../src/types";

describe("sourceKindFromPath", () => {
  it.each([
    ["C:/notes/memo.txt", "text"],
    ["C:/notes/memo.TXT", "text"],
    ["/home/miyaz/run.log", "text"],
    ["/home/miyaz/readme.text", "text"],
    ["C:/reports/report.md", "markdown"],
    ["C:/reports/report.markdown", "markdown"],
    ["C:/reports/report.html", "html"],
    ["C:/reports/report.pdf", "pdf"],
    ["C:/reports/report.docx", "office"],
    ["C:/reports/report.pptx", "office"],
  ] as [string, ArtifactSourceKind][])("reads %s as %s", (path, kind) => {
    expect(sourceKindFromPath(path)).toBe(kind);
  });

  it("answers html for a name it does not recognise", () => {
    // The backend refuses anything outside its own list before this is asked,
    // so the fallback only ever decides between kinds that already passed.
    expect(sourceKindFromPath("C:/reports/report.unknown")).toBe("html");
  });

  it("is the same function the workspace store exports", () => {
    // Both stores and the link provider used to carry their own copy of this
    // table, and the copies drifted.
    expect(storeSourceKindFromPath).toBe(sourceKindFromPath);
  });
});

describe("sourceKindLabel", () => {
  it.each([
    ["text", "TXT"],
    ["markdown", "MD"],
    ["html", "HTML"],
    ["pdf", "PDF"],
    ["office", "OFFICE"],
  ] as [ArtifactSourceKind, string][])("labels %s as %s", (kind, label) => {
    expect(sourceKindLabel(kind)).toBe(label);
  });

  it("titles a dashboard preview column with the same label", () => {
    useDashboardViewStore.getState().openOrReloadPreviewColumn({ previewPath: "C:/notes/memo.txt" });
    expect(useDashboardViewStore.getState().previewColumn).toMatchObject({
      sourceKind: "text",
      label: "TXT memo.txt",
    });
  });
});

describe("ARTIFACT_EXTENSION_PATTERN", () => {
  it("covers every extension the kind table names", () => {
    const pattern = new RegExp(`^(?:${ARTIFACT_EXTENSION_PATTERN})$`, "i");
    for (const extension of ["txt", "text", "log", "md", "markdown", "html", "htm", "pdf", "docx", "xlsx", "pptx"]) {
      expect(pattern.test(extension)).toBe(true);
    }
  });

  it("is what the terminal decides a path is clickable by", () => {
    expect(isArtifactPreviewUri("C:/notes/memo.txt")).toBe(true);
    expect(isArtifactPreviewUri("C:/notes/data.csv")).toBe(false);
  });
});
