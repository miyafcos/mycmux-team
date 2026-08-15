import { describe, expect, it } from "vitest";
import { buildGroups, resolveGroupKey } from "../../src/lib/groupMembership";
import type { Pane, PaneTab, Workspace } from "../../src/types";

function tab(id: string, sessionId = id): PaneTab {
  return { id, sessionId, agentId: "shell-starter" };
}

function pane(id: string, tabs: PaneTab[], cwd?: string): Pane {
  return { id, agentId: "shell-starter", sessionId: tabs[0]?.sessionId ?? "", tabs, activeTabId: tabs[0]?.id ?? "", cwd };
}

function workspace(id: string, panes: Pane[]): Workspace {
  return { id, name: id, gridTemplateId: "1x1", status: "running", createdAt: 1, panes };
}

describe("group membership", () => {
  it("prefers an origin tree over cwd and resolves its root", () => {
    const root = tab("root", "root-session");
    const child = { ...tab("child", "child-session"), origin: { kind: "agent" as const, parentTabId: "root" } };
    const childPane = pane("child-pane", [child], "C:/Other");
    const cwdTab = tab("cwd");
    const options = {
      parentTabIdByTabId: { root: undefined, child: "root", cwd: undefined },
      originRootTabIds: new Set(["root"]),
    };

    expect(resolveGroupKey(child, childPane, options)).toBe("origin:root");
    const input = [workspace("a", [pane("root-pane", [root], "C:/Work"), childPane, pane("cwd-pane", [cwdTab], "C:/Else")])];
    expect(buildGroups(input)).toEqual(new Map([
      ["origin:root", ["root", "child"]],
      ["cwd:c:/else", ["cwd"]],
    ]));
    expect(buildGroups(input)).toEqual(buildGroups(input));
  });

  it("falls back to normalized absolute pane cwd", () => {
    const first = tab("first");
    const second = tab("second");
    const options = { parentTabIdByTabId: {}, originRootTabIds: new Set<string>() };

    expect(resolveGroupKey(first, pane("a", [first], "C:\\Work\\Repo\\"), options)).toBe("cwd:c:/work/repo");
    expect(resolveGroupKey(second, pane("b", [second], "c:/WORK/repo/"), options)).toBe("cwd:c:/work/repo");
  });

  it("returns null without origin or an absolute cwd", () => {
    const ungrouped = tab("ungrouped");
    const input = [workspace("a", [pane("p", [ungrouped], "relative/path")])];
    const options = { parentTabIdByTabId: {}, originRootTabIds: new Set<string>() };

    expect(resolveGroupKey(ungrouped, input[0].panes[0], options)).toBeNull();
    expect(buildGroups(input)).toEqual(new Map());
  });

  it("uses one canonical key for every tab reaching an origin cycle", () => {
    const tabs = [
      { ...tab("a"), origin: { kind: "agent" as const, parentTabId: "b" } },
      { ...tab("b"), origin: { kind: "agent" as const, parentTabId: "c" } },
      { ...tab("c"), origin: { kind: "agent" as const, parentTabId: "b" } },
    ];

    expect(buildGroups([workspace("cycle", [pane("cycle-pane", tabs, "C:/Ignored")])]))
      .toEqual(new Map([["origin:b", ["a", "b", "c"]]]));
  });
});
