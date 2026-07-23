import type { ILink, Terminal } from "@xterm/xterm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveLocalPathLinks } from "../../src/lib/ipc";

vi.mock("../../src/lib/ipc", () => ({
  resolveLocalPathLinks: vi.fn(),
}));

vi.mock("../../src/components/terminal/terminalCache", () => ({
  getTerminalWriteCounter: vi.fn(() => 0),
  registerTerminalCacheEvictionCleanup: vi.fn(),
}));

import {
  findBareLocalPathCandidates,
  findLocalFilePathLinks,
  isArtifactPreviewUri,
  isDirectoryLikeUri,
  mergeResolvedPathLinkMatches,
  registerArtifactLinkProvider,
} from "../../src/components/terminal/terminalLinkProvider";

const mockedResolveLocalPathLinks = vi.mocked(resolveLocalPathLinks);
let nextSessionId = 0;

function createLinkProviderHarness(text: string) {
  let provider: Parameters<Terminal["registerLinkProvider"]>[0] | undefined;
  const line = {
    isWrapped: false,
    length: text.length,
    translateToString: (trimRight?: boolean) => (trimRight ? text.trimEnd() : text),
    getCell: (index: number) => ({
      getWidth: () => 1,
      getChars: () => text[index] ?? "",
    }),
  };
  const term = {
    buffer: {
      active: {
        length: 1,
        viewportY: 0,
        baseY: 0,
        getLine: (index: number) => (index === 0 ? line : undefined),
      },
    },
    registerLinkProvider: (registered: Parameters<Terminal["registerLinkProvider"]>[0]) => {
      provider = registered;
      return { dispose: vi.fn() };
    },
  } as unknown as Terminal;
  const onActivate = vi.fn();
  registerArtifactLinkProvider(term, `terminal-link-test-${nextSessionId++}`, onActivate);

  return {
    onActivate,
    provideLinks: () =>
      new Promise<ILink[] | undefined>((resolve) => {
        provider!.provideLinks(1, resolve);
      }),
  };
}

describe("terminal local file path links", () => {
  beforeEach(() => {
    mockedResolveLocalPathLinks.mockReset();
  });

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
    const directory =
      "C:\\Users\\miyaz\\サンプル株式会社 Dropbox\\サンプル出版\\数学\\2026年\\11月号\\3_一次原稿\\";
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
    expect(findLocalFilePathLinks(String.raw`path=C:\tmp\note.txt。`)[0].text).toBe(
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

  it("extracts bare extension-less candidates with original spans", () => {
    const text = String.raw`open C:\Users\miyaz\3_一次原稿 を参照`;
    const candidates = findBareLocalPathCandidates(text);

    expect(candidates).toEqual([
      {
        text: String.raw`C:\Users\miyaz\3_一次原稿 を参照`,
        index: text.indexOf(String.raw`C:\Users`),
        endIndex: text.length,
      },
    ]);
  });

  it("dedupes bare candidates that overlap existing file and directory matches", () => {
    const text = String.raw`open C:\tmp\report.final.txt and C:\tmp\folder\ and C:\tmp\extensionless`;
    const candidates = findBareLocalPathCandidates(text);

    expect(candidates.map((candidate) => candidate.text)).toEqual([
      String.raw`C:\tmp\extensionless`,
    ]);
  });

  it("stops bare candidates at hard terminal delimiters", () => {
    const text = String.raw`open "C:\tmp\my folder" and <file:///C:/tmp/3_一次原稿> and /c/tmp/noext+suffix`;
    const candidates = findBareLocalPathCandidates(text);

    expect(candidates.map((candidate) => candidate.text)).toEqual([
      String.raw`C:\tmp\my folder`,
      "file:///C:/tmp/3_一次原稿",
      "/c/tmp/noext",
    ]);
  });

  it("shrinks a prose-swallowing regex match to the resolver's existing prefix", async () => {
    const existingPrefix = String.raw`C:\Users\miyaz`;
    const text = `${existingPrefix} \u306e\u30d5\u30a1\u30a4\u30eb abc.md \u3092\u78ba\u8a8d`;
    mockedResolveLocalPathLinks.mockImplementation(async (candidates) =>
      candidates.map((candidate) =>
        candidate.startsWith(existingPrefix) ? { existingPrefix, isDir: true } : null,
      ),
    );

    const harness = createLinkProviderHarness(text);
    const links = await harness.provideLinks();

    expect(mockedResolveLocalPathLinks).toHaveBeenCalledTimes(1);
    expect(mockedResolveLocalPathLinks.mock.calls[0][0]).toHaveLength(2);
    expect(links?.map((link) => link.text)).toEqual([existingPrefix]);
  });

  it("emits an overlapping regex and bare candidate exactly once after resolution", () => {
    const existingPrefix = String.raw`C:\Users\miyaz`;
    const text = `${existingPrefix} \u306e\u30d5\u30a1\u30a4\u30eb abc.md \u3092\u78ba\u8a8d`;
    const regexMatches = findLocalFilePathLinks(text);
    const bareCandidates = findBareLocalPathCandidates(text, []);
    const candidates = [...regexMatches, ...bareCandidates];

    expect(regexMatches).toHaveLength(1);
    expect(bareCandidates).toHaveLength(1);
    expect(
      mergeResolvedPathLinkMatches(
        candidates,
        candidates.map(() => ({ existingPrefix, isDir: true })),
      ),
    ).toEqual([
      {
        text: existingPrefix,
        index: 0,
        endIndex: existingPrefix.length,
        activationUri: `${existingPrefix}\\`,
      },
    ]);
  });

  it("does not emit a link when no candidate exists on disk", async () => {
    const text = String.raw`C:\mycmux-missing\report.md`;
    mockedResolveLocalPathLinks.mockImplementation(async (candidates) => candidates.map(() => null));

    const links = await createLinkProviderHarness(text).provideLinks();

    expect(mockedResolveLocalPathLinks).toHaveBeenCalledTimes(1);
    expect(links).toBeUndefined();
  });

  it("falls back to unverified regex links when path resolution fails", async () => {
    const text = String.raw`C:\mycmux-missing\report.md`;
    mockedResolveLocalPathLinks.mockRejectedValueOnce(new Error("resolver unavailable"));

    const links = await createLinkProviderHarness(text).provideLinks();

    expect(links?.map((link) => link.text)).toEqual([text]);
  });

  it("keeps the longer resolved overlap and uses earlier start as the tie-breaker", () => {
    const longer = mergeResolvedPathLinkMatches(
      [
        { text: String.raw`C:\Users suffix`, index: 0, endIndex: 15 },
        { text: String.raw`C:\Users\miyaz suffix`, index: 0, endIndex: 21 },
      ],
      [
        { existingPrefix: String.raw`C:\Users`, isDir: true },
        { existingPrefix: String.raw`C:\Users\miyaz`, isDir: true },
      ],
    );
    expect(longer.map((match) => match.text)).toEqual([String.raw`C:\Users\miyaz`]);

    const earlier = mergeResolvedPathLinkMatches(
      [
        { text: String.raw`C:\same suffix`, index: 5, endIndex: 19 },
        { text: String.raw`C:\same suffix`, index: 3, endIndex: 17 },
      ],
      [
        { existingPrefix: String.raw`C:\same`, isDir: false },
        { existingPrefix: String.raw`C:\same`, isDir: false },
      ],
    );
    expect(earlier).toHaveLength(1);
    expect(earlier[0].index).toBe(3);
  });
});
