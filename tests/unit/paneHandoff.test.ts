import { describe, expect, it } from "vitest";
import type { PaneTab } from "../../src/types";
import {
  isPaneDropTargetEligible,
  prioritizePaneHandoffDropTarget,
  resolvePaneDropZone,
  resolvePaneHandoffEligibility,
  type PaneHandoffEndpoint,
} from "../../src/lib/paneHandoff";
import type { PaneDropTarget } from "../../src/stores/paneDragStore";

function tab(id: string): PaneTab {
  return {
    id,
    sessionId: `session-${id}`,
    agentId: "shell-starter",
  };
}

function endpoint(
  workspaceId: string,
  paneId: string,
  tabId: string,
  metadata: PaneHandoffEndpoint["metadata"],
): PaneHandoffEndpoint {
  return { workspaceId, paneId, tab: tab(tabId), metadata };
}

const liveSource = {
  agentKind: "claude" as const,
  agentSessionId: "source-agent-session",
  cwd: "C:/work/source",
};

const liveTarget = {
  agentKind: "codex" as const,
};

describe("pane handoff eligibility", () => {
  it("does not offer a chip when the drag source is not a live agent", () => {
    const source = endpoint("workspace-a", "pane-a", "source", {
      agentSessionId: liveSource.agentSessionId,
      cwd: liveSource.cwd,
    });
    const target = endpoint("workspace-a", "pane-b", "target", liveTarget);

    expect(resolvePaneHandoffEligibility(source, target)).toBeNull();
  });

  it("requires both the source agent session id and cwd", () => {
    const target = endpoint("workspace-a", "pane-b", "target", liveTarget);
    expect(resolvePaneHandoffEligibility(
      endpoint("workspace-a", "pane-a", "source", {
        agentKind: "claude",
        cwd: liveSource.cwd,
      }),
      target,
    )).toBeNull();
    expect(resolvePaneHandoffEligibility(
      endpoint("workspace-a", "pane-a", "source", {
        agentKind: "claude",
        agentSessionId: liveSource.agentSessionId,
      }),
      target,
    )).toBeNull();
  });

  it("does not offer a chip for the source pane itself", () => {
    const source = endpoint("workspace-a", "pane-a", "source", liveSource);
    const target = endpoint("workspace-a", "pane-a", "target", liveTarget);

    expect(resolvePaneHandoffEligibility(source, target)).toBeNull();
  });

  it("does not offer a chip for a shell without live agent metadata", () => {
    const source = endpoint("workspace-a", "pane-a", "source", liveSource);
    const target = endpoint("workspace-a", "pane-b", "target", { cwd: "C:/work/target" });

    expect(resolvePaneHandoffEligibility(source, target)).toBeNull();
  });

  it("accepts live source and target metadata and maps claude-codex publishing to Claude", () => {
    const source = endpoint("workspace-a", "pane-a", "source", {
      ...liveSource,
      agentKind: "claude-codex",
    });
    const target = endpoint("workspace-a", "pane-b", "target", liveTarget);

    expect(resolvePaneHandoffEligibility(source, target)).toEqual({
      sourceAgentKind: "claude-codex",
      publishAgentKind: "claude",
      sourceAgentSessionId: liveSource.agentSessionId,
      sourceCwd: liveSource.cwd,
      targetAgentKind: "codex",
    });
  });
});

describe("pane handoff drop target priority", () => {
  it("keeps regular center and edge zone resolution deterministic", () => {
    const rect = { left: 0, right: 1_000, top: 0, bottom: 600, width: 1_000, height: 600 };

    expect(resolvePaneDropZone(rect, 500, 300)).toBe("center");
    expect(resolvePaneDropZone(rect, 10, 300)).toBe("left");
    expect(resolvePaneDropZone(rect, 500, 590)).toBe("down");
  });

  it("uses the default edge ratio unchanged and narrows the center when requested", () => {
    const rect = { left: 0, right: 300, top: 0, bottom: 200, width: 300, height: 200 };

    expect(resolvePaneDropZone(rect, 60, 100)).toBe(resolvePaneDropZone(rect, 60, 100, 0.16));
    expect(resolvePaneDropZone(rect, 60, 100)).toBe("center");
    expect(resolvePaneDropZone(rect, 60, 100, 0.22)).toBe("left");
  });

  it("resolves a hit-tested handoff chip before the regular pane zone", () => {
    const handoffTarget: PaneDropTarget = {
      kind: "handoff",
      workspaceId: "workspace-a",
      paneId: "pane-b",
    };
    const regularTarget: PaneDropTarget = {
      kind: "pane",
      workspaceId: "workspace-a",
      paneId: "pane-b",
      zone: "center",
    };

    expect(prioritizePaneHandoffDropTarget(true, handoffTarget, regularTarget))
      .toEqual(handoffTarget);
    expect(prioritizePaneHandoffDropTarget(false, handoffTarget, regularTarget))
      .toEqual(regularTarget);
  });
});

describe("pane drop target eligibility", () => {
  const target = (workspaceId: string, paneId: string, zone: "center" | "left" | "right" | "up" | "down") => ({
    kind: "pane" as const,
    workspaceId,
    paneId,
    zone,
  });

  it("rejects every zone when a whole pane targets itself", () => {
    const source = { kind: "pane" as const, workspaceId: "workspace-a", paneId: "pane-a" };
    for (const zone of ["center", "left", "right", "up", "down"] as const) {
      expect(isPaneDropTargetEligible(source, target("workspace-a", "pane-a", zone), 3))
        .toBe(false);
    }
  });

  it("rejects every self-zone for a pane's only tab", () => {
    const source = { kind: "tab" as const, workspaceId: "workspace-a", paneId: "pane-a" };
    for (const zone of ["center", "left", "right", "up", "down"] as const) {
      expect(isPaneDropTargetEligible(source, target("workspace-a", "pane-a", zone), 1))
        .toBe(false);
    }
  });

  it("allows only edge splits when a multi-tab pane targets itself", () => {
    const source = { kind: "tab" as const, workspaceId: "workspace-a", paneId: "pane-a" };
    expect(isPaneDropTargetEligible(source, target("workspace-a", "pane-a", "center"), 2))
      .toBe(false);
    for (const zone of ["left", "right", "up", "down"] as const) {
      expect(isPaneDropTargetEligible(source, target("workspace-a", "pane-a", zone), 2))
        .toBe(true);
    }
  });

  it("uses both workspace and pane identity before treating a target as self", () => {
    const source = { kind: "tab" as const, workspaceId: "workspace-a", paneId: "pane-a" };
    expect(isPaneDropTargetEligible(source, target("workspace-b", "pane-a", "center"), 1))
      .toBe(true);
    expect(isPaneDropTargetEligible(source, target("workspace-a", "pane-b", "center"), 1))
      .toBe(true);
  });
});
