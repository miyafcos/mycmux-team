import type { ILink, Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { homeDir } from "@tauri-apps/api/path";
import { resolveLocalPathLinks } from "../../src/lib/ipc";
import { getTerminalWriteCounter } from "../../src/components/terminal/terminalCache";

vi.mock("@tauri-apps/api/path", () => ({
  homeDir: vi.fn(),
}));

vi.mock("../../src/lib/ipc", () => ({
  resolveLocalPathLinks: vi.fn(),
}));

vi.mock("../../src/components/terminal/terminalCache", () => ({
  getTerminalWriteCounter: vi.fn(() => 0),
  registerTerminalCacheEvictionCleanup: vi.fn(),
}));

import {
  clearLocalPathResolutionCache,
  findBareLocalPathCandidates,
  findLocalFilePathLinks,
  isArtifactPreviewUri,
  isDirectoryLikeUri,
  mergeResolvedPathLinkMatches,
  registerArtifactLinkProvider,
  resolveTextLocalPathLinks,
} from "../../src/components/terminal/terminalLinkProvider";

const mockedResolveLocalPathLinks = vi.mocked(resolveLocalPathLinks);
const mockedHomeDir = vi.mocked(homeDir);
const mockedGetTerminalWriteCounter = vi.mocked(getTerminalWriteCounter);
let nextSessionId = 0;

type HarnessLine = {
  text: string;
  isWrapped?: boolean;
  columns?: number;
};

type HarnessCell = { chars: string; width: number };

/// Display width, matching how xterm lays wide glyphs across two cells.
function harnessCharWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  const isWide = (code >= 0x1100 && code <= 0x115f)
    || code === 0x2329
    || code === 0x232a
    || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6);
  return isWide ? 2 : 1;
}

/// Build the cell row xterm would hold for `text`: wide glyphs occupy a cell
/// plus a zero-width spacer, and every column past the written text stays
/// unwritten (`NULL_CELL_CHAR`), which is what distinguishes a row the TUI
/// ended early from one that filled the terminal.
function buildHarnessCells(text: string, columns?: number): { cells: HarnessCell[]; columns: number } {
  const cells: HarnessCell[] = [];
  for (const char of text) {
    const width = harnessCharWidth(char);
    cells.push({ chars: char, width });
    if (width === 2) {
      cells.push({ chars: "", width: 0 });
    }
  }
  const totalColumns = Math.max(columns ?? cells.length, cells.length);
  while (cells.length < totalColumns) {
    cells.push({ chars: "", width: 1 });
  }
  return { cells, columns: totalColumns };
}

function createLinkProviderHarness(
  input: string | HarnessLine[],
  getCwd?: () => string | undefined,
  sessionId = `terminal-link-test-${nextSessionId++}`,
) {
  let provider: Parameters<Terminal["registerLinkProvider"]>[0] | undefined;
  let renderListener: Parameters<Terminal["onRender"]>[0] | undefined;
  const sourceLines = typeof input === "string" ? [{ text: input }] : input;
  const lines = sourceLines.map(({ text, isWrapped = false, columns }) => {
    const { cells, columns: totalColumns } = buildHarnessCells(text, columns);
    // xterm renders unwritten cells as spaces when asked for the untrimmed row.
    const rawText = cells.map((cell) => (cell.width === 0 ? "" : cell.chars || " ")).join("");
    return {
      isWrapped,
      length: totalColumns,
      translateToString: (trimRight?: boolean) => (trimRight ? rawText.trimEnd() : rawText),
      getCell: (index: number) => {
        const cell = cells[index];
        if (!cell) return undefined;
        return { getWidth: () => cell.width, getChars: () => cell.chars };
      },
    };
  });
  const term = {
    rows: lines.length,
    buffer: {
      active: {
        length: lines.length,
        viewportY: 0,
        baseY: 0,
        getLine: (index: number) => lines[index],
      },
    },
    registerLinkProvider: (registered: Parameters<Terminal["registerLinkProvider"]>[0]) => {
      provider = registered;
      return { dispose: vi.fn() };
    },
    onRender: (listener: Parameters<Terminal["onRender"]>[0]) => {
      renderListener = listener;
      return { dispose: vi.fn() };
    },
  } as unknown as Terminal;
  const onActivate = vi.fn();
  const registration = registerArtifactLinkProvider(term, sessionId, onActivate, getCwd);

  return {
    dispose: registration.dispose,
    onActivate,
    provideLinks: (bufferLineNumber = 1) =>
      new Promise<ILink[] | undefined>((resolve) => {
        provider!.provideLinks(bufferLineNumber, resolve);
      }),
    requestLinks: (callback: (links: ILink[] | undefined) => void, bufferLineNumber = 1) => {
      provider!.provideLinks(bufferLineNumber, callback);
    },
    render: () => renderListener?.({ start: 0, end: Math.max(0, lines.length - 1) }),
  };
}

