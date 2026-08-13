import { describe, expect, it } from "vitest";
import type { Pane } from "../../src/types";
import { collectPaneCloseVictims, paneCloseImpactMessage } from "../../src/lib/paneCloseImpact";

function pane(tabs: Pane["tabs"], activeTabId = tabs[0]?.id ?? ""): Pane {
  return { id: "pane-1", agentId: "shell", sessionId: tabs[0]?.sessionId ?? "", tabs, activeTabId };
}

function tab(id: string, overrides: Partial<Pane["tabs"][number]> = {}) {
  return { id, sessionId: `session-${id}`, agentId: "shell", label: id, ...overrides };
}

describe("collectPaneCloseVictims", () => {
  it("returns no victims for idle shell tabs", () => {
    expect(collectPaneCloseVictims([pane([tab("idle")])], {})).toEqual([]);
  });

  it("includes a working tab", () => {
    expect(collectPaneCloseVictims([pane([tab("working")])], {
      "session-working": { processIsShell: false, outputActive: true },
    })).toEqual([{ sessionId: "session-working", label: "working", reason: "working" }]);
  });

  it("includes an agent tab even when it is not currently working", () => {
    expect(collectPaneCloseVictims([pane([tab("agent", { agentKind: "codex" })])], {}))
      .toEqual([{ sessionId: "session-agent", label: "agent", reason: "agent" }]);
  });

  it("handles mixed tabs and includes the active tab", () => {
    const tabs = [tab("active", { agentKind: "claude" }), tab("working"), tab("idle")];
    expect(collectPaneCloseVictims([pane(tabs, "active")], {
      "session-working": { processIsShell: false, outputActive: true },
    })).toEqual([
      { sessionId: "session-active", label: "active", reason: "agent" },
      { sessionId: "session-working", label: "working", reason: "working" },
    ]);
  });

  it("caps the displayed labels at five", () => {
    const victims = collectPaneCloseVictims([pane(["1", "2", "3", "4", "5", "6"].map((id) => tab(id, { agentKind: "codex" })))] , {});
    expect(paneCloseImpactMessage(victims)).toContain("ほか 1 件");
  });
});
