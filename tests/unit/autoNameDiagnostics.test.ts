import { expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ invoke:vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke:fake.invoke }));
import { reportAutoNameFailures } from "../../src/lib/autoNameDiagnostics";
import { deriveAutoName } from "../../src/lib/autoNamePolicy";
const failed = deriveAutoName({id:"t",workspaceId:"w",binding:"b",contentKey:"k", instructions:[],activity:[],files:[],taskTitle:"",cwd:"",evidenceRefs:[],materialStatus:"unreadable"});
it("logs transitions, counts repeated failures, and emits no conversation text", async () => {
  const meanings = new Map([["diag-t", failed]]);
  await reportAutoNameFailures(meanings, 0); await reportAutoNameFailures(meanings, 30_000);
  expect(fake.invoke).toHaveBeenCalledTimes(1);
  await reportAutoNameFailures(meanings, 300_000);
  expect(fake.invoke).toHaveBeenLastCalledWith("auto_name_diagnostics", {requests:[{tab_id:"diag-t", reason:"read-failed", retained:false, observations:2, read_failures:0}]});
  await reportAutoNameFailures(new Map([["diag-t", {...failed, staleSince:0}]]), 301_000);
  expect(fake.invoke).toHaveBeenLastCalledWith("auto_name_diagnostics", {requests:[{tab_id:"diag-t", reason:"read-failed", retained:true, observations:1, read_failures:0}]});
});
it("bounds batches and swallows diagnostic failures", async () => {
  fake.invoke.mockClear().mockRejectedValue(new Error("unavailable"));
  await expect(reportAutoNameFailures(new Map(Array.from({length:130}, (_, i) => ["batch-"+i, failed])), 0)).resolves.toBeUndefined();
  expect(fake.invoke.mock.calls[0][1].requests).toHaveLength(64);
});
