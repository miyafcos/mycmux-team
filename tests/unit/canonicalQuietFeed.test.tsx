// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import traceJson from "../fixtures/canonicalQuietFeed.json";
import type {
  PtyMetadataSnapshot,
  ScrollbackSnapshot,
  SessionOutputSnapshot,
  SessionStatusChangedPayload,
  SessionStatusSnapshotPayload,
} from "../../src/lib/ipc";
import type { PaneTab, Workspace } from "../../src/types";

const transport = vi.hoisted(() => ({
  snapshot: vi.fn(), changed: vi.fn(), metadata: vi.fn(), output: vi.fn(),
  memory: vi.fn(), fragments: vi.fn(), scrollback: vi.fn(), save: vi.fn(), kill: vi.fn(),
}));
vi.mock("../../src/lib/ipc", async (original) => ({
  ...await original<typeof import("../../src/lib/ipc")>(),
  getSessionStatusSnapshot: transport.snapshot,
  onSessionStatusChanged: transport.changed,
  getPtyMetadataSnapshot: transport.metadata,
  getSessionOutputSnapshot: transport.output,
  getAvailableMemoryMiB: transport.memory,
  getWindowFragments: transport.fragments,
  getSessionScrollback: transport.scrollback,
  saveAgentDormancyRecord: transport.save,
  killSession: transport.kill,
}));

import { scanTabs, type SweepReport } from "../../src/components/layout/tabSweep";
import { __resetHeadlessBufferCacheForTests } from "../../src/components/terminal/headlessBuffer";
import { liveTerms, terminalSizeCache } from "../../src/components/terminal/terminalCache";
import { useAgentDormancy } from "../../src/hooks/useAgentDormancy";
import { clearSessionFrontendActivity, DEFAULT_DORMANCY_PRESSURE_SETTINGS } from "../../src/lib/agentDormancy";
import { AGENT_DORMANCY_REVIEW_EVENT, useAgentDormancyStore } from "../../src/stores/agentDormancyStore";
import { useAskQuestionStore } from "../../src/stores/askQuestionStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useSavepointDragStore } from "../../src/stores/savepointDragStore";
import { connectSessionAttentionStore, isAttentionUnseen, useSessionAttentionStore } from "../../src/stores/sessionAttentionStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";

interface TraceStep {
  at: number;
  frames: SessionStatusChangedPayload[];
  output_snapshot: SessionOutputSnapshot;
}
interface QuietFeedTrace {
  origin_ms: number;
  initial: SessionStatusSnapshotPayload;
  initial_output_snapshot: SessionOutputSnapshot;
  steps: TraceStep[];
}

// Real request-3 serde output at 1f1bf857a, raw SHA256 25bc6992bc689ea8...
// Only its random server_epoch was normalized. No UI state or clock is repaired here.
const trace = traceJson as QuietFeedTrace;
const blockers = ["input-peer", "approval-peer", "error-peer", "rate-limit-peer"];
const quietIds = ["quiet-agent", "quiet-shell"];
const originalSettings = useSettingsStore.getState();
let changed: (payload: SessionStatusChangedPayload) => void;
let outputs: SessionOutputSnapshot;
let disconnect: (() => void) | undefined;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
let unlisten: ReturnType<typeof vi.fn>;

function stepAt(elapsed: number): TraceStep {
  const step = trace.steps.find((item) => item.at === trace.origin_ms + elapsed);
  if (!step) throw new Error(`Missing captured checkpoint ${elapsed}`);
  return step;
}

function tabFor(sessionId: string, index: number): PaneTab {
  const shell = sessionId === "quiet-shell" || sessionId === "unknown-peer";
  return {
    id: `${sessionId}-tab`, sessionId, type: "terminal", agentId: shell ? "shell" : "claude",
    ...(shell ? {} : {
      agentKind: "claude" as const,
      agentSessionId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    }),
  };
}

function setRuntimeSeats(): void {
  const tabs = trace.initial.sessions.map((session, index) => tabFor(session.session_id, index));
  const metadata: PtyMetadataSnapshot = {};
  for (const tab of tabs) {
    metadata[tab.sessionId] = {
      session_id: tab.sessionId, cwd: "/project",
      process_name: tab.agentKind ? "claude" : "zsh",
      process_status: tab.agentKind ? "working" : "idle",
      process_status_at: trace.origin_ms, agent_active: Boolean(tab.agentKind),
      ...(tab.agentKind ? { agent_kind: tab.agentKind, agent_session_id: tab.agentSessionId } : {}),
    };
  }
  transport.metadata.mockResolvedValue(metadata);
  const workspaces: Workspace[] = ["visible", "background"].map((id) => {
    const seats = tabs.filter((tab) => (tab.sessionId === "unknown-peer") === (id === "visible"));
    const active = id === "background" ? seats.find((tab) => tab.sessionId === "quiet-agent")! : seats[0];
    return {
      id, name: id, gridTemplateId: "1x1", status: "running", createdAt: trace.origin_ms,
      panes: [{ id: `${id}-pane`, agentId: active.agentId, sessionId: active.sessionId,
        tabs: seats, activeTabId: active.id }],
    };
  });
  useWorkspaceListStore.setState({ workspaces, activeWorkspaceId: "visible" });
  useUiStore.setState({ activePaneId: "unknown-peer" });
}

