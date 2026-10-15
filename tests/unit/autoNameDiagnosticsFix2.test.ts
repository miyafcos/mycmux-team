import { beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({invoke:vi.fn().mockResolvedValue(undefined)}));
vi.mock("@tauri-apps/api/core", () => ({invoke:fake.invoke}));
import { reportAutoNameFailures } from "../../src/lib/autoNameDiagnostics";
import { deriveAutoName, type AutoNameMeaning } from "../../src/lib/autoNamePolicy";
const failed = deriveAutoName({id:"t", workspaceId:"w", binding:"b", contentKey:"k", instructions:[], activity:[], files:[], taskTitle:"", cwd:"", evidenceRefs:[], materialStatus:"unreadable"});
beforeEach(async () => { await reportAutoNameFailures(new Map(), 0); fake.invoke.mockClear().mockResolvedValue(undefined); });
const logged = () => fake.invoke.mock.calls.flatMap(([, args]) => args.requests);

it("F07 flushes all four failures at 0/30/60/90 seconds before recovery at 120 seconds", async () => {
  for (const now of [0, 30000, 60000, 90000]) await reportAutoNameFailures(new Map([["t", failed]]), now);
  await reportAutoNameFailures(new Map([["t", {...failed, unknownReason:undefined}]]), 120000);
  expect(logged().reduce((sum, row) => sum + row.observations, 0)).toBe(4);
});
it("F07 flushes three replies before changing reason", async () => {
  for (const now of [0, 30000, 60000]) await reportAutoNameFailures(new Map([["t", {...failed, unknownReason:"reply"}]]), now);
  await reportAutoNameFailures(new Map([["t", failed]]), 90000);
  expect(logged().filter(row => row.reason === "reply").reduce((sum, row) => sum + row.observations, 0)).toBe(3);
});
it("F07 flushes outstanding observations before the tab disappears", async () => {
  for (const now of [0, 30000, 60000]) await reportAutoNameFailures(new Map([["t", failed]]), now);
  await reportAutoNameFailures(new Map(), 90000);
  expect(logged().reduce((sum, row) => sum + row.observations, 0)).toBe(3);
});
it("F07 distinguishes four observations of two failed reads", async () => {
  const report = reportAutoNameFailures as (meanings: ReadonlyMap<string, AutoNameMeaning>, now: number,
    reads: ReadonlyMap<string, {binding:string; readFailureCount:number}>) => Promise<void>;
  for (const [now, readFailureCount] of [[0, 1], [30000, 1], [60000, 2], [90000, 2]])
    await report(new Map([["t", failed]]), now, new Map([["t", {binding:"b", readFailureCount}]]));
  await report(new Map([["t", {...failed, unknownReason:undefined}]]), 120000, new Map([["t", {binding:"b", readFailureCount:2}]]));
  expect(logged().reduce((sum, row) => sum + (row.read_failures ?? 0), 0)).toBe(2);
  expect(logged().reduce((sum, row) => sum + row.observations, 0)).toBe(4);
});
