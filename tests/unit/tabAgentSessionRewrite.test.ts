import { describe, expect, it } from "vitest";
import { rewriteTabAgentSession } from "../../src/lib/tabAgentSessionRewrite";
import type { Pane } from "../../src/types";

function pane(id: string, tabs: Array<Partial<Pane["tabs"][number]> & { id: string; sessionId: string }>): Pane {
  return {
    id,
    agentId: "claude-code",
    sessionId: tabs[0]?.sessionId ?? `${id}-session`,
    activeTabId: tabs[0]?.id ?? "",
    tabs: tabs.map((tab) => ({
      agentId: "claude-code",
      type: "terminal",
      ...tab,
    })),
  } as Pane;
}

describe("rewriteTabAgentSession", () => {
  it("clears all three markers on the matching tab only", () => {
    const panes = [
      pane("p1", [
        { id: "t1", sessionId: "term-a", claudeSessionId: "dead", agentKind: "claude", agentSessionId: "dead" },
        { id: "t2", sessionId: "term-b", claudeSessionId: "keep" },
      ]),
    ];

    const { panes: next, didChange } = rewriteTabAgentSession(panes, "term-a", { type: "clear" });
    expect(didChange).toBe(true);
    expect(next[0].tabs[0].claudeSessionId).toBeUndefined();
    expect(next[0].tabs[0].agentKind).toBeUndefined();
    expect(next[0].tabs[0].agentSessionId).toBeUndefined();
    expect(next[0].tabs[1].claudeSessionId).toBe("keep");
  });

  it("no-ops (didChange=false) when the matching tab already has no markers", () => {
    const panes = [pane("p1", [{ id: "t1", sessionId: "term-a" }])];
    const { panes: next, didChange } = rewriteTabAgentSession(panes, "term-a", { type: "clear" });
    expect(didChange).toBe(false);
    expect(next).toBe(panes);
  });

  it("no-ops when no tab matches the terminal session id", () => {
    const panes = [pane("p1", [{ id: "t1", sessionId: "term-a", claudeSessionId: "x" }])];
    const { didChange } = rewriteTabAgentSession(panes, "term-zzz", { type: "clear" });
    expect(didChange).toBe(false);
  });

  it("repoints a claude tab's claudeSessionId to the fallback id", () => {
    const panes = [pane("p1", [{ id: "t1", sessionId: "term-a", claudeSessionId: "dead" }])];
    const { panes: next, didChange } = rewriteTabAgentSession(panes, "term-a", {
      type: "repoint",
      kind: "claude",
      fallbackSessionId: "recovered",
    });
    expect(didChange).toBe(true);
    expect(next[0].tabs[0].claudeSessionId).toBe("recovered");
  });

  it("repoints agentSessionId too when it previously drove the launch", () => {
    const panes = [
      pane("p1", [{ id: "t1", sessionId: "term-a", claudeSessionId: "dead", agentKind: "claude", agentSessionId: "dead" }]),
    ];
    const { panes: next } = rewriteTabAgentSession(panes, "term-a", {
      type: "repoint",
      kind: "claude",
      fallbackSessionId: "recovered",
    });
    expect(next[0].tabs[0].claudeSessionId).toBe("recovered");
    expect(next[0].tabs[0].agentSessionId).toBe("recovered");
    expect(next[0].tabs[0].agentKind).toBe("claude");
  });

  it("repoints a codex tab via agentSessionId and leaves claudeSessionId alone", () => {
    const panes = [
      pane("p1", [{ id: "t1", sessionId: "term-a", agentKind: "codex", agentSessionId: "dead" }]),
    ];
    const { panes: next } = rewriteTabAgentSession(panes, "term-a", {
      type: "repoint",
      kind: "codex",
      fallbackSessionId: "recovered",
    });
    expect(next[0].tabs[0].agentSessionId).toBe("recovered");
    expect(next[0].tabs[0].claudeSessionId).toBeUndefined();
  });

  it("repoint is idempotent (didChange=false when already pointing at the fallback)", () => {
    const panes = [pane("p1", [{ id: "t1", sessionId: "term-a", claudeSessionId: "recovered" }])];
    const { didChange } = rewriteTabAgentSession(panes, "term-a", {
      type: "repoint",
      kind: "claude",
      fallbackSessionId: "recovered",
    });
    expect(didChange).toBe(false);
  });
});
