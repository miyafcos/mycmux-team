import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => mocks);
import { closeCodexExperiment, codexExperimentCommand, getAgentAdapterCapabilities,
  getCodexExperimentStatus, setCodexExperimentEnabled, startCodexExperiment } from "../../src/lib/agentAdapterApi";

beforeEach(() => { mocks.invoke.mockReset(); mocks.invoke.mockResolvedValue({ version: 1 }); });
describe("adapter and experiment async API", () => {
  it("keeps opt-in, start and status separate and does not launch on a capability read", async () => {
    await getAgentAdapterCapabilities();
    await getCodexExperimentStatus();
    await setCodexExperimentEnabled(true);
    await startCodexExperiment("C:/trial", "  C:/tools/codex.exe  ");
    await closeCodexExperiment();
    expect(mocks.invoke.mock.calls).toEqual([
      ["agent_adapter_capabilities"], ["codex_app_server_status"],
      ["codex_app_server_set_enabled", { enabled: true }],
      ["codex_app_server_start", { cwd: "C:/trial", executable: "C:/tools/codex.exe" }],
      ["codex_app_server_close"],
    ]);
  });
  it("passes IDs unchanged and propagates unsupported operations without substitution", async () => {
    const request = { operation: "steer" as const, operationId: "steer-1", expectedTurnId: "turn-1", text: "additional input" };
    await codexExperimentCommand(request);
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("codex_app_server_command", { request });
    mocks.invoke.mockRejectedValueOnce(new Error("unsupported: fork"));
    await expect(codexExperimentCommand({ operation: "fork", operationId: "fork-1" })).rejects.toThrow("unsupported: fork");
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(mocks.invoke.mock.calls[1]).toEqual(["codex_app_server_command", { request: { operation: "fork", operationId: "fork-1" } }]);
  });
});
