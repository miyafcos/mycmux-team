// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/components/dashboard/useTranscriptHistory",()=>({useArchiveDescriptor:()=>null}));
vi.mock("../../src/components/dashboard/ChatTranscript",()=>({ChatTranscript:()=>null}));
const receiverMock=vi.hoisted(()=>({fragments:vi.fn()}));
vi.mock("../../src/lib/ipc",async original=>({...await original<typeof import("../../src/lib/ipc")>(),getWindowFragments:receiverMock.fragments}));
import { usePeerWindowTabsStore } from "../../src/components/dashboard/peerWindowTabsStore";
import { peerIndex } from "./fixtures/peerWindowTabs";
import { ChatColumn } from "../../src/components/dashboard/ChatColumn";
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
    vi.useFakeTimers();receiverMock.fragments.mockReset().mockResolvedValue([]);
    Object.defineProperty(document,"hidden",{configurable:true,value:false});
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();vi.useRealTimers();
  });

  it("keeps model and context in the list while cost and sid belong to conversation details", () => {
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
    expect(instrument?.querySelector("[data-instrument-slot='cost']")).toBeNull();
    expect(instrument?.querySelector("[data-instrument-slot='sid']")).toBeNull();
    expect(instrument?.getAttribute("title")).not.toContain("≈$1.23");
    expect(instrument?.getAttribute("title")).not.toContain("sid a1b2c3d4");
  });

  it("disables the jump of a retained peer card when its receiver closes",async()=>{
    const jumpAction=vi.fn();const peerCard={...card(),windowLabel:"mycmux-w2"};
    usePeerWindowTabsStore.getState().acceptIndex(peerIndex("mycmux-w2"));
    receiverMock.fragments.mockResolvedValue([{window_label:"mycmux-w2"}]);
    await act(async()=>root.render(<ChatColumn card={peerCard} events={[]} now={now} active={true} pinned={false} dragging={false} dropPreview={false} motion={null} targetEventId={null} targetEventRequest={0} syntheticSource={null} onActivate={()=>{}} onTogglePin={()=>{}} onClose={()=>{}} onFocusComposer={()=>{}} onJump={jumpAction} onReorderKeyDown={()=>{}}/>));
    const jump=host.querySelector<HTMLButtonElement>("button[aria-label='別の窓の対象タブへ移動']")!;
    expect(jump.disabled).toBe(false);expect(jump.title).toBe(jump.textContent);
    receiverMock.fragments.mockResolvedValue([]);
    await act(async()=>vi.advanceTimersByTimeAsync(3000));
    expect(usePeerWindowTabsStore.getState().index).toHaveLength(1);
    expect(jump.disabled).toBe(true);expect(jump.title).toBe("その窓は閉じています");
    act(()=>jump.click());expect(jumpAction).not.toHaveBeenCalled();
    receiverMock.fragments.mockRejectedValue(new Error("fictional receiver unavailable"));
    await act(async()=>vi.advanceTimersByTimeAsync(3000));
    expect(jump.disabled).toBe(true);expect(jump.title).toContain("確認できません");
    receiverMock.fragments.mockResolvedValue([{window_label:"mycmux-w2",pending:true}]);
    await act(async()=>vi.advanceTimersByTimeAsync(3000));
    expect(jump.disabled).toBe(false);expect(jump.title).toBe(jump.textContent);
    act(()=>jump.click());expect(jumpAction).toHaveBeenCalledTimes(1);
  });

  it("renders cost and conversation ID inside Other and outside the visible chat-header lane",()=>{
    act(()=>root.render(<ChatColumn card={card()} events={[]} now={now} active={true} pinned={false} dragging={false} dropPreview={false} motion={null} targetEventId={null} targetEventRequest={0} syntheticSource={null} onActivate={()=>{}} onTogglePin={()=>{}} onClose={()=>{}} onFocusComposer={()=>{}} onJump={()=>{}} onReorderKeyDown={()=>{}}/>));
    const other=host.querySelector<HTMLDetailsElement>(".cmux-dashboard-chat-details")!;
    expect(other.querySelector("summary")?.textContent).toBe("その他");
    act(()=>{other.open=true;});
    const instrument=other.querySelector("[data-dashboard-instrument='tab-1']")!;
    expect(instrument.textContent).toContain("$1.23");expect(instrument.textContent).toContain("a1b2c3d4");
    const visibleHeader=host.querySelector(".cmux-dashboard-chat-identity")!;
    expect(visibleHeader.textContent).not.toContain("$1.23");expect(visibleHeader.textContent).not.toContain("a1b2c3d4");
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
