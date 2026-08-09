import { describe, expect, it } from "vitest";
import type { Pane } from "../../src/types";
import {
  applyCwdToPanes,
  normalizeCwd,
  resolveEmptyWorkspaceState,
  workspaceNameFromCwd,
} from "../../src/lib/workspaceBootstrap";

function makePane(id: string, tabIds: string[]): Pane {
  return {
    id,
    agentId: "shell",
    sessionId: tabIds[0],
    activeTabId: tabIds[0],
    tabs: tabIds.map((tabId) => ({ id: tabId, sessionId: tabId, agentId: "shell" })),
  };
}

describe("normalizeCwd", () => {
  it("strips decorative trailing separators", () => {
    expect(normalizeCwd("C:/work/repo/")).toBe("C:/work/repo");
    expect(normalizeCwd("C:\\work\\repo\\\\")).toBe("C:\\work\\repo");
    expect(normalizeCwd("/home/miyaz/")).toBe("/home/miyaz");
  });

  it("keeps filesystem roots intact", () => {
    expect(normalizeCwd("/")).toBe("/");
    expect(normalizeCwd("C:\\")).toBe("C:\\");
    expect(normalizeCwd("C:/")).toBe("C:\\");
  });

  it("returns an empty string for blank input", () => {
    expect(normalizeCwd("")).toBe("");
    expect(normalizeCwd("   ")).toBe("");
    expect(normalizeCwd(null)).toBe("");
    expect(normalizeCwd(undefined)).toBe("");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeCwd("  C:/work/repo  ")).toBe("C:/work/repo");
  });
});

describe("workspaceNameFromCwd", () => {
  it("uses the last path segment", () => {
    expect(workspaceNameFromCwd("C:\\Users\\miyaz\\cmux-for-linux-dev-master")).toBe(
      "cmux-for-linux-dev-master",
    );
    expect(workspaceNameFromCwd("/home/miyaz/projects/mycmux/")).toBe("mycmux");
  });

  it("falls back to the default name when there is no segment", () => {
    expect(workspaceNameFromCwd("")).toBe("Terminal");
    expect(workspaceNameFromCwd("/")).toBe("Terminal");
    expect(workspaceNameFromCwd(null)).toBe("Terminal");
  });

  it("keeps the drive letter for a bare drive root", () => {
    expect(workspaceNameFromCwd("C:\\")).toBe("C:");
  });
});

describe("applyCwdToPanes", () => {
  it("stamps the cwd onto every pane and tab", () => {
    const panes = [makePane("pane-a", ["s1", "s2"]), makePane("pane-b", ["s3"])];
    applyCwdToPanes(panes, "C:/work");
    expect(panes.map((pane) => pane.cwd)).toEqual(["C:/work", "C:/work"]);
    expect(panes.flatMap((pane) => pane.tabs.map((tab) => tab.cwd))).toEqual([
      "C:/work",
      "C:/work",
      "C:/work",
    ]);
  });

  it("returns the same array it was given", () => {
    const panes = [makePane("pane-a", ["s1"])];
    expect(applyCwdToPanes(panes, "/tmp")).toBe(panes);
  });
});

describe("resolveEmptyWorkspaceState", () => {
  it("shows first-run copy when nothing has ever been created", () => {
    expect(
      resolveEmptyWorkspaceState({
        workspaceCount: 0,
        setupOpen: false,
        hasCreatedWorkspace: false,
      }),
    ).toBe("first-run");
  });

  it("shows returning copy after the last workspace is closed mid-session", () => {
    expect(
      resolveEmptyWorkspaceState({
        workspaceCount: 0,
        setupOpen: false,
        hasCreatedWorkspace: true,
      }),
    ).toBe("returning");
  });

  it("hides while the setup modal owns the workspace area", () => {
    expect(
      resolveEmptyWorkspaceState({
        workspaceCount: 0,
        setupOpen: true,
        hasCreatedWorkspace: false,
      }),
    ).toBeNull();
  });

  it("hides whenever a workspace exists", () => {
    expect(
      resolveEmptyWorkspaceState({
        workspaceCount: 1,
        setupOpen: false,
        hasCreatedWorkspace: true,
      }),
    ).toBeNull();
    expect(
      resolveEmptyWorkspaceState({
        workspaceCount: 2,
        setupOpen: true,
        hasCreatedWorkspace: true,
      }),
    ).toBeNull();
  });
});
