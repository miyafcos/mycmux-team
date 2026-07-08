import { describe, expect, it } from "vitest";
import {
  findLocalFilePathLinks,
  isArtifactPreviewUri,
  isDirectoryLikeUri,
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

  it("matches drive-letter directories with Japanese characters, spaces, and trailing backslash", () => {
    const directory = "C:\\Users\\miyaz\\エデュ・プラニング合同会社 Dropbox\\エデュ・プラニング間屋口　亨\\事務関係\\日本教材出版\\数学\\2026年\\11月号\\3_一次原稿\\";
    const links = findLocalFilePathLinks(`folder: ${directory}`);

    expect(links.map((link) => link.text)).toEqual([directory]);
  });

  it("matches MSYS, file URI, and drive-root directories", () => {
    const links = findLocalFilePathLinks(
      "dirs: /c/Users/miyaz/work/ file:///C:/Users/miyaz/work/ C:\\",
    );

    expect(links.map((link) => link.text)).toEqual([
      "/c/Users/miyaz/work/",
      "file:///C:/Users/miyaz/work/",
      "C:\\",
    ]);
  });

  it("stops directory matches at the trailing separator before prose", () => {
    const links = findLocalFilePathLinks("納品物: C:\\Users\\x\\3_一次原稿\\ です");

    expect(links.map((link) => link.text)).toEqual([
      "C:\\Users\\x\\3_一次原稿\\",
    ]);
  });

  it("keeps file paths preferential over the directory alternative", () => {
    const links = findLocalFilePathLinks("open C:\\Users\\x\\folder.name\\report.final.txt ");

    expect(links.map((link) => link.text)).toEqual([
      "C:\\Users\\x\\folder.name\\report.final.txt",
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

  it("classifies directory-like URIs by trailing separator", () => {
    expect(isDirectoryLikeUri("C:\\Users\\miyaz\\work\\")).toBe(true);
    expect(isDirectoryLikeUri("/c/Users/miyaz/work/")).toBe(true);
    expect(isDirectoryLikeUri("file:///C:/Users/miyaz/work/")).toBe(true);
    expect(isDirectoryLikeUri(" C:\\ ")).toBe(true);
    expect(isDirectoryLikeUri("C:\\Users\\miyaz\\report.pdf")).toBe(false);
    expect(isDirectoryLikeUri("file:///C:/Users/miyaz/report.pdf")).toBe(false);
  });
});
