import { describe, expect, it } from "vitest";
import { RULE_TYPES, formatCandidate, readLastScan, readRule, ruleForm, ruleSummary, validateRuleForm } from "../../src/lib/launcherDirsModel";
import { launcherTabStrings as T } from "../../src/components/settings/tabs/launcherTabStrings";
import type { LauncherDirCandidate } from "../../src/lib/ipc";

const raw = (type: string) => ({ id: "r1", type, section: "dev", mode: "suggest", enabled: true,
  parents: ["C:/Users/test", "C:/Users/test/apps"], root: "C:/Clients/work" });

describe("launcher rule interpretation and summaries", () => {
  it("applies each type's defaults and describes the four rule types", () => {
    const git = readRule(raw("git-parents"))!;
    expect([git.window_days, git.max]).toEqual([30, 10]);
    expect(ruleSummary(git, "C:/Users/test", T)).toBe([T.summaryUnder("~ ~/apps"), T.summaryDays(30), T.summaryMax(10)].join(" \u00b7 "));
    const folder = { ...raw("folder-root"), depth_overrides: [{ prefix: "special", depth: 3 }],
      exclude: { prefixes: ["_", "."], substrings: ["noise"] }, top_level_exclude: ["admin"] };
    expect(ruleSummary(folder, "", T)).toBe(["\u2026/Clients/work", T.summaryDepth(2, "special 3"), T.summaryDays(21), T.summaryMax(20), T.summaryExcludes(4)].join(" \u00b7 "));
    expect(ruleSummary({ ...raw("session-cwd"), root: null }, "", T)).toBe([T.summaryAllSessions, T.summaryDays(30), T.summaryMax(20), T.summaryMinSessions(1)].join(" \u00b7 "));
    expect(ruleSummary(raw("session-mentions"), "", T)).toBe(["\u2026/Clients/work", T.summaryDepth(2, ""), T.summaryDays(14), T.summaryMinMentions(3), T.summaryMax(20)].join(" \u00b7 "));
    expect(ruleSummary({ ...raw("git-parents"), parents: ["C:/Users/test-sibling", "c:/users/TEST/tools"] }, "C:/Users/test", T)).toContain("C:/Users/test-sibling ~/tools");
  });

  it("rejects malformed and future rules without changing their raw values", () => {
    const unknown = { id: "future", type: "future", nested: { payload: [1, 2] } };
    const before = JSON.stringify(unknown);
    expect(readRule(unknown)).toBeNull();
    expect(ruleSummary(unknown, "", T)).toBe(T.ruleTypeUnknown);
    expect(JSON.stringify(unknown)).toBe(before);
    for (const value of [null, [], { ...raw("git-parents"), enabled: undefined }, { ...raw("git-parents"), parents: [] },
      { ...raw("folder-root"), depth: 0 }, { ...raw("folder-root"), root: null }, { ...raw("git-parents"), max: "10" },
      { ...raw("session-cwd"), min_sessions: 1.5 }, { ...raw("session-mentions"), min_mentions: 0 },
      { ...raw("git-parents"), section: ["dev"] }, { ...raw("git-parents"), exclude: { prefixes: 3 } }]) {
      expect(readRule(value)).toBeNull();
    }
  });
});

describe("launcher rule forms", () => {
  it("validates required directories, positive integers and override lines", () => {
    expect(validateRuleForm(ruleForm("git-parents"), T).error).toBe(T.validationParentsRequired);
    expect(validateRuleForm(ruleForm("folder-root"), T).error).toBe(T.validationRootRequired);
    const form = { ...ruleForm("folder-root"), root: " C:/Work Root ", depth_overrides: " special=3\n other=4\n", exclude_prefixes: "_\n.\n" };
    const saved = validateRuleForm(form, T);
    expect(saved.error).toBeNull();
    expect(saved.rule).toMatchObject({ root: "C:/Work Root", depth: 2, max_depth: 6,
      depth_overrides: [{ prefix: "special", depth: 3 }, { prefix: "other", depth: 4 }], exclude: { prefixes: ["_", "."] } });
    for (const invalid of ["", "0", "-1", "1.5", "NaN", "Infinity", "4294967296"]) {
      expect(validateRuleForm({ ...form, max: invalid }, T).error).toBe(T.validationPositiveInteger(T.fieldMax));
    }
    for (const invalid of ["client", "client=0", "=3", "client=1.5"]) {
      expect(validateRuleForm({ ...form, depth_overrides: invalid }, T).error).toBe(T.validationPositiveInteger(T.fieldDepthOverrides));
    }
    expect(validateRuleForm(ruleForm("session-cwd"), T).rule?.root).toBeNull();
  });

  it("round trips every form and only includes fields used by its rule type", () => {
    for (const type of RULE_TYPES) {
      const rule = readRule(raw(type))!;
      const saved = validateRuleForm(ruleForm(type, "dev", rule), T);
      expect(saved.rule).toEqual(rule);
      expect(saved.error).toBeNull();
    }
    const form = { ...ruleForm("git-parents"), parents: "C:/one\r\n C:/space dir \n\n" };
    expect(validateRuleForm(form, T).rule?.parents).toEqual(["C:/one", "C:/space dir"]);
  });
});

describe("saved candidates", () => {
  const candidate: LauncherDirCandidate = { path: `C:/Work Root/${"long/".repeat(15)}project`, label: "Project", section: "anken",
    signal: "mention", seen_at: "2026-09-05", rule_id: "r1", source: "rule" };

  it("formats each signal, the marker and a middle-shortened path with its full title", () => {
    const display = formatCandidate(candidate, T);
    expect(display.mark).toBe("\u25cf");
    expect(display.signal).toBe(T.signalMention("09/05"));
    expect(display.title).toBe(candidate.path);
    expect(display.path).toContain("\u2026");
    expect(display.path.length).toBeLessThan(candidate.path.length);
    expect(formatCandidate({ ...candidate, signal: "git" }, T)).toMatchObject({ mark: "", signal: T.signalGit("09/05") });
    expect(formatCandidate({ ...candidate, signal: "folder" }, T).signal).toBe(T.signalFolder("09/05"));
    expect(formatCandidate({ ...candidate, signal: "session" }, T).signal).toBe(T.signalSession("09/05"));
    expect(formatCandidate({ ...candidate, source: "mru", signal: "session", seen_at: null, rule_id: null }, T).signal).toBe(T.signalMru);
  });

  it("reads a saved scan without accepting malformed candidates or old arbitrary JSON", () => {
    for (const value of [null, { future: true }, { at: "bad", candidates: [], results: {} }]) expect(readLastScan(value)).toBeNull();
    const data = readLastScan({ at: "2026-09-05T12:00:00+09:00", duration_ms: 42, more: 3,
      candidates: [candidate, { ...candidate, signal: ["git"] }, null], results: { r1: { count: 1, truncated: true, error: null }, malformed: false } });
    expect(data?.candidates).toEqual([candidate]);
    expect(data?.results).toEqual({ r1: { count: 1, truncated: true, error: null } });
    expect(data?.more).toBe(3);
  });
});
