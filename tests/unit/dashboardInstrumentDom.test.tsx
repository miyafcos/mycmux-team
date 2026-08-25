// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DashboardCardRow } from "../../src/components/dashboard/DashboardCardRow";
import { MinimapTabChip } from "../../src/components/dashboard/MinimapTabChip";
import { buildDashboardCards, type DashboardCardModel } from "../../src/components/dashboard/dashboardModel";
import type { LiveSessionBrief } from "../../src/lib/livebrief";
import type { Workspace } from "../../src/types";
import "../../src/components/dashboard/DashboardCardRow.css";
import "../../src/components/dashboard/DashboardView.css";
import "../../src/components/dashboard/MinimapPanel.css";

const now = 1_000_000;

function workspace(): Workspace {
  return {
    id: "ws-1",
    name: "Workspace A",
    gridTemplateId: "single",
    status: "active",
    createdAt: now,
    panes: [{
      id: "pane-1",
      sessionId: "s-1",
      activeTabId: "tab-1",
      tabs: [{ id: "tab-1", sessionId: "s-1", agentId: "claude", label: "Alpha", type: "terminal" }],
    }],
  } as Workspace;
}

function brief(): LiveSessionBrief {
  return {
    ptySessionId: "s-1",
    agentSessionId: "old-sid",
    agentKind: "claude",
    ptyInstanceId: "pty-1",
    ptyGeneration: 1,
    sourceRevision: 1,
    ptyInputRevision: 1,
    task: "task",
    latestInstruction: "go",
    taskSourceEventIds: [],
    activityKind: null,
    activityText: null,
    activitySourceEventId: null,
    checkpoint: null,
    checkpointEvidenceEventIds: [],
    pendingInputKind: null,
    pendingPrompt: null,
    pendingOptions: [],
    promptEventId: null,
    promptHash: null,
    eventSeq: 1,
    operationalState: "running",
    telemetryHealth: "live",
    lastEventAt: now,
    lastSuccessfulReadAt: now,
    updatedAt: now,
    serviceEpoch: "epoch",
    briefRevision: 1,
    telemetry: {
      model: { name: "opus-5", effort: "xhigh" },
      context: { pct: 34, tokens: 68_000 },
      cost: { usd: 1.23, source: "computed" },
      turns: { count: 4, compacts: 0 },
    },
  };
}

function card(): DashboardCardModel {
  return buildDashboardCards([workspace()], {
    metadataBySession: { "s-1": { agentSessionId: "a1b2c3d4eeee" } },
    volatileMetadataBySession: {},
    lastLogBySession: {},
    lastLogAtBySession: { "s-1": now },
    attentionBySession: {},
    seenAttentionByTab: new Map(),
    doneMarkByTab: new Map(),
    stallsBySession: {},
    briefsBySession: { "s-1": brief() },
    now,
    hasTerminalBuffer: () => true,
  })[0];
}

describe("dashboard instrument DOM", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("renders cost and sid slots at the default 256px session-list width", () => {
    host.style.width = "256px";
    act(() => {
      root.render(
        <div className="cmux-dash-list" style={{ width: 256 }}>
          <DashboardCardRow
            card={card()}
            selected={false}
            open={false}
            now={now}
            hideWorkspaceBadge={false}
            onSelect={() => {}}
            onJump={() => {}}
          />
        </div>,
      );
    });
    const instrument = host.querySelector("[data-dashboard-instrument='tab-1']");
    expect(instrument).not.toBeNull();
    expect(instrument?.querySelector("[data-instrument-slot='model']")?.textContent).toBe("opus-5 (xhigh)");
    expect(instrument?.querySelector("[data-instrument-slot='context']")?.textContent).toBe("CTX 34%");
    expect(instrument?.querySelector("[data-instrument-slot='cost']")?.textContent).toBe("≈$1.23");
    expect(instrument?.querySelector("[data-instrument-slot='sid']")?.textContent).toBe("sid a1b2c3d4");
    expect(instrument?.getAttribute("title")).toContain("≈$1.23");
    expect(instrument?.getAttribute("title")).toContain("sid a1b2c3d4");
  });

  it("includes CTX percent in the minimap chip accessible name", () => {
    act(() => {
      root.render(
        <MinimapTabChip
          chip={{
            tabId: "tab-1",
            sessionId: "s-1",
            index: 0,
            label: "Alpha",
            typeGlyph: "⌘",
            agentKind: "claude",
            isActiveTab: true,
            isPinned: false,
            declared: false,
            contextPct: 80,
          }}
          workspaceId="ws-1"
          paneId="pane-1"
          selected={false}
          open={false}
          selectedTabIds={new Set()}
          groupPulseTabIds={new Set()}
          displayState="running"
          collapsed={false}
          now={now}
          onSelect={() => {}}
          onSelectGroup={() => {}}
        />,
      );
    });
    const button = host.querySelector("[data-minimap-tab='tab-1']");
    expect(button?.getAttribute("aria-label")).toContain("CTX 80%");
  });
});
