import { describe, expect, it } from "vitest";
import {
  homePathVariants,
  matchesTabSweepCommand,
  pageJumpIndex,
  resolveCrsmEscapeAction,
  shortenCwd,
  sortSessionsByLastActivity,
} from "../../src/components/CommandPalette/CrsmPalette";

describe("CrsmPalette helpers", () => {
  it("keeps active-query results in last_activity-desc order", () => {
    const activeQueryResults = [
      { id: "older-relevant", last_activity: "2026-08-03T10:00:00Z" },
      { id: "newer-less-relevant", last_activity: "2026-08-04T10:00:00Z" },
      { id: "middle", last_activity: "2026-08-03T18:00:00Z" },
    ];

    expect(sortSessionsByLastActivity(activeQueryResults).map((session) => session.id)).toEqual([
      "newer-less-relevant",
      "middle",
      "older-relevant",
    ]);
  });

  it("uses Escape to clear a query before closing", () => {
    expect(resolveCrsmEscapeAction("resume work")).toBe("clear-query");
    expect(resolveCrsmEscapeAction("")).toBe("close");
  });

  it("moves by a floored viewport page and clamps Home and End", () => {
    expect(pageJumpIndex(3, "PageDown", 20, 420, 48)).toBe(11);
    expect(pageJumpIndex(3, "PageUp", 20, 420, 48)).toBe(0);
    expect(pageJumpIndex(8, "Home", 20, 420, 48)).toBe(0);
    expect(pageJumpIndex(8, "End", 20, 420, 48)).toBe(19);
    expect(pageJumpIndex(18, "PageDown", 20, 420, 48)).toBe(19);
  });

  it("finds the tab sweep command without hijacking an empty Enter", () => {
    expect(matchesTabSweepCommand("タブ掃除")).toBe(true);
    expect(matchesTabSweepCommand("タブ")).toBe(true);
    expect(matchesTabSweepCommand("tab sweep")).toBe(true);
    expect(matchesTabSweepCommand("")).toBe(false);
    expect(matchesTabSweepCommand("resume work")).toBe(false);
  });
});

describe("home path detection", () => {
  it("expands a Windows home into its OS, forward-slash and Git-Bash spellings", () => {
    expect(homePathVariants("C:\\Users\\alice")).toEqual([
      "C:\\Users\\alice",
      "C:/Users/alice",
      "/c/Users/alice",
    ]);
  });

  it("ignores a trailing separator and an unresolvable home", () => {
    expect(homePathVariants("C:\\Users\\alice\\")).toContain("C:\\Users\\alice");
    expect(homePathVariants("/home/alice/")).toEqual(["/home/alice"]);
    expect(homePathVariants(null)).toEqual([]);
    expect(homePathVariants("   ")).toEqual([]);
  });
});

describe("shortenCwd", () => {
  const home = homePathVariants("C:\\Users\\alice");

  it("collapses the home directory itself to ~", () => {
    expect(shortenCwd("C:\\Users\\alice", home)).toBe("~");
    expect(shortenCwd("/c/Users/alice", home)).toBe("~");
  });

  it("keeps short home-relative paths whole and elides deeper ones", () => {
    expect(shortenCwd("C:\\Users\\alice\\repo", home)).toBe("repo");
    expect(shortenCwd("C:\\Users\\alice\\src\\repo", home)).toBe("src/repo");
    expect(shortenCwd("C:\\Users\\alice\\a\\b\\c", home)).toBe(".../b/c");
    expect(shortenCwd("/c/Users/alice/a/b/c", home)).toBe(".../b/c");
  });

  it("falls back to the last segment outside home, and when home is unknown", () => {
    expect(shortenCwd("D:\\work\\project", home)).toBe("project");
    expect(shortenCwd("C:\\Users\\alice\\a\\b\\c", [])).toBe("c");
    expect(shortenCwd("C:\\Users\\alice", [])).toBe("alice");
    expect(shortenCwd("", home)).toBe("");
  });

  it("does not treat a sibling directory as the home directory", () => {
    expect(shortenCwd("C:\\Users\\alice-backup\\repo", home)).toBe("repo");
  });
});
