import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  Channel: class {},
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

import {
  workorderActivateVersion,
  workorderCancel,
  workorderCreateDraft,
  workorderGo,
  workorderPreview,
  workorderRefreshSources,
  workorderRetrySpawn,
  type WorkOrderPlanDraft,
} from "../../src/lib/ipc";

const plan: WorkOrderPlanDraft = {
  goal: "Integrate the sources",
  acceptanceCriteria: [{ id: "c1", description: "verified" }],
  bindings: [{
    logicalSessionId: "integrator",
    roles: ["integrator"],
    labelSnapshot: null,
    snapshotEventId: null,
  }],
  workItems: [{
    id: "integrate",
    objective: "integrate",
    assignee: null,
    dependencies: [],
    expectedArtifacts: [],
    writeScope: [],
    gates: [],
    required: true,
    state: "pending",
  }],
  budgets: {
    maxNewPty: 1,
    maxWorkItems: 1,
    maxReplans: 1,
    maxPackets: 1,
    maxRoundtripsPerEdge: 1,
  },
};

beforeEach(() => {
  mocks.invoke.mockClear();
});

describe("WorkOrder IPC wrappers", () => {
  it("uses the exact draft, source, cancel, activate, and retry command payloads", async () => {
    await workorderCreateDraft(plan);
    await workorderRefreshSources("order-1");
    await workorderCancel("order-1");
    await workorderActivateVersion("order-1", 2);
    await workorderRetrySpawn("order-1");

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "workorder_create_draft", { plan });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "workorder_refresh_sources", { id: "order-1" });
    expect(mocks.invoke).toHaveBeenNthCalledWith(3, "workorder_cancel", { id: "order-1" });
    expect(mocks.invoke).toHaveBeenNthCalledWith(4, "workorder_activate_version", { id: "order-1", planVersion: 2 });
    expect(mocks.invoke).toHaveBeenNthCalledWith(5, "workorder_retry_spawn", { workOrderId: "order-1" });
  });

  it("requires cwd for preview and GO before invoking Rust", async () => {
    await workorderPreview("order-1", "C:\\repo");
    await workorderGo("order-1", {
      cwd: "C:\\repo",
      overrideMissingSources: true,
      agentKind: "codex",
    });

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "workorder_preview", {
      id: "order-1",
      cwd: "C:\\repo",
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "workorder_go", {
      id: "order-1",
      options: {
        cwd: "C:\\repo",
        overrideMissingSources: true,
        agentKind: "codex",
      },
    });
  });
});
