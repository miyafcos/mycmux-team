import { beforeEach, describe, expect, it } from "vitest";
import {
  popClosedPane,
  pushClosedPane,
  pushClosedTab,
} from "../../src/stores/closedPaneStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import type { Pane, PaneTab } from "../../src/types";

function drainClosedPanes(): void {
  while (popClosedPane()) {
    // Drain the module-level bounded history between tests.
  }
}

function makeTab(overrides: Partial<PaneTab> = {}): PaneTab {
  return {
    id: "tab-active",
    sessionId: "session-active",
    agentId: "shell-starter",
    type: "terminal",
    ...overrides,
  };
}

function makePane(tabs: PaneTab[], overrides: Partial<Pane> = {}): Pane {
  return {
    id: "pane-1",
    agentId: "shell-starter",
    sessionId: tabs[0]?.sessionId ?? "",
    tabs,
    activeTabId: tabs[0]?.id ?? "",
    ...overrides,
  };
}

beforeEach(() => {
  drainClosedPanes();
  usePaneMetadataStore.setState({ metadata: {}, lastLog: {} });
});

describe("closed tab restore identity", () => {
  it("stores the closed tab's live Codex identity for Ctrl+Shift+T resume", () => {
    const tab = makeTab();
    const pane = makePane([tab]);
    usePaneMetadataStore.getState().setMetadata(tab.sessionId, {
      agentKind: "codex",
      agentSessionId: "codex-session",
      cwd: "C:\\work\\project",
    });

    pushClosedTab(pane, tab);

    expect(popClosedPane()).toEqual({
      cwd: "C:\\work\\project",
      label: null,
      agentKind: "codex",
      agentSessionId: "codex-session",
    });
  });

  it("uses saved tab identity when live metadata is unavailable", () => {
    const tab = makeTab({ agentKind: "claude-codex", agentSessionId: "hybrid-session" });
    pushClosedTab(makePane([tab]), tab);
    expect(popClosedPane()).toMatchObject({
      agentKind: "claude-codex",
      agentSessionId: "hybrid-session",
    });
  });

  it("maps a legacy Claude session id only to Claude", () => {
    const tab = makeTab({ claudeSessionId: "claude-session" });
    pushClosedTab(makePane([tab]), tab);
    expect(popClosedPane()).toMatchObject({
      agentKind: "claude",
      agentSessionId: "claude-session",
    });
  });

  it("does not copy the active pane identity into a different closed tab", () => {
    const active = makeTab({ agentKind: "claude", agentSessionId: "active-session" });
    const background = makeTab({ id: "tab-background", sessionId: "session-background" });
    const pane = makePane([active, background], {
      agentKind: "claude",
      agentSessionId: "active-session",
    });

    pushClosedTab(pane, background);

    expect(popClosedPane()).toMatchObject({ agentKind: null, agentSessionId: null });
  });

  it("uses the same resolver when an active pane is closed", () => {
    const tab = makeTab();
    const pane = makePane([tab]);
    usePaneMetadataStore.getState().setMetadata(tab.sessionId, {
      agentKind: "claude",
      agentSessionId: "shared-session",
    });

    pushClosedPane(pane);

    expect(popClosedPane()).toMatchObject({
      agentKind: "claude",
      agentSessionId: "shared-session",
    });
  });
});
