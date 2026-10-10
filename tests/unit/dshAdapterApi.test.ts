import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
const invoke = vi.hoisted(() => vi.fn(async () => ({ version: 1 })));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import * as api from "../../src/lib/agentAdapterApi";
const run: api.DshRunRef = { runId: "run", generation: 2, convId: "opaque/session", cwd: "/trial" };

describe("dedicated dsh IPC contract", () => {
  it("uses dedicated start and opt-in commands without selecting an LLM or credentials", async () => {
    await api.setDshExperimentEnabled(true);
    const request = { executable: "/prepared/dsh", cwd: "/trial", dshHome: null, resume: run };
    await api.startDshExperiment(request);
    expect(invoke).toHaveBeenCalledWith("dsh_acp_set_enabled", { enabled: true });
    expect(invoke).toHaveBeenCalledWith("dsh_acp_start", { request });
  });
  it("passes the exact expected run and operation ID without a synthetic Codex turn ID", async () => {
    const request = { expectedRun: run, operationId: "local-operation", text: "hello" };
    await api.sendDshPrompt(request); expect(invoke).toHaveBeenCalledWith("dsh_acp_prompt", { request });
    await api.cancelDshPrompt(run); expect(invoke).toHaveBeenCalledWith("dsh_acp_cancel", { expectedRun: run });
  });
  it("keeps read cursors and history semantics in the ACP API", async () => {
    await api.readDshExperiment(run, 5); expect(invoke).toHaveBeenCalledWith("dsh_acp_read", { expectedRun: run, cursor: 5 });
    await api.getDshExperimentStatus(); expect(invoke).toHaveBeenCalledWith("dsh_acp_status");
  });
  it.each(["allow", "reject"] as const)("answers %s as a scoped one-shot permission", async (choice) => {
    const answer = { expectedRun: run, permissionId: "permission", choice };
    await api.answerDshPermission(answer); expect(invoke).toHaveBeenCalledWith("dsh_acp_permission", { answer });
  });
  it("keeps session close, process stop and disabling separate", async () => {
    await api.closeDshSession(run); expect(invoke).toHaveBeenCalledWith("dsh_acp_close_session", { expectedRun: run });
    await api.stopDshOwnedProcess(run); expect(invoke).toHaveBeenCalledWith("dsh_acp_stop_owned", { expectedRun: run });
    await api.setDshExperimentEnabled(false); expect(invoke).toHaveBeenCalledWith("dsh_acp_set_enabled", { enabled: false });
  });
  it("does not change the eight v1 operations or expose credential/settings dump fields", () => {
    const source = readFileSync("src/lib/agentAdapterApi.ts", "utf8");
    const operations = source.match(/export type AdapterOperation = ([^;]+);/)![1].match(/"[^"]+"/g)!;
    expect(operations).toHaveLength(8); expect(operations).not.toContain('"closeSession"');
    const dedicated = source.split("/** Dedicated ACP API.")[1];
    expect(dedicated).not.toMatch(/apiKey|accessToken|authToken|credentialStore/);
    expect(dedicated).toContain("acceptedAtMs: null"); expect(dedicated).toContain("historyAvailable: false");
    expect(readFileSync("src/lib/ipc.ts", "utf8")).toContain('from "./agentAdapterApi"');
  });
});