async function advanceTo(at: number): Promise<void> {
  expect(at).toBeGreaterThanOrEqual(Date.now());
  await vi.advanceTimersByTimeAsync(at - Date.now());
  expect(Date.now()).toBe(at);
}

async function replay(step: TraceStep): Promise<void> {
  await advanceTo(step.at);
  outputs = step.output_snapshot;
  for (const frame of step.frames) changed(frame);
}

function assertProtectedPeers(): void {
  const state = useSessionAttentionStore.getState();
  for (const id of [...blockers, "done-peer", "keeper"]) {
    const original = trace.initial.sessions.find((session) => session.session_id === id)!;
    expect(state.attentionBySession[id]).toMatchObject({
      sessionEpoch: original.status.session_epoch, sessionRevision: original.session_revision,
      uiState: original.status.ui_state, kind: original.status.attention.kind,
      attentionId: original.status.attention.attention_id, detail: original.status.attention.detail,
      stateSince: original.status.attention.state_since,
    });
  }
  expect(isAttentionUnseen("done-peer-tab", state.attentionBySession["done-peer"], state.seenAttentionByTab)).toBe(true);
  expect(state.doneMarkByTab.size).toBe(0);
  expect(state.dormantCompletionsBySession).toEqual({});
}

function sweepTab(report: SweepReport, sessionId: string) {
  return report.tabs.find((tab) => tab.sessionId === sessionId)!;
}

function nextDormancySweep(): Promise<void> {
  const previous = useAgentDormancyStore.getState().proposals;
  return new Promise((resolve) => {
    const unsubscribe = useAgentDormancyStore.subscribe((state) => {
      if (state.proposals !== previous) { unsubscribe(); resolve(); }
    });
  });
}

async function reviewDormancy(): Promise<void> {
  await act(async () => {
    const completed = nextDormancySweep();
    window.dispatchEvent(new Event(AGENT_DORMANCY_REVIEW_EVENT));
    await completed;
  });
}

function DormancyHarness() { useAgentDormancy(true); return null; }

beforeEach(() => {
  // Keep native parser/crypto callbacks real; advance only the scenario's clock
  // and the production interval. Never shorten the ten-minute sweep cadence.
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(trace.origin_ms);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", webcrypto);
  localStorage.clear();
  vi.resetAllMocks();
  __resetHeadlessBufferCacheForTests(); liveTerms.clear(); terminalSizeCache.clear();
  useSessionAttentionStore.getState().resetForTests();
  useAskQuestionStore.getState().resetForTests();
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} });
  useSavepointDragStore.setState({ item: null });
  useAgentDormancyStore.setState({ sampled: false, proposals: [], approvals: {} });
  useSettingsStore.setState({ dormancyPressureSettings: { ...DEFAULT_DORMANCY_PRESSURE_SETTINGS },
    dormancyAllowUnreadCompletion: false });
  for (const session of trace.initial.sessions) clearSessionFrontendActivity(session.session_id);
  outputs = trace.initial_output_snapshot;
  unlisten = vi.fn();
  transport.changed.mockImplementation(async (callback) => { changed = callback; return unlisten; });
  transport.snapshot.mockResolvedValue(trace.initial);
  transport.output.mockImplementation(async () => outputs);
  transport.memory.mockResolvedValue(512);
  transport.fragments.mockResolvedValue([]);
  transport.scrollback.mockImplementation(async (id: string): Promise<ScrollbackSnapshot> => {
    const data = new TextEncoder().encode(id === "quiet-shell" ? "$ \r\n" : "Stable reply\r\n❯ \r\n");
    return { data, startOffset: 0, endOffset: data.byteLength, sessionEpoch: 1, sizeRevision: 1,
      cols: 80, rows: 24, isDelta: false };
  });
  setRuntimeSeats();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined; host?.remove(); host = undefined;
  disconnect?.(); disconnect = undefined;
  useSettingsStore.setState(originalSettings);
  __resetHeadlessBufferCacheForTests(); liveTerms.clear(); terminalSizeCache.clear();
  for (const session of trace.initial.sessions) clearSessionFrontendActivity(session.session_id);
  vi.useRealTimers(); vi.unstubAllGlobals();
});

