import { describe, expect, it } from "vitest";
import { AGENT_CATALOG } from "../../src/lib/agentCatalog";
import {
  dirItems,
  launchItems,
  middleEllipsis,
  previewLine,
  searchItems,
  tailPath,
  splitDirLabel,
} from "../../src/components/workspace/launcherModel";
import { launcherStrings as S } from "../../src/components/workspace/launcherStrings";

describe("launcher launch rows", () => {
  it("carries every catalog row, both claude-codex backends included", () => {
    const items = launchItems();
    expect(items).toHaveLength(AGENT_CATALOG.length);
    const targets = items.map((item) => item.target);
    // The first draft dropped one of these; the launcher must offer both.
    expect(targets).toContain("claude-codex");
    expect(targets).toContain("claude-codex-open");
  });

  it("gives every row a mark to draw", () => {
    for (const item of launchItems()) {
      expect(item.iconKind, `${item.target} has no icon kind`).not.toBe("");
    }
  });

  it("does not lend Antigravity's own mark to the web Gemini row", () => {
    const items = launchItems();
    expect(items.find((i) => i.target === "web-gemini")?.iconKind).toBe("gemini");
    expect(items.find((i) => i.target === "agy")?.iconKind).toBe("antigravity");
    expect(items.find((i) => i.target === "web-notebooklm")?.iconKind).toBe("notebooklm");
  });

  // S10: the canonical name stays the search target, the chip shows less.
  it("shortens the names a 240px column cannot hold", () => {
    const byTarget = Object.fromEntries(launchItems().map((i) => [i.target, i]));
    expect(byTarget["claude-codex"].label).toBe("claude-codex (Codex Models)");
    expect(byTarget["claude-codex"].short).toBe("claude-codex");
    expect(byTarget["claude-codex-open"].short).toBe("cc (Open)");
    expect(byTarget.agy.short).toBe("agy");
    expect(byTarget.grok.short).toBe("Grok");
    expect(byTarget["web-chatgpt"].short).toBe("ChatGPT");
    expect(byTarget["web-notebooklm"].short).toBe("NotebookLM");
  });
});

describe("launcher search", () => {
  const launch = launchItems();

  // U2: the same Fuse options CrsmPalette uses, so one query does not give two
  // different answers depending on which surface it was typed into.
  it("finds the Open Models row by its chip label and by its canonical name", () => {
    expect(searchItems(launch, "cc").map((i) => i.target)).toContain("claude-codex-open");
    expect(searchItems(launch, "open").map((i) => i.target)).toContain("claude-codex-open");
    expect(searchItems(launch, "Open Models").map((i) => i.target)).toContain("claude-codex-open");
  });

  it("returns everything when the query is blank", () => {
    expect(searchItems(launch, "")).toHaveLength(launch.length);
    expect(searchItems(launch, "   ")).toHaveLength(launch.length);
  });

  it("narrows to nothing rather than guessing", () => {
    expect(searchItems(launch, "zzzzzzzz")).toHaveLength(0);
  });

  const { dev, anken } = dirItems({
    dev: [
      { label: "mycmux (master)", path: "C:/Users/miyaz/cmux-for-linux-dev-master" },
      { label: "ime-dev (自作IME)", path: "C:/Users/miyaz/ime-dev" },
    ],
    anken: [
      { label: "駿台/モモスタ/数学 (●09/03)", path: "C:/Users/miyaz/anken/math" },
      { label: "東洋食品工業短期大学/2027年度入試 (●09/03)", path: "C:/Users/miyaz/anken/toyo" },
    ],
    mru: [],
  });
  const dirs = [...dev, ...anken];

  it("finds a japanese label by a japanese substring", () => {
    expect(searchItems(dirs, "モモ").map((i) => i.label)).toContain("駿台/モモスタ/数学");
    expect(searchItems(dirs, "東洋").map((i) => i.label)).toContain("東洋食品工業短期大学/2027年度入試");
  });

  it("finds a directory by its label and by its path", () => {
    expect(searchItems(dirs, "mycmux").map((i) => i.label)).toContain("mycmux (master)");
    expect(searchItems(dirs, "ime-dev").map((i) => i.path)).toContain("C:/Users/miyaz/ime-dev");
  });

  // Fuse matches fuzzily, not phonetically. Recorded so the limit is a decision
  // rather than a surprise: CrsmPalette cannot do this either, and matching it
  // is the whole point of sharing the options.
  it("does not transliterate romaji into kana", () => {
    expect(searchItems(dirs, "momo")).toHaveLength(0);
  });
});

