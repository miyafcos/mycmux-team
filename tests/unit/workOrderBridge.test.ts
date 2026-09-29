import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleSocketCommand: vi.fn(),
  workorderSpawnResult: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../src/components/layout/socketCommands", () => ({
  handleSocketCommand: mocks.handleSocketCommand,
}));
vi.mock("../../src/lib/ipc", () => ({
  workorderSpawnResult: mocks.workorderSpawnResult,
}));

import { handleWorkOrderSpawnRequest, type SpawnRequest } from "../../src/lib/workOrderBridge";
import { useUiStore } from "../../src/stores/uiStore";

function request(requestId: string): SpawnRequest {
  return {
    requestId,
    workOrderId: "order",
    planVersion: 1,
    workItemId: "integrate",
    cwd: "C:\\worktree",
    agentKind: "codex",
    launchEnv: { MYCMUX_HANDOFF_PROMPT_FILE: "C:\\handoff.md" },
    label: "WorkOrder",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({ activePaneId: "source-session", focusRevision: 9 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleWorkOrderSpawnRequest", () => {
  it("deduplicates the same request id before tab creation", async () => {
    mocks.handleSocketCommand.mockResolvedValue({ sessionId: "integrator-session" });
    const payload = request("dedupe-request");
    await Promise.all([
      handleWorkOrderSpawnRequest(payload),
      handleWorkOrderSpawnRequest(payload),
    ]);
    expect(mocks.handleSocketCommand).toHaveBeenCalledTimes(1);
    expect(mocks.workorderSpawnResult).toHaveBeenCalledWith("dedupe-request", {
      sessionId: "integrator-session",
    });
  });

  it("does not cache a failed request id, so the same launch can retry", async () => {
    mocks.handleSocketCommand
      .mockRejectedValueOnce(new Error("spawn failed"))
      .mockResolvedValueOnce({ sessionId: "integrator-session" });
    const payload = request("failure-request");
    await handleWorkOrderSpawnRequest(payload);
    expect(mocks.workorderSpawnResult).toHaveBeenCalledWith("failure-request", {
      error: "spawn failed",
    });
    await handleWorkOrderSpawnRequest(payload);
    expect(mocks.handleSocketCommand).toHaveBeenCalledTimes(2);
    expect(mocks.workorderSpawnResult).toHaveBeenLastCalledWith("failure-request", {
      sessionId: "integrator-session",
    });
  });

  it("requests a background tab with activation disabled and never changes the active session", async () => {
    mocks.handleSocketCommand.mockResolvedValue({ sessionId: "integrator-session" });
    const setActivePaneId = vi.spyOn(useUiStore.getState(), "setActivePaneId");
    const before = useUiStore.getState();
    await handleWorkOrderSpawnRequest(request("focus-request"));
    expect(mocks.handleSocketCommand).toHaveBeenCalledWith("pane.spawn_tab", expect.objectContaining({
      anchorSessionId: "source-session",
      activate: false,
    }));
    expect(setActivePaneId).not.toHaveBeenCalled();
    const after = useUiStore.getState();
    expect(after.activePaneId).toBe(before.activePaneId);
    expect(after.focusRevision).toBe(before.focusRevision);
  });
});
