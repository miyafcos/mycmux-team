import { describe, expect, it } from "vitest";
import {
  findLocalFilePathLinks,
  isArtifactPreviewUri,
} from "../../src/components/terminal/terminalLinkProvider";

describe("terminal local file path links", () => {
  it("matches drive-letter paths with arbitrary extensions", () => {
    const links = findLocalFilePathLinks(
      String.raw`files: C:\Users\miyaz\AppData\Local\report.pdf C:/Users/miyaz/data.csv C:\tmp\note.txt C:\tmp\image.png`,
    );

    expect(links.map((link) => link.text)).toEqual([
      String.raw`C:\Users\miyaz\AppData\Local\report.pdf`,
      "C:/Users/miyaz/data.csv",
      String.raw`C:\tmp\note.txt`,
      String.raw`C:\tmp\image.png`,
    ]);
  });

  it("matches file URI and MSYS drive paths with arbitrary extensions", () => {
    const links = findLocalFilePathLinks(
      "see file:///C:/Users/miyaz/report.pdf and /c/Users/miyaz/data.csv",
    );

    expect(links.map((link) => link.text)).toEqual([
      "file:///C:/Users/miyaz/report.pdf",
      "/c/Users/miyaz/data.csv",
    ]);
  });

  it("keeps intermediate dots in directory and file names", () => {
    const links = findLocalFilePathLinks(String.raw`open C:\x\v1.2\final.report.v3.txt`);

    expect(links.map((link) => link.text)).toEqual([
      String.raw`C:\x\v1.2\final.report.v3.txt`,
    ]);
  });

  it("excludes trailing punctuation from matches", () => {
    expect(findLocalFilePathLinks(String.raw`open C:\tmp\report.pdf.`)[0].text).toBe(
      String.raw`C:\tmp\report.pdf`,
    );
    expect(findLocalFilePathLinks(String.raw`(C:\tmp\data.csv)`)[0].text).toBe(
      String.raw`C:\tmp\data.csv`,
    );
    expect(findLocalFilePathLinks(String.raw`path=C:\tmp\note.txt、`)[0].text).toBe(
      String.raw`C:\tmp\note.txt`,
    );
  });

  it("classifies existing artifact whitelist paths as previewable", () => {
    expect(isArtifactPreviewUri(String.raw`C:\tmp\index.html`)).toBe(true);
    expect(isArtifactPreviewUri(String.raw`C:\tmp\notes.md`)).toBe(true);
    expect(isArtifactPreviewUri(String.raw`C:\tmp\book.xlsx`)).toBe(true);
    expect(isArtifactPreviewUri("file:///C:/tmp/deck.pptx")).toBe(true);
  });

  it("classifies other detected file extensions as non-preview paths", () => {
    expect(isArtifactPreviewUri(String.raw`C:\tmp\report.pdf`)).toBe(false);
    expect(isArtifactPreviewUri("/c/Users/miyaz/data.csv")).toBe(false);
    expect(isArtifactPreviewUri(String.raw`C:\tmp\note.txt`)).toBe(false);
    expect(isArtifactPreviewUri(String.raw`C:\tmp\image.png`)).toBe(false);
  });
});