describe("actual quiet worker feed into unchanged frontend consumers", () => {
  it("connects Working → Idle → Working and the default sweep without losing attention or epoch ordering", async () => {
    disconnect = await connectSessionAttentionStore();
    expect(transport.changed.mock.invocationCallOrder[0]).toBeLessThan(transport.snapshot.mock.invocationCallOrder[0]);
    const initial = await scanTabs();
    for (const id of quietIds) {
      expect(useSessionAttentionStore.getState().attentionBySession[id].uiState).toBe("working");
      expect(sweepTab(initial, id).lockReasons).toEqual(["recent_output", "attention"]);
    }
    const idleFrames = stepAt(60_000).frames;
    for (const step of trace.steps) {
      await replay(step);
      const report = await scanTabs(); // No supplied source or protectedSessionIds.
      expect(report.scannedAt).toBe(step.at);
      for (const id of quietIds) {
        expect(sweepTab(report, id).lastOutputAt).toBe(step.output_snapshot[id]);
        if (step.at < trace.origin_ms + 60_000) {
          expect(sweepTab(report, id).lockReasons).toContain("attention");
        } else if (step.at < trace.origin_ms + 360_002) {
          expect(useSessionAttentionStore.getState().attentionBySession[id]).toMatchObject({ uiState: "idle", kind: "none", sessionRevision: 3 });
          expect(sweepTab(report, id).lockReasons).toEqual(step.at <= trace.origin_ms + 300_000 ? ["recent_output"] : []);
          expect(sweepTab(report, id).category).toBe(step.at <= trace.origin_ms + 300_000 ? "LOCKED" : "CANDIDATE");
        }
      }
      for (const id of [...blockers, "keeper"]) {
        expect(sweepTab(report, id).category).toBe("LOCKED");
        expect(sweepTab(report, id).lockReasons).toContain("attention");
      }
      if (step.at === trace.origin_ms + 360_002) {
        for (const id of quietIds) {
          expect(useSessionAttentionStore.getState().attentionBySession[id]).toMatchObject({ uiState: "working", sessionRevision: 4 });
          expect(sweepTab(report, id).lockReasons).toEqual(["recent_output", "attention"]);
        }
      }
      if (step.at >= trace.origin_ms + 360_003 && step.at <= trace.origin_ms + 360_004) {
        expect(useSessionAttentionStore.getState().attentionBySession["quiet-agent"]).toMatchObject({ uiState: "waiting", kind: "approval", sessionEpoch: 1 });
      }
      if (step.frames.length) {
        const current = useSessionAttentionStore.getState();
        expect(current.lastSeq).toBe(step.frames.at(-1)!.seq);
        for (const frame of idleFrames) changed(frame); // Actual stale redelivery, without rewriting seq/revision.
        expect(useSessionAttentionStore.getState()).toBe(current);
      }
      assertProtectedPeers();
    }
    const recreated = useSessionAttentionStore.getState();
    expect(recreated.attentionBySession["quiet-agent"]).toMatchObject({ sessionEpoch: 2, sessionRevision: 7, uiState: "working", kind: "none", attentionId: null });
    for (const elapsed of [360_003, 360_004]) for (const frame of stepAt(elapsed).frames) changed(frame);
    expect(useSessionAttentionStore.getState()).toBe(recreated);
    expect(transport.kill).not.toHaveBeenCalled();
  });

  it("buffers the captured autonomous Idle deltas while the real initial snapshot is loading", async () => {
    transport.snapshot.mockImplementation(async () => {
      await replay(stepAt(60_000));
      expect(useSessionAttentionStore.getState().attentionBySession).toEqual({});
      return trace.initial;
    });
    disconnect = await connectSessionAttentionStore();
    const state = useSessionAttentionStore.getState();
    expect(state.serverEpoch).toBe(trace.initial.server_epoch);
    expect(state.lastSeq).toBe(23);
    const report = await scanTabs();
    for (const id of quietIds) {
      expect(state.attentionBySession[id]).toMatchObject({ uiState: "idle", sessionRevision: 3, kind: "none" });
      expect(sweepTab(report, id).lockReasons).toEqual(["recent_output"]);
    }
    assertProtectedPeers();
  });

  it("mounts dormancy, naturally observes five idle minutes, and proposes only the quiet resumable agent under strong pressure", async () => {
    disconnect = await connectSessionAttentionStore();
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    const initialSweep = nextDormancySweep();
    await act(async () => root!.render(<DormancyHarness />));
    await initialSweep;
    expect(transport.scrollback).not.toHaveBeenCalled();
    for (const step of trace.steps) {
      await act(async () => replay(step));
      // The existing review action samples at captured checkpoints, without
      // changing the normal timer or seeding an artificially old observation.
      await reviewDormancy();
      expect(Date.now()).toBe(step.at);
      const state = useAgentDormancyStore.getState();
      expect(state.sample.availableMemoryMiB).toBe(512);
      if (step.at === trace.origin_ms + 360_001) {
        expect(state.proposals).toEqual([expect.objectContaining({
          sessionId: "quiet-agent", stage: "severe", idleMinutes: 5,
          lastActivityAt: trace.origin_ms + 60_000, processStatusAt: trace.origin_ms,
        })]);
      } else {
        expect(state.proposals).toEqual([]);
      }
      expect(state.approvals).toEqual({});
      expect(transport.kill).not.toHaveBeenCalled();
      expect(transport.save).not.toHaveBeenCalled();
      assertProtectedPeers();
    }
    expect(new Set(transport.scrollback.mock.calls.map(([id]) => id))).toEqual(new Set(["quiet-agent"]));
    expect(useSessionAttentionStore.getState().attentionBySession["quiet-agent"]).toMatchObject({ sessionEpoch: 2, uiState: "working", kind: "none" });
  });
});
