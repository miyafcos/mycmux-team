import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentKindIcon } from "../../src/components/icons/AgentIcons";
import { AGENT_CATALOG, getCatalogEntry } from "../../src/lib/agentCatalog";
import {
  cycleChoice,
  dirSections,
  dirCandidateCount,
  dirMark,
  launchItems,
  middleEllipsis,
  moveSpecRow,
  previewLine,
  searchItems,
  specRowsFor,
  tailPath,
  type SpecRow,
} from "../../src/components/workspace/launcherModel";
import { launcherStrings as S } from "../../src/components/workspace/launcherStrings";

import type { LauncherDirEntry, LauncherDirsView } from "../../src/lib/ipc";

function entry(id: string, section: string, label: string, path: string, extra: Partial<LauncherDirEntry> = {}): LauncherDirEntry {
  return { id, section, label, path, source: "manual", added_at: "2026-09-05T12:00:00+09:00", ...extra };
}

function view(entries: LauncherDirEntry[]): LauncherDirsView {
  return {
    doc: {
      version: 1, sections: [{ id: "dev", label: "Repos" }, { id: "anken", label: "Clients" }],
      entries, rules: [], ignored_paths: [], last_scan: null,
      export: { roots_txt_mtime_ms: null, roots_txt_written_at: null, last_external_merge_at: null },
    },
    entries_exist: entries.map((entry) => [entry.id, true]), json_path: "C:/profile/launch-dirs.json", roots_txt_path: "C:/profile/launch-roots.txt", home_path: "C:/Users/test", test_profile_active: true,
  };
}

