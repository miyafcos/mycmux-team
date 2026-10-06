import { describe, expect, it } from "vitest";
import { preflightPaneClose } from "../../src/lib/paneClosePreflight";
import { collectPaneCloseVictims } from "../../src/lib/paneCloseImpact";

import { fixture } from "./fixtures/paneClose";

describe("C1 close preflight", () => {
  it.each(["terminal", "launcher"] as const)("protects the last %s before every close entry", (type) => {
    const w = fixture(1, 1, type);
    const before = JSON.stringify(w);
    for (const entry of ["x", "middle", "key", "cli"]) {
      const result = preflightPaneClose([w], entry === "key"
        ? { kind: "pane", workspaceId: "w", paneId: "p0" }
        : { kind: "tab", workspaceId: "w", paneId: "p0", tabId: "t0-0" });
      expect(result.ok, entry).toBe(false);
      if (!result.ok) expect(result.reason).toBe("last");
    }
    expect(JSON.stringify(w)).toBe(before);
  });

  it.each(["terminal", "launcher"] as const)("compares every close entry and shape for %s", (type) => {
    for (const [panes, tabs] of [[1, 1], [2, 1], [1, 2]]) {
      const w = fixture(panes, tabs, type);
      const before = JSON.stringify(w);
      for (const entry of ["x", "middle", "key", "cli"]) {
        const result = preflightPaneClose([w], entry === "key"
          ? { kind: "pane", workspaceId: "w", paneId: "p0" }
          : { kind: "tab", workspaceId: "w", paneId: "p0", tabId: "t0-0" });
        expect(result.ok, entry + " " + panes + "x" + tabs).toBe(entry === "key" ? panes > 1 : panes > 1 || tabs > 1);
      }
      expect(JSON.stringify(w)).toBe(before);
    }
  });

  it.each([[1, 2], [2, 1], [2, 2]])("allows one tab in %i panes with %i tabs", (panes, tabs) => {
    expect(preflightPaneClose([fixture(panes, tabs)], { kind: "tab", workspaceId: "w", paneId: "p0", tabId: "t0-0" }).ok).toBe(true);
  });

  it("rejects missing targets and protects a bulk last-tab close", () => {
    expect(preflightPaneClose([fixture()], { kind: "tab", workspaceId: "w", paneId: "p0", tabId: "missing" })).toMatchObject({ ok: false, reason: "missing" });
    expect(preflightPaneClose([fixture(1, 2)], { kind: "tabs", tabIds: ["t0-0", "t0-1"] })).toMatchObject({ ok: false, reason: "last" });
    expect(preflightPaneClose([fixture(2, 1)], { kind: "tabs", tabIds: ["t0-0", "t1-0"] }).ok).toBe(true);
  });
});

describe("C2 fixed confirmation decision table", () => {
  it.each([
    ["idle shell", {}, {}, {}, false],
    ["working non-agent", {}, { processIsShell: false, outputActive: true }, {}, true],
    ["quiet non-agent child", {}, { processIsShell: false }, {}, true],
    ["working agent", { agentKind: "codex" }, { processIsShell: false, agentStatus: "working" }, {}, true],
    ["waiting agent", { agentKind: "codex" }, { processIsShell: false, agentStatus: "waiting" }, {}, true],
    ["idle live agent", { agentKind: "codex" }, { processIsShell: false }, {}, true],
    ["agent exited to shell", { agentKind: "codex" }, { processIsShell: true }, {}, false],
    ["declared agent", { agentKind: "codex", lifecycle: "declared" }, {}, {}, false],
    ["launcher", { type: "launcher", agentKind: "codex" }, {}, {}, false],
    ["stopped agent", { agentKind: "codex" }, {}, { ptyAlive: false }, false],
  ] as const)("%s", (_label, tabPatch, metadata, volatile, expected) => {
    const w = fixture();
    w.panes[0].tabs[0] = { ...w.panes[0].tabs[0], ...tabPatch };
    const victims = collectPaneCloseVictims(w.panes, { "pty-0-0": { ...metadata } }, { "pty-0-0": { ...volatile } });
    expect(victims.length > 0).toBe(expected);
  });
});
