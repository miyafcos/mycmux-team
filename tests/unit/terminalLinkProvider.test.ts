import type { ILink, Terminal } from "@xterm/xterm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { homeDir } from "@tauri-apps/api/path";
import { resolveLocalPathLinks } from "../../src/lib/ipc";

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
  findBareLocalPathCandidates,
  findLocalFilePathLinks,
  isArtifactPreviewUri,
  isDirectoryLikeUri,
  mergeResolvedPathLinkMatches,
  registerArtifactLinkProvider,
} from "../../src/components/terminal/terminalLinkProvider";

const mockedResolveLocalPathLinks = vi.mocked(resolveLocalPathLinks);
const mockedHomeDir = vi.mocked(homeDir);
let nextSessionId = 0;

type HarnessLine = {
  text: string;
  isWrapped?: boolean;
  columns?: number;
};

function createLinkProviderHarness(
  input: string | HarnessLine[],
  getCwd?: () => string | undefined,
  sessionId = `terminal-link-test-${nextSessionId++}`,
) {
  let provider: Parameters<Terminal["registerLinkProvider"]>[0] | undefined;
  const sourceLines = typeof input === "string" ? [{ text: input }] : input;
  const lines = sourceLines.map(({ text, isWrapped = false, columns = text.length }) => {
    const rawText = text.padEnd(columns);
    return {
      isWrapped,
      length: columns,
      translateToString: (trimRight?: boolean) => (trimRight ? rawText.trimEnd() : rawText),
      getCell: (index: number) => ({
        getWidth: () => 1,
        getChars: () => rawText[index] ?? "",
      }),
    };
  });
  const term = {
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
  };
}

describe("terminal local file path links", () => {
  beforeEach(() => {
    mockedResolveLocalPathLinks.mockReset();
    mockedHomeDir.mockReset();
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

  it("evicts callback-bearing links when a provider is disposed", async () => {
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

    expect(mockedResolveLocalPathLinks).toHaveBeenCalledTimes(2);
    expect(first.onActivate).not.toHaveBeenCalled();
    expect(second.onActivate).toHaveBeenCalledWith(text, expect.anything());
  });

  it("does not let an in-flight disposed provider repopulate the link cache", async () => {
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
    await second.provideLinks();
    resolveFirst?.([{ existingPrefix: text, isDir: false }]);
    await Promise.resolve();
    await Promise.resolve();
    const cachedLinks = await second.provideLinks();
    cachedLinks?.[0].activate({} as MouseEvent, text);

    expect(mockedResolveLocalPathLinks).toHaveBeenCalledTimes(2);
    expect(first.onActivate).not.toHaveBeenCalled();
    expect(second.onActivate).toHaveBeenCalledWith(text, expect.anything());
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
});