describe("directory rows", () => {
  it("splits the freshness mark off so it can right-align", () => {
    expect(splitDirLabel("駿台/モモスタ/数学 (●09/03)")).toEqual({
      label: "駿台/モモスタ/数学",
      mark: "●09/03",
    });
  });

  it("leaves a label that carries no mark alone", () => {
    expect(splitDirLabel("mycmux (master)")).toEqual({ label: "mycmux (master)" });
    expect(splitDirLabel("HTML Hub (旧html-editor拡張)")).toEqual({
      label: "HTML Hub (旧html-editor拡張)",
    });
  });

  it("survives an absent roots file", () => {
    expect(dirItems(null)).toEqual({ dev: [], anken: [] });
  });
});

describe("middleEllipsis", () => {
  // S6: the tail is the identifier, so it is the head that gets cut.
  it("keeps both ends of a path-like label", () => {
    const out = middleEllipsis("駿台/モモスタ/00_資料", 12);
    expect(out).toHaveLength(12);
    expect(out.startsWith("駿台")).toBe(true);
    expect(out.endsWith("資料")).toBe(true);
    expect(out).toContain("…");
  });

  it("leaves a label that already fits untouched", () => {
    expect(middleEllipsis("mycmux", 26)).toBe("mycmux");
  });
});

describe("relativeWhen", () => {
  // Fixed "now" so the boundaries are exact rather than whatever the clock says.
  const now = Date.parse("2026-09-04T12:00:00Z");
  const at = (iso: string) => S.relativeWhen(iso, now);

  it("counts minutes, then hours, then days", () => {
    expect(at("2026-09-04T11:59:30Z")).toBe("たった今");
    expect(at("2026-09-04T11:58:00Z")).toBe("2分前");
    expect(at("2026-09-04T11:01:00Z")).toBe("59分前");
    expect(at("2026-09-04T11:00:00Z")).toBe("1時間前");
    expect(at("2026-09-03T13:00:00Z")).toBe("23時間前");
    expect(at("2026-09-03T12:00:00Z")).toBe("昨日");
    expect(at("2026-09-01T12:00:00Z")).toBe("3日前");
    expect(at("2026-08-28T12:00:00Z")).toBe("1週間前");
  });

  it("returns nothing for a timestamp it cannot read", () => {
    // CRSM should always send ISO, but an empty right-hand column beats NaN.
    expect(at("")).toBe("");
    expect(at("not a date")).toBe("");
  });
});

describe("tailPath", () => {
  it("names a session by the folder, not the whole Dropbox path", () => {
    expect(tailPath("C:/Users/miyaz/エデュ・プラニング合同会社 Dropbox/事務関係/駿台/モモスタ/数学"))
      .toBe("モモスタ/数学");
  });

  it("handles windows separators and a trailing slash", () => {
    expect(tailPath(String.raw`C:\Users\miyaz\cmux-for-linux-dev-master` + "\\"))
      .toBe("miyaz/cmux-for-linux-dev-master");
  });

  it("returns what it has when the path is shorter than asked for", () => {
    expect(tailPath("C:/")).toBe("C:");
    expect(tailPath("")).toBe("");
  });
});

describe("previewLine", () => {
  it("drops the speaker prefix", () => {
    expect(previewLine("user: 君は WK レーンの後継。")).toBe("君は WK レーンの後継。");
    expect(previewLine("assistant: 調べました")).toBe("調べました");
  });

  it("strips the harness tags a slash command leaves in the transcript", () => {
    expect(previewLine("user: <local-command-caveat>Caveat: ...</local-command-caveat> 本題"))
      .toBe("Caveat: ... 本題");
  });

  it("collapses whitespace and caps the length", () => {
    expect(previewLine("a\n\n  b\tc")).toBe("a b c");
    expect(previewLine("x".repeat(300)).length).toBe(120);
    expect(previewLine("x".repeat(300), 40).length).toBe(40);
  });
});
