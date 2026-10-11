import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { nameGraphemes, namePrefix, deriveAutoName, resolveNameSiblings, shortAutomaticName } from "../../src/lib/autoNamePolicy";
import { runQualityCase, type QualityCase } from "./helpers/autoNamingQuality";
const fixtures = JSON.parse(readFileSync(new URL("../fixtures/auto_naming_quality.json", import.meta.url), "utf8")).cases as QualityCase[];
const invalid = /[\x00-\x1f\x7f\ufffd\ud800-\udfff]|…|・\s*・|(?:claude|codex)-\d+|\b\d{6,8}[-_]/u;
const results: Awaited<ReturnType<typeof runQualityCase>>[] = [];
it("freezes 48 fictional chronological fixtures, including all seven observed failure types", () => {
  expect(fixtures).toHaveLength(48); expect(new Set(fixtures.map(f => f.id)).size).toBe(48);
  expect(fixtures.filter(f => f.category === "normal")).toHaveLength(24); expect(fixtures.filter(f => f.category === "failure")).toHaveLength(14); expect(fixtures.filter(f => f.category === "state")).toHaveLength(10);
  expect(new Set(fixtures.map(f => f.failureType).filter(Boolean)).size).toBe(7);
});
for (const fixture of fixtures) it(fixture.id + ": " + fixture.reason, async () => {
  const result = await runQualityCase(fixture); results.push(result);
  const beforeTabs = result.before.flatMap(w => w.panes.flatMap(p => p.tabs));
  const afterTabs = result.after.flatMap(w => w.panes.flatMap(p => p.tabs));
  for (const row of result.names) {
    const expected = row.expectation;
    for (const term of expected.must ?? []) { expect(row.full, row.id + " full").toContain(term); expect(row.short, row.id + " short").toContain(term); }
    for (const term of expected.forbidden ?? []) { expect(row.full, row.id + " full").not.toContain(term); expect(row.short, row.id + " short").not.toContain(term); }
    const before = beforeTabs.find(t => t.id === row.id)!; const after = afterTabs.find(t => t.id === row.id)!;
    if (expected.protected && !fixture.frames.some(f => f.manualRename === row.id)) expect(after).toEqual(before);
    if (expected.restored) expect(after).toEqual(before);
    if (expected.off) { expect(after.displayName).toBeUndefined(); expect(after.label).toBe(before.label); }
    if (row.auto && !expected.protected && !expected.restored) {
      expect(row.full).not.toMatch(invalid); expect(row.short).not.toMatch(invalid);
      expect(nameGraphemes(row.full).length).toBeLessThanOrEqual(48); expect(nameGraphemes(row.short).length).toBeLessThanOrEqual(20);
      expect(row.short).not.toMatch(/[のをがにと・ ]$/);
    }
    const immutable = (t: typeof before) => ({ id: t.id, agentKind: t.agentKind, agentSessionId: t.agentSessionId, cwd: t.cwd, label: t.label, initialPrompt: t.initialPrompt, commandArgv: t.commandArgv, launchEnv: t.launchEnv });
    if (!fixture.frames.some(f => f.replace || f.manualRename === row.id)) expect(immutable(after)).toEqual(immutable(before));
  }
  if (fixture.expected.distinctPrefixes) {
    const names = result.names.filter(row => row.auto).map(row => row.short);
    expect(new Set(names).size).toBe(names.length); expect(new Set(names.map(namePrefix)).size).toBe(names.length);
  }
  for (const term of fixture.expected.workspaceMust ?? []) expect(result.workspace.after).toContain(term);
  if (fixture.expected.workspaceProtected) expect(result.workspace.after).toBe(result.workspace.before);
  if (fixture.expected.jobs !== undefined) expect(result.workspace.summary.jobs).toBe(fixture.expected.jobs);
  // Explicit corrections may keep the old valid name during the 10-second quiet period.
  // Once the current job commits, no later snapshot can return to the rejected job.
  if (fixture.scenario === "misleading-material" || fixture.failureType === "stale-title") {
    const correctionAt = Math.min(...fixture.workspaces.flatMap(w => w.tabs.flatMap(t => t.events.filter(e => e.kind === "correction").map(e => e.at))));
    for (const commit of result.commits.filter(c => c.at >= correctionAt + 10_000)) for (const term of fixture.expected.tabs[commit.id]?.forbidden ?? []) expect(commit.full).not.toContain(term);
  }
});
function recordQualityResults(output: string | URL = process.env.AUTO_NAMING_QUALITY_REPORT_PATH ?? new URL("../../.dispatch/quality-results.json", import.meta.url)): void {
  if (process.env.AUTO_NAMING_QUALITY_REPORT !== "1") return;
  const timings: number[] = [];
  for (let trial = 0; trial < 100; trial++) {
    const start = performance.now();
    const rows = Array.from({ length: 100 }, (_, index) => ({ id: String(index), tab: { id: String(index), sessionId: "pty-" + index, agentId: "shell-starter" },
      meaning: deriveAutoName({ id: String(index), workspaceId: "w", binding: "binding", contentKey: "slides", instructions: [index % 2 ? "解答の表現を確認する" : "図版の配置を調整する"], activity: [], files: [], taskTitle: "", cwd: "", evidenceRefs: ["user"] }) }));
    const names = resolveNameSiblings(rows); for (const name of names.values()) shortAutomaticName(name);
    timings.push(performance.now() - start);
  }
  const firstTrialMs = timings[0];
  timings.sort((a,b) => a-b);
  const path = typeof output === "string" ? output : fileURLToPath(output);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ mode: "rules", modelCalls: 0, cases: results,
    benchmark: { seats: 100, trials: 100, firstTrialMs, medianMs: timings[50], maximumMs: timings[99], includes: "derive + siblings + short, repeated inputs with bounded caches, excludes IPC" } }, null, 2) + "\n");
}
it("records real rules output and a measured pure-policy benchmark when requested", () => recordQualityResults());

it("R14: opt-in quality report creates an absent parent directory", () => {
  const root = mkdtempSync(join(tmpdir(), "naming-report-"));
  const output = join(root, "new", "nested", "quality-results.json");
  const previous = process.env.AUTO_NAMING_QUALITY_REPORT;
  process.env.AUTO_NAMING_QUALITY_REPORT = "1";
  try {
    recordQualityResults(output);
    expect(JSON.parse(readFileSync(output, "utf8")).cases).toHaveLength(48);
  } finally {
    if (previous === undefined) delete process.env.AUTO_NAMING_QUALITY_REPORT;
    else process.env.AUTO_NAMING_QUALITY_REPORT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