describe("terminal local file path links", () => {
  beforeEach(() => {
    mockedResolveLocalPathLinks.mockReset();
    mockedHomeDir.mockReset();
    mockedGetTerminalWriteCounter.mockReset();
    mockedGetTerminalWriteCounter.mockReturnValue(0);
    clearLocalPathResolutionCache();
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it("matches a backtick-wrapped drive file", () => {
    const driveFile = "C:\\tmp\\report.md";
    expect(findLocalFilePathLinks(`open \`${driveFile}\``)[0].text).toBe(driveFile);
  });

  it("matches a backtick-wrapped drive directory", () => {
    const driveDirectory = "C:\\tmp\\reports\\";
    expect(findLocalFilePathLinks(`open \`${driveDirectory}\``)[0].text).toBe(driveDirectory);
  });

  it("matches a backtick-wrapped extension-less MSYS path", () => {
    const msysDirectory = "/c/tmp/reports";
    expect(findBareLocalPathCandidates(`open \`${msysDirectory}\``)[0].text).toBe(msysDirectory);
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

  it("resolves Japanese Dropbox paths through the provider cache for dashboard text", async () => {
    const path = "C:\\Users\\miyaz\\エデュ・プラニング合同会社 Dropbox\\算数\\下書き_260814.md";
    mockedResolveLocalPathLinks.mockImplementation(async (candidates) => candidates.map((candidate) =>
      candidate === path ? { existingPrefix: path, isDir: false } : null,
    ));

    const first = await resolveTextLocalPathLinks(`確認: ${path}`);
    const second = await resolveTextLocalPathLinks(`再確認: ${path}`);

    expect(first).toEqual([expect.objectContaining({ text: path, activationUri: path })]);
    expect(second).toEqual([expect.objectContaining({ text: path, activationUri: path })]);
    expect(mockedResolveLocalPathLinks).toHaveBeenCalledTimes(1);
  });

  it("keeps resolved directory and file activation branches distinct", async () => {
    const directory = "C:\\Users\\miyaz\\Dropbox\\成果物\\";
    const file = "C:\\Users\\miyaz\\Dropbox\\成果物\\report.pdf";
    mockedResolveLocalPathLinks.mockImplementation(async (candidates) => candidates.map((candidate) => {
      if (candidate.startsWith(file)) return { existingPrefix: file, isDir: false };
      if (candidate.startsWith(directory)) return { existingPrefix: directory, isDir: true };
      return null;
    }));

    const directoryLinks = await resolveTextLocalPathLinks(directory);
    const fileLinks = await resolveTextLocalPathLinks(file);

    expect(directoryLinks).toEqual([expect.objectContaining({ text: directory, activationUri: directory })]);
    expect(fileLinks).toEqual([expect.objectContaining({ text: file, activationUri: file })]);
    expect(isDirectoryLikeUri(directoryLinks[0].activationUri)).toBe(true);
    expect(isDirectoryLikeUri(fileLinks[0].activationUri)).toBe(false);
  });

  it("does not link paths that the shared resolver cannot find", async () => {
    mockedResolveLocalPathLinks.mockImplementation(async (candidates) => candidates.map(() => null));

    await expect(resolveTextLocalPathLinks("C:\\missing\\not-real.pdf")).resolves.toEqual([]);
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

  it("keeps a spaced absolute folder path intact instead of cutting at the space", () => {
    // "…合同会社 Dropbox\…" — the component after the space looks like a fresh
    // relative candidate, but it belongs to the absolute path that precedes it.
    const folder =
      "C:\\Users\\miyaz\\サンプル株式会社 Dropbox\\サンプル出版　編集部\\事務関係\\03_接続ドリル";
    const candidates = findBareLocalPathCandidates(`  ${folder}`);

    expect(candidates.map((candidate) => candidate.text)).toEqual([folder]);
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
    expect(bareCandidates.some((candidate) => candidate.index === 0)).toBe(true);
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

  it("joins a path across two hard-wrapped lines with a multi-line range", async () => {
    const first = String.raw`open C:\work\very-`;
    const second = String.raw`long\report.md`;
    const existingPrefix = String.raw`C:\work\very-long\report.md`;
    mockedResolveLocalPathLinks.mockImplementation(async (candidates) =>
      candidates.map((candidate) => candidate.startsWith(existingPrefix)
        ? { existingPrefix, isDir: false }
        : null),
    );

    const harness = createLinkProviderHarness([{ text: first }, { text: second }]);
    const links = await harness.provideLinks(2);

    expect(links?.map((link) => link.text)).toEqual([existingPrefix]);
    expect(links?.[0].range).toEqual({
      start: { x: first.indexOf("C:") + 1, y: 1 },
      end: { x: second.length, y: 2 },
    });
  });

  it("joins three hard lines and strips common TUI continuation prefixes", async () => {
    const first = String.raw`C:\work\very-`;
    const second = "  \u23BFlong\\nested\\";
    const third = "  \u2502report.md";
    const existingPrefix = String.raw`C:\work\very-long\nested\report.md`;
    mockedResolveLocalPathLinks.mockImplementation(async (candidates) =>
      candidates.map((candidate) => candidate.startsWith(existingPrefix)
        ? { existingPrefix, isDir: false }
        : null),
    );

    const harness = createLinkProviderHarness([
      { text: first },
      { text: second },
      { text: third },
    ]);
    const links = await harness.provideLinks(3);

    expect(mockedResolveLocalPathLinks.mock.calls[0][0]).toContain(existingPrefix);
    expect(links?.[0].range).toEqual({
      start: { x: 1, y: 1 },
      end: { x: third.length, y: 3 },
    });
  });

  it("keeps existing soft-wrap joining behavior", async () => {
    const first = String.raw`C:\work\very-`;
    const second = String.raw`long\report.md`;
    const existingPrefix = String.raw`C:\work\very-long\report.md`;
    mockedResolveLocalPathLinks.mockImplementation(async (candidates) =>
      candidates.map((candidate) => candidate.startsWith(existingPrefix)
        ? { existingPrefix, isDir: false }
        : null),
    );

    const links = await createLinkProviderHarness([
      { text: first },
      { text: second, isWrapped: true },
    ]).provideLinks(2);

    expect(links?.map((link) => link.text)).toEqual([existingPrefix]);
  });

  it("joins a path an agent TUI wrapped inside its right margin", async () => {
    // Verbatim from Claude Code at 80 columns: the row stops at 74 cells because
    // the TUI reserves a right margin, then indents the continuation by two.
    // The old edge-wrap test required the leftover (6) to be narrower than the
    // continuation's leading glyph (2), so this path never linked.
    const first = String.raw`● FB整理が完了しました。レポート: C:\Users\miyaz\reports\_quick\2026-07\こ`;
    const second = "  れヤバ接続ドリル_先方FB整理_726_0726-1326.html";
    const existingPrefix =
      String.raw`C:\Users\miyaz\reports\_quick\2026-07\これヤバ接続ドリル_先方FB整理_726_0726-1326.html`;
    mockedResolveLocalPathLinks.mockImplementation(async (candidates) =>
      candidates.map((candidate) => candidate.startsWith(existingPrefix)
        ? { existingPrefix, isDir: false }
        : null),
    );

    const links = await createLinkProviderHarness([
      { text: first, columns: 80 },
      { text: second, columns: 80 },
    ]).provideLinks(2);

    expect(links?.map((link) => link.text)).toEqual([existingPrefix]);
  });

  it("preserves a path space at a hard-wrap boundary", async () => {
    const existingPrefix = String.raw`C:\Users\miyaz\Sample Company Dropbox\reports\wrapped.md`;
    const first = "\u25CF `C:\\Users\\miyaz\\Sample Company ";
    const second = "  \u23BF Dropbox\\reports\\wrapped.md`";
    const columns = Math.max(displayColumns(first), displayColumns(second));
    mockedResolveLocalPathLinks.mockImplementation(async (candidates) =>
      candidates.map((candidate) => candidate === existingPrefix
        ? { existingPrefix, isDir: false }
        : null),
    );

    const links = await createLinkProviderHarness([
      { text: first, columns },
      { text: second, columns },
    ]).provideLinks(2);

    expect(mockedResolveLocalPathLinks.mock.calls[0][0]).toContain(existingPrefix);
    expect(links?.map((link) => link.text)).toEqual([existingPrefix]);
  });

  it("recovers a path space omitted by a TUI at a hard-wrap boundary", async () => {
    const first = "C:\\Users\\miyaz\\\u30a8\u30c7\u30e5\u30fb\u30d7\u30e9\u30cb\u30f3\u30b0\u5408\u540c\u4f1a\u793e";
    const second = "Dropbox\\\u30a8\u30c7\u30e5\u30fb\u30d7\u30e9\u30cb\u30f3\u30b0\u9593\u5c4b\u53e3\u3000\u4ea8\\\u4e8b\u52d9\u95a2\u4fc2\\\u99ff\u53f0\\\u30e2\u30e2\u30b9\u30bf\\\u6570\u5b66\\19_";
    const third = "\u30b9\u30e9\u30a4\u30c9\u5236\u4f5c\u524d\u6e96\u5099_260804\\13_\u6388\u696dIR\u8ee2\u63db_260804\\06_\u4f8b\u984c\u30d1\u30a4\u30ed\u30c3\u30c8_247";
    const fourth = "-2\\12_\u30ec\u30d3\u30e5\u30fc\u63d0\u793a_247-2_v1.11_260805.html";
    const joinedWithoutSpace = `${first}${second}${third}${fourth}`;
    const existingPrefix = `${first} ${second}${third}${fourth}`;
    mockedResolveLocalPathLinks.mockImplementation(async (candidates) =>
      candidates.map((candidate) => candidate === existingPrefix
        ? { existingPrefix, isDir: false }
        : null),
    );
    const harness = createLinkProviderHarness([
      { text: first, columns: 70 },
      { text: second, columns: 70 },
      { text: third, columns: 70 },
      { text: fourth, columns: 70 },
    ]);

    const links = await harness.provideLinks(4);

    expect(mockedResolveLocalPathLinks.mock.calls[0][0]).toContain(joinedWithoutSpace);
    expect(mockedResolveLocalPathLinks.mock.calls[0][0]).toContain(existingPrefix);
    expect(links?.map((link) => link.text)).toEqual([joinedWithoutSpace]);
    expect(links?.[0].range).toEqual({
      start: { x: 1, y: 1 },
      end: { x: displayColumns(fourth), y: 4 },
    });
    links?.[0].activate({} as MouseEvent, joinedWithoutSpace);
    expect(harness.onActivate).toHaveBeenCalledWith(existingPrefix, expect.anything());
  });

  it("prefers the direct join when word-split variants also resolve", async () => {
    const first = String.raw`C:\work\very-`;
    const second = "long\\nested\\";
    const third = "report-";
    const fourth = "final.md";
    const existingPrefix = `${first}${second}${third}${fourth}`;
    mockedResolveLocalPathLinks.mockImplementation(async (candidates) =>
      candidates.map((candidate) => ({ existingPrefix: candidate, isDir: false })),
    );
    const harness = createLinkProviderHarness([
      { text: first },
      { text: second },
      { text: third },
      { text: fourth },
    ]);

    const links = await harness.provideLinks(4);

    expect(links?.map((link) => link.text)).toEqual([existingPrefix]);
    links?.[0].activate({} as MouseEvent, existingPrefix);
    expect(harness.onActivate).toHaveBeenCalledWith(existingPrefix, expect.anything());
  });

  it("keeps a backticked Unicode path clickable from either wrapped row", async () => {
    const head = "C:\\Users\\miyaz\\reports\\_quick\\2026-08\\mycmux_0.21.6\u21920.21.10_";
    const tail = "\u66F4\u65B0\u307E\u3068\u3081_0804-1836.html";
    const existingPrefix = `${head}${tail}`;
    const first = `\u25CF \`${head}`;
    const second = `  ${tail}\``;
    mockedResolveLocalPathLinks.mockImplementation(async (candidates) =>
      candidates.map((candidate) => candidate === existingPrefix
        ? { existingPrefix, isDir: false }
        : null),
    );

    const harness = createLinkProviderHarness([
      { text: first, columns: 80 },
      { text: second, columns: 80 },
    ]);
    const firstRowLinks = await harness.provideLinks(1);
    const secondRowLinks = await harness.provideLinks(2);

    expect(firstRowLinks?.map((link) => link.text)).toEqual([existingPrefix]);
    expect(secondRowLinks?.map((link) => link.text)).toEqual([existingPrefix]);
    expect(secondRowLinks?.[0].range).toEqual(firstRowLinks?.[0].range);
    secondRowLinks?.[0].activate({} as MouseEvent, existingPrefix);
    expect(harness.onActivate).toHaveBeenCalledWith(existingPrefix, expect.anything());
  });

  it("does not join a short line that ended on purpose", async () => {
    // Same 80-column row, but the path line used only a quarter of it. Nothing
    // wrapped here, so the following sentence must stay a separate line.
    const workDir = "C:\\work\\";
    mockedResolveLocalPathLinks.mockImplementation(async (candidates) =>
      candidates.map((candidate) => candidate === workDir
        ? { existingPrefix: workDir, isDir: true }
        : null),
    );

    const links = await createLinkProviderHarness([
      { text: `保存先: ${workDir}`, columns: 80 },
      { text: "  次の作業に進みます", columns: 80 },
    ]).provideLinks(2);

    expect(links?.map((link) => link.text) ?? []).not.toContain(
      `${workDir}次の作業に進みます`,
    );
  });

  it("does not link a hard-line continuation when disk resolution rejects it", async () => {
    mockedResolveLocalPathLinks.mockImplementation(async (candidates) => candidates.map(() => null));

    const links = await createLinkProviderHarness([
      { text: String.raw`C:\missing\partial-` },
      { text: "  unrelated output" },
    ]).provideLinks(2);

    expect(links).toBeUndefined();
  });

  it("does not fall back to an unverified multi-line link when resolution fails", async () => {
    mockedResolveLocalPathLinks.mockRejectedValueOnce(new Error("resolver unavailable"));

    const links = await createLinkProviderHarness([
      { text: String.raw`C:\work\very-` },
      { text: String.raw`long\report.md` },
    ]).provideLinks(2);

    expect(links).toBeUndefined();
  });

  it("limits hard continuation joins to four following lines", async () => {
    mockedResolveLocalPathLinks.mockImplementation(async (candidates) =>
      candidates.map((existingPrefix) => ({ existingPrefix, isDir: false })),
    );
    const lines = [
      { text: String.raw`C:\work\part-` },
      { text: "one-" },
      { text: "two-" },
      { text: "three-" },
      { text: "four-" },
      { text: "five.md" },
    ];

    await createLinkProviderHarness(lines).provideLinks(6);

    expect(mockedResolveLocalPathLinks.mock.calls[0][0]).not.toContain(
      String.raw`C:\work\part-one-two-three-four-five.md`,
    );
  });

  it("does not join a hard line when the previous text stops before the visual edge", async () => {
    const joinedPath = String.raw`C:\tmp\repo-notes.md`;
    mockedResolveLocalPathLinks.mockImplementation(async (candidates) =>
      candidates.map((candidate) => candidate === joinedPath
        ? { existingPrefix: joinedPath, isDir: false }
        : null),
    );

    const links = await createLinkProviderHarness([
      { text: String.raw`C:\tmp\repo-`, columns: 80 },
      { text: "notes.md", columns: 80 },
    ]).provideLinks(2);

    expect(mockedResolveLocalPathLinks.mock.calls[0][0]).not.toContain(joinedPath);
    expect(links).toBeUndefined();
  });

  // A long Japanese deliverable path is the case that broke in the field: the
  // TUI wraps it mid-component, and the row it leaves behind ends one cell
  // short because the next glyph is full-width.
  const JAPANESE_PATH =
    "C:\\Users\\miyaz\\サンプル株式会社 Dropbox\\サンプル出版　編集部\\事務関係\\03_接続ドリル\\11_修正依頼整理_小6_0725\\指示書_20260725.html";
  const JAPANESE_SPLIT = JAPANESE_PATH.indexOf("務関係");
  const JAPANESE_HEAD = `  ${JAPANESE_PATH.slice(0, JAPANESE_SPLIT)}`;
  const JAPANESE_TAIL = JAPANESE_PATH.slice(JAPANESE_SPLIT);

  function displayColumns(text: string): number {
    return buildHarnessCells(text).columns;
  }

  function mockJapanesePathOnDisk(): void {
    mockedResolveLocalPathLinks.mockImplementation(async (candidates) =>
      candidates.map((candidate) => candidate === JAPANESE_PATH
        ? { existingPrefix: JAPANESE_PATH, isDir: false }
        : null),
    );
  }

  it("joins a hard-wrapped path when a wide glyph did not fit in the last cell", async () => {
    mockJapanesePathOnDisk();

    const links = await createLinkProviderHarness([
      // One spare cell: too narrow for the full-width glyph that follows.
      { text: JAPANESE_HEAD, columns: displayColumns(JAPANESE_HEAD) + 1 },
      { text: `  ${JAPANESE_TAIL}`, columns: displayColumns(`  ${JAPANESE_TAIL}`) + 40 },
    ]).provideLinks(1);

    expect(links?.map((link) => link.text)).toEqual([JAPANESE_PATH]);
  });

  it("does not inject a space when a soft wrap leaves a wide glyph behind", async () => {
    mockJapanesePathOnDisk();

    const links = await createLinkProviderHarness([
      { text: JAPANESE_HEAD, columns: displayColumns(JAPANESE_HEAD) + 1 },
      { text: JAPANESE_TAIL, isWrapped: true, columns: displayColumns(JAPANESE_TAIL) + 40 },
    ]).provideLinks(1);

    expect(mockedResolveLocalPathLinks.mock.calls[0][0]).toContain(JAPANESE_PATH);
    expect(links?.map((link) => link.text)).toEqual([JAPANESE_PATH]);
  });

  it("joins regardless of how many leftover cells the previous row had", async () => {
    // Superseded contract. This used to assert the opposite: a row with room to
    // spare was treated as "ended on purpose" and never joined. Agent TUIs wrap
    // inside a reserved right margin, so their rows always have room to spare and
    // no threshold separates the two cases. Disk resolution decides instead --
    // see "does not link a hard-line continuation when disk resolution rejects it".
    mockJapanesePathOnDisk();

    const links = await createLinkProviderHarness([
      { text: JAPANESE_HEAD, columns: displayColumns(JAPANESE_HEAD) + 10 },
      { text: `  ${JAPANESE_TAIL}`, columns: displayColumns(`  ${JAPANESE_TAIL}`) + 40 },
    ]).provideLinks(1);

    expect(mockedResolveLocalPathLinks.mock.calls[0][0]).toContain(JAPANESE_PATH);
    expect(links?.map((link) => link.text)).toEqual([JAPANESE_PATH]);
  });

  it("rebuilds callback-bearing links for a replacement provider", async () => {
    // Superseded contract. Resolution results are now path-global, so IPC call
    // count no longer proves that a replacement provider owns fresh callbacks.
    const sessionId = "terminal-link-provider-rebind";
    const text = String.raw`C:\tmp\report.md`;
    mockedResolveLocalPathLinks.mockImplementation(async (candidates) =>
      candidates.map((existingPrefix) => ({ existingPrefix, isDir: false })),
    );
    const first = createLinkProviderHarness(text, undefined, sessionId);
    await first.provideLinks();
    first.dispose();

    const second = createLinkProviderHarness(text, undefined, sessionId);
    const links = await second.provideLinks();
    links?.[0].activate({} as MouseEvent, text);

    expect(first.onActivate).not.toHaveBeenCalled();
    expect(second.onActivate).toHaveBeenCalledWith(text, expect.anything());
  });

  it("does not let an in-flight disposed provider retain callback ownership", async () => {
    // Superseded contract. Replacement providers may share an in-flight path
    // resolution, but each must still construct links with its own onActivate.
    const sessionId = "terminal-link-provider-in-flight";
    const text = String.raw`C:\tmp\report.md`;
    let resolveFirst: ((value: Array<{ existingPrefix: string; isDir: boolean } | null>) => void) | undefined;
    mockedResolveLocalPathLinks
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirst = resolve;
      }))
      .mockImplementation(async (candidates) =>
        candidates.map((existingPrefix) => ({ existingPrefix, isDir: false })),
      );
    const first = createLinkProviderHarness(text, undefined, sessionId);
    void first.provideLinks();
    await Promise.resolve();
    await Promise.resolve();
    first.dispose();

    const second = createLinkProviderHarness(text, undefined, sessionId);
    const secondLinksPromise = second.provideLinks();
    resolveFirst?.([{ existingPrefix: text, isDir: false }]);
    const secondLinks = await secondLinksPromise;
    secondLinks?.[0].activate({} as MouseEvent, text);

    expect(first.onActivate).not.toHaveBeenCalled();
    expect(second.onActivate).toHaveBeenCalledWith(text, expect.anything());
  });

  it("returns links even when output changes while resolution is in flight", async () => {
    // Old behavior returned undefined whenever writeCounter changed before IPC
    // completed, permanently poisoning that xterm row for the current hover.
    const text = String.raw`C:\tmp\streaming-report.md`;
    let resolveLookup: ((value: Array<{ existingPrefix: string; isDir: boolean } | null>) => void)
      | undefined;
    mockedResolveLocalPathLinks.mockImplementationOnce(() => new Promise((resolve) => {
      resolveLookup = resolve;
    }));
    const harness = createLinkProviderHarness(text);
    const linksPromise = harness.provideLinks();
    await Promise.resolve();
    mockedGetTerminalWriteCounter.mockReturnValue(1);

    resolveLookup?.([{ existingPrefix: text, isDir: false }]);
    const links = await linksPromise;

    expect(links?.map((link) => link.text)).toEqual([text]);
  });

  it("returns the second hover synchronously from the resolution cache", async () => {
    const text = String.raw`C:\tmp\cached-report.md`;
    mockedResolveLocalPathLinks.mockImplementation(async (candidates) =>
      candidates.map((existingPrefix) => ({ existingPrefix, isDir: false })),
    );
    const harness = createLinkProviderHarness(text);
    await harness.provideLinks();
    const callback = vi.fn();

    harness.requestLinks(callback);

    expect(callback).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ text }),
    ]));
    expect(mockedResolveLocalPathLinks).toHaveBeenCalledTimes(1);
  });

  it("prewarms rendered paths so the first hover returns synchronously", async () => {
    vi.useFakeTimers();
    const text = String.raw`C:\tmp\prewarmed-report.md`;
    mockedResolveLocalPathLinks.mockImplementation(async (candidates) =>
      candidates.map((existingPrefix) => ({ existingPrefix, isDir: false })),
    );
    const harness = createLinkProviderHarness(text);

    harness.render();
    await vi.advanceTimersByTimeAsync(250);
    const callback = vi.fn();
    harness.requestLinks(callback);

    expect(callback).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ text }),
    ]));
    expect(mockedResolveLocalPathLinks).toHaveBeenCalledTimes(1);
  });

  it("does not repeat prewarm when the terminal buffer is unchanged", async () => {
    vi.useFakeTimers();
    const text = String.raw`C:\tmp\unchanged-miss.md`;
    mockedResolveLocalPathLinks.mockImplementation(async (candidates) =>
      candidates.map(() => null),
    );
    const harness = createLinkProviderHarness(text);

    harness.render();
    await vi.advanceTimersByTimeAsync(250);
    expect(mockedResolveLocalPathLinks).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3_001);
    harness.render();
    harness.render();
    await vi.advanceTimersByTimeAsync(250);

    expect(mockedResolveLocalPathLinks).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent resolution for the same lookup text", async () => {
    const text = String.raw`C:\tmp\shared-in-flight.md`;
    let resolveLookup: ((value: Array<{ existingPrefix: string; isDir: boolean } | null>) => void)
      | undefined;
    mockedResolveLocalPathLinks.mockImplementationOnce(() => new Promise((resolve) => {
      resolveLookup = resolve;
    }));
    const first = createLinkProviderHarness(text);
    const second = createLinkProviderHarness(text);

    const firstLinks = first.provideLinks();
    const secondLinks = second.provideLinks();
    expect(mockedResolveLocalPathLinks).toHaveBeenCalledTimes(1);
    resolveLookup?.([{ existingPrefix: text, isDir: false }]);

    expect((await firstLinks)?.[0].text).toBe(text);
    expect((await secondLinks)?.[0].text).toBe(text);
  });

  it("retries a cached miss after its three-second TTL", async () => {
    vi.useFakeTimers();
    const text = String.raw`C:\tmp\created-later.md`;
    mockedResolveLocalPathLinks.mockImplementation(async (candidates) => candidates.map(() => null));
    const harness = createLinkProviderHarness(text);

    await harness.provideLinks();
    await harness.provideLinks();
    expect(mockedResolveLocalPathLinks).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3_001);
    await harness.provideLinks();
    expect(mockedResolveLocalPathLinks).toHaveBeenCalledTimes(2);
  });

  it("resolves dot, parent, and bare relative paths against the pane cwd", async () => {
    const cwd = "C:\\repo";
    mockedResolveLocalPathLinks.mockImplementation(async (candidates) =>
      candidates.map((existingPrefix) => ({ existingPrefix, isDir: false })),
    );

    const harness = createLinkProviderHarness(
      "open ./file.md ../other.md src/index.ts",
      () => cwd,
    );
    const links = await harness.provideLinks();

    expect(mockedResolveLocalPathLinks).toHaveBeenCalledWith([
      "C:\\repo\\./file.md",
      "C:\\repo\\../other.md",
      "C:\\repo\\src/index.ts",
    ]);
    expect(links?.map((link) => link.text)).toEqual(["./file.md", "../other.md", "src/index.ts"]);
    links?.[0].activate({} as MouseEvent, "./file.md");
    expect(harness.onActivate).toHaveBeenCalledWith("C:\\repo\\./file.md", expect.anything());
  });

  it("detects Unicode, underscore, and dot-prefixed bare relative paths", async () => {
    const cwd = "C:\\repo";
    const unicodePath = "\u6559\u6750/\u539f\u7a3f.docx";
    mockedResolveLocalPathLinks.mockImplementation(async (candidates) =>
      candidates.map((existingPrefix) => ({ existingPrefix, isDir: false })),
    );

    const links = await createLinkProviderHarness(
      `open ${unicodePath} _config.yml .eslintrc.json`,
      () => cwd,
    ).provideLinks();

    expect(links?.map((link) => link.text)).toEqual([
      unicodePath,
      "_config.yml",
      ".eslintrc.json",
    ]);
  });

  it("resolves tilde paths against the user home directory", async () => {
    mockedHomeDir.mockResolvedValue("C:\\Users\\miyaz");
    mockedResolveLocalPathLinks.mockImplementation(async (candidates) =>
      candidates.map((existingPrefix) => ({ existingPrefix, isDir: false })),
    );

    const harness = createLinkProviderHarness("open ~/notes.md", () => "C:\\repo");
    const links = await harness.provideLinks();

    expect(mockedResolveLocalPathLinks).toHaveBeenCalledWith(["C:\\Users\\miyaz\\notes.md"]);
    expect(links?.map((link) => link.text)).toEqual(["~/notes.md"]);
    links?.[0].activate({} as MouseEvent, "~/notes.md");
    expect(harness.onActivate).toHaveBeenCalledWith("C:\\Users\\miyaz\\notes.md", expect.anything());
  });

  it("does not emit unverified relative links", async () => {
    mockedResolveLocalPathLinks.mockImplementation(async (candidates) => candidates.map(() => null));

    const links = await createLinkProviderHarness("open ./missing.md", () => "C:\\repo").provideLinks();

    expect(links).toBeUndefined();
  });

  it("includes cwd in the provider cache key", async () => {
    let cwd = "C:\\repo-one";
    mockedResolveLocalPathLinks.mockImplementation(async (candidates) =>
      candidates.map((existingPrefix) => ({ existingPrefix, isDir: false })),
    );
    const harness = createLinkProviderHarness("./file.md", () => cwd);

    await harness.provideLinks();
    cwd = "C:\\repo-two";
    await harness.provideLinks();

    expect(mockedResolveLocalPathLinks).toHaveBeenCalledTimes(2);
    expect(mockedResolveLocalPathLinks.mock.calls[1][0]).toEqual(["C:\\repo-two\\./file.md"]);
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

  it("prefers a direct resolution before the earlier-start tie-breaker", () => {
    const matches = mergeResolvedPathLinkMatches(
      [
        { text: String.raw`C:\same suffix`, index: 3, endIndex: 17 },
        { text: String.raw`C:\same suffix`, index: 5, endIndex: 19 },
      ],
      [
        { existingPrefix: String.raw`C:\same`, isDir: false },
        { existingPrefix: String.raw`C:\same`, isDir: false },
      ],
      [],
      [1, 0],
    );

    expect(matches).toHaveLength(1);
    expect(matches[0].index).toBe(5);
  });
});