describe("launcher spec keyboard navigation", () => {
  const claude = getCatalogEntry("claude")!;

  it("selects max by moving left from the default Claude effort", () => {
    expect(cycleChoice("", claude.efforts, -1)).toBe("max");
  });

  it("returns to the default after max", () => {
    expect(cycleChoice("max", claude.efforts, 1)).toBe("");
  });

  it("advances from xhigh to max", () => {
    expect(cycleChoice("xhigh", claude.efforts, 1)).toBe("max");
  });

  it("walks model choices in both directions through the default", () => {
    const choices = claude.models.map((choice) => choice.value);
    expect(cycleChoice("", choices, 1)).toBe("fable");
    expect(cycleChoice("fable", choices, -1)).toBe("");
    expect(cycleChoice("opus", choices, -1)).toBe("fable");
  });

  it("returns the default when choices are empty", () => {
    expect(cycleChoice("custom", [], 1)).toBe("");
    expect(cycleChoice("", [], -1)).toBe("");
  });

  it("treats an unknown value as the default when cycling", () => {
    expect(cycleChoice("custom", claude.efforts, 1)).toBe("low");
    expect(cycleChoice("custom", claude.efforts, -1)).toBe("max");
  });

  it("includes model, effort, and launch for Claude", () => {
    expect(specRowsFor(claude)).toEqual(["model", "effort", "launch"]);
  });

  it.each(["grok", "claude-codex-open"])("keeps the free-text model row for %s", (target) => {
    const entry = getCatalogEntry(target)!;
    expect(entry.models).toHaveLength(0);
    expect(specRowsFor(entry)).toEqual(["model", "effort", "launch"]);
  });

  it("omits effort only when no efforts exist", () => {
    expect(specRowsFor({ models: [], efforts: [] })).toEqual(["model", "launch"]);
    expect(specRowsFor({ models: claude.models, efforts: [] })).toEqual(["model", "launch"]);
  });

  it("moves through rows and stops at both ends", () => {
    const rows: readonly SpecRow[] = ["model", "effort", "launch"];
    expect(moveSpecRow(rows, "model", -1)).toBe("model");
    expect(moveSpecRow(rows, "model", 1)).toBe("effort");
    expect(moveSpecRow(rows, "effort", 1)).toBe("launch");
    expect(moveSpecRow(rows, "launch", 1)).toBe("launch");
    expect(moveSpecRow(rows, "launch", -1)).toBe("effort");
    expect(moveSpecRow(rows, "effort", -1)).toBe("model");
  });

  it("moves directly between model and launch when effort is absent", () => {
    const rows = specRowsFor({ models: [], efforts: [] });
    expect(moveSpecRow(rows, "model", 1)).toBe("launch");
    expect(moveSpecRow(rows, "launch", -1)).toBe("model");
    expect(moveSpecRow(rows, "model", -1)).toBe("model");
    expect(moveSpecRow(rows, "launch", 1)).toBe("launch");
  });
});

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

  it("renders a globe for the browser launch row", () => {
    const browser = launchItems().find((item) => item.target === "web-browser");
    expect(browser?.iconKind).toBe("browser");
    const markup = renderToStaticMarkup(createElement(AgentKindIcon, { kind: browser?.iconKind, chip: false }));
    expect(markup).toContain('viewBox="0 0 24 24"');
    expect(markup).toContain('stroke="currentColor"');
    expect(markup.match(/<circle\b/g)).toHaveLength(1);
    expect(markup.match(/<ellipse\b/g)).toHaveLength(1);
    expect(markup.match(/<path\b/g)).toHaveLength(2);
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

  const dirs = dirSections(view([
    entry("master", "dev", "mycmux (master)", "C:/Users/miyaz/cmux-for-linux-dev-master"),
    entry("ime", "dev", "ime-dev (\u81ea\u4f5cIME)", "C:/Users/miyaz/ime-dev"),
    entry("math", "anken", "\u99ff\u53f0/\u30e2\u30e2\u30b9\u30bf/\u6570\u5b66", "C:/Users/miyaz/anken/math", { source: "auto", signal: "mention", seen_at: "2026-09-03" }),
    entry("toyo", "anken", "\u6771\u6d0b\u98df\u54c1\u5de5\u696d\u77ed\u671f\u5927\u5b66/2027\u5e74\u5ea6\u5165\u8a66", "C:/Users/miyaz/anken/toyo"),
  ])).flatMap((section) => section.items);

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
  it("puts manual rows first in document order and auto rows in descending date order", () => {
    const data = view([
      entry("old", "dev", "Old", "C:/old", { source: "auto", seen_at: "2026-09-02", added_at: "2026-09-03" }),
      entry("m2", "dev", "Second manual", "C:/m2"),
      entry("tie", "dev", "Tie", "C:/tie", { source: "auto", seen_at: "2026-09-02", added_at: "2026-09-04" }),
      entry("m1", "dev", "First manual", "C:/m1"),
      entry("new", "dev", "New", "C:/new", { source: "auto", seen_at: "2026-09-05", added_at: "2026-09-02" }),
      entry("unknown", "dev", "No date", "C:/unknown", { source: "auto" }),
    ]);
    const original = [...data.doc.entries];
    const sections = dirSections(data);
    expect(sections.map((section) => section.label)).toEqual(["Repos", "Clients"]);
    expect(sections[0].items.map((item) => item.id)).toEqual(["m2", "m1", "new", "tie", "old", "unknown"]);
    expect(data.doc.entries).toEqual(original);
  });

  it("derives marks from metadata and never parses a user's label", () => {
    expect(dirMark({ source: "auto", signal: "mention", seen_at: "2026-09-03" })).toBe("\u25cf09/03");
    expect(dirMark({ source: "auto", signal: "session", seen_at: "2026-09-04" })).toBe("\u25cf09/04");
    expect(dirMark({ source: "auto", signal: "git", seen_at: "2026-01-02" })).toBe("01/02");
    expect(dirMark({ source: "auto", signal: "folder", seen_at: "2026-01-02" })).toBe("01/02");
    expect(dirMark({ source: "manual", signal: "mention", seen_at: "2026-09-03" })).toBeUndefined();
    expect(dirMark({ source: "auto", signal: "mention" })).toBeUndefined();
    const item = dirSections(view([entry("one", "dev", "Name (09/03)", "C:/one")]))[0].items[0];
    expect(item.label).toBe("Name (09/03)");
    expect(item.mark).toBeUndefined();
  });

  it("honors section visibility and order, including empty sections", () => {
    const data = view([entry("repo", "dev", "Repo", "C:/repo")]);
    data.doc.sections.reverse();
    expect(dirSections(data).map((section) => section.id)).toEqual(["anken", "dev"]);
    expect(dirSections(data, ["dev", "unknown"]).map((section) => section.id)).toEqual(["anken"]);
    expect(dirSections(data, ["dev"])[0].items).toEqual([]);
    expect(dirSections(data, ["dev", "anken"])).toEqual([]);
  });

  it("retains missing paths and carries their existence flag without losing metadata", () => {
    const data = view([entry("gone", "dev", "Gone", "C:/gone", { source: "auto", signal: "git", seen_at: "2026-09-03" })]);
    data.entries_exist = [["gone", false]];
    expect(dirSections(data)[0].items[0]).toMatchObject({ id: "gone", source: "auto", signal: "git", seen_at: "2026-09-03", exists: false, mark: "09/03" });
  });

  it("survives an unloaded view", () => {
    expect(dirSections(null)).toEqual([]);
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

  it("does not split a surrogate pair", () => {
    const out = middleEllipsis(`${"a".repeat(12)}\u{1F600}${"b".repeat(20)}`, 26);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(Array.from(out).length).toBe(26);
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


describe("empty directory section candidate count", () => {
  it("counts saved candidates across sections and omits missing or old scan JSON", () => {
    const data = view([]);
    expect(dirCandidateCount(null)).toBe(0);
    expect(dirCandidateCount(data)).toBe(0);
    data.doc.last_scan = { future: true };
    expect(dirCandidateCount(data)).toBe(0);
    data.doc.last_scan = { candidates: [{ section: "dev" }, { section: "anken" }], more: 12 };
    expect(dirCandidateCount(data)).toBe(2);
    data.doc.last_scan = { candidates: [] };
    expect(dirCandidateCount(data)).toBe(0);
  });
});
