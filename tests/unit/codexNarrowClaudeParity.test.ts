// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error immutable L16 integration module graph
import * as mergedcurrentLive from "codex-merge:src/lib/liveAgentMetadata.ts";
const currentLive: typeof import("../../src/lib/liveAgentMetadata") = mergedcurrentLive;
// @ts-expect-error immutable L16 integration module graph
import * as mergedcurrentLayout from "codex-merge:src/components/layout/SocketListener.tsx";
const currentLayout: typeof import("../../src/components/layout/SocketListener") = mergedcurrentLayout;
// @ts-expect-error immutable L16 integration module graph
import * as mergedcurrentLaunch from "codex-merge:src/lib/terminalPaneLaunch.ts";
const currentLaunch: typeof import("../../src/lib/terminalPaneLaunch") = mergedcurrentLaunch;
// @ts-expect-error immutable L16 integration module graph
import * as mergedcurrentParams from "codex-merge:src/components/terminal/terminalLaunchParams.ts";
const currentParams: typeof import("../../src/components/terminal/terminalLaunchParams") = mergedcurrentParams;
// @ts-expect-error immutable L16 integration module graph
import { useWorkspaceListStore as mergedStore } from "codex-merge:src/stores/workspaceListStore.ts";
const currentStore: typeof import("../../src/stores/workspaceListStore").useWorkspaceListStore = mergedStore;
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import type { PtyMetadata } from "../../src/lib/ipc";
import type { Workspace } from "../../src/types";
// The plugin loads these modules and their dependencies from the fixed base
// Git tree, in an isolated graph; this is not a reimplementation of the oracle.
// @ts-expect-error virtual pinned-base module
import * as pinnedLive from "codex-base:src/lib/liveAgentMetadata.ts";
// @ts-expect-error virtual pinned-base module
import * as pinnedLayout from "codex-base:src/components/layout/SocketListener.tsx";
// @ts-expect-error virtual pinned-base module
import * as pinnedLaunch from "codex-base:src/lib/terminalPaneLaunch.ts";
// @ts-expect-error virtual pinned-base module
import * as pinnedParams from "codex-base:src/components/terminal/terminalLaunchParams.ts";
// @ts-expect-error virtual pinned-base module
import { useWorkspaceListStore as pinnedStore } from "codex-base:src/stores/workspaceListStore.ts";

const mocks = vi.hoisted(() => ({ snapshot: vi.fn() }));
vi.mock("../../src/lib/ipc", async original => ({ ...await original<typeof import("../../src/lib/ipc")>(),
  getPtyMetadataSnapshot: mocks.snapshot,
}));
const A = "11111111-2222-4333-8444-555555555555";
const B = "99999999-8888-4777-8666-555555555555";
type Kind = "claude" | "claude-codex" | "grok";
function workspace(kind: Kind): Workspace {
  return { id: "parity", name: "Parity", gridTemplateId: "1x1", status: "running", createdAt: 1,
    panes: [{ id: "pane", sessionId: "pty", agentId: kind, activeTabId: "tab", cwd: "/fixture",
      tabs: [{ id: "tab", sessionId: "pty", agentId: kind, type: "terminal", cwd: "/fixture", agentKind: kind, agentSessionId: A,
        ...(kind === "grok" ? {} : { claudeSessionId: A }), launchEnv: { MYCMUX_CLAUDE_EFFORT: "high" } }] }], splitColumns: [["pane"]] };
}
function event(kind: Kind, id: string | undefined, trusted: boolean, live = true): PtyMetadata {
  return { session_id: "pty", cwd: "/fixture", agent_active: live, live_agent_kind: live ? kind : null,
    agent_kind: kind, agent_session_id: id, claude_session_id: kind === "grok" ? undefined : id,
    agent_session_trusted: trusted, process_name: live ? kind : "bash", last_log_line: "display only", status: "idle" } as PtyMetadata;
}
beforeEach(() => { vi.clearAllMocks(); vi.spyOn(Date, "now").mockReturnValue(100_000); });
afterEach(() => vi.restoreAllMocks());
describe("ordinary providers execute the pinned base and candidate identically", () => {
  it.each(["claude", "claude-codex", "grok"] as const)("matches fresh/resume/fork/pin/model/effort/prompt recovery and request objects for %s", kind => {
    const base = pinnedParams as typeof currentParams;
    for (const fresh of [false, true]) {
      for (const command of [kind, `C:\\tools\\${kind.toUpperCase()}.CMD`, "node", "bash"]) {
        for (const input of [["--resume", A], ["--session-id", A, "--fork-session"], ["--resume=" + A], ["--model", "fixture-model", "--effort", "high"], ["--", A, "--resume", "prompt data"]]) {
          const params = { command, args: command === "node" ? [`${kind}.js`, ...input] : input,
            cwd: "/fixture", launchEnv: { MYCMUX_RESUME: kind, MYCMUX_SESSION_ID: A, MYCMUX_LAUNCH_MODEL: "fixture-model", MYCMUX_LAUNCH_EFFORT: "high", KEEP: "value" } };
          const old = base.buildAgentRecoveryLaunch(params, kind, B, fresh);
          const next = currentParams.buildAgentRecoveryLaunch(params, kind, B, fresh);
          expect(next).toEqual(old); expect(currentParams.buildLaunchRequest(next)).toEqual(base.buildLaunchRequest(old));
        }
      }
    }
  });
  it.each(["claude", "claude-codex", "grok"] as const)("matches real hydration, metadata, current/frozen config and next launch for %s", async kind => {
    const graphs = [
      { live: pinnedLive as typeof currentLive, layout: pinnedLayout as typeof currentLayout,
        launch: pinnedLaunch as typeof currentLaunch, store: pinnedStore as typeof currentStore },
      { live: currentLive, layout: currentLayout, launch: currentLaunch, store: currentStore },
    ];
    const results = [];
    for (const graph of graphs) {
      usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {}, lastLog: {}, lastLogAt: {} });
      graph.store.getState()._replaceWorkspaces([workspace(kind)]);
      const frozen = structuredClone(workspace(kind));
      const trace = [];
      const take = () => {
        const ws = graph.store.getState().workspaces[0];
        const agents = { getAgent: () => ({ id: kind, name: kind, command: kind === "grok" ? "grok" : "claude", args: [] }),
          getDefaultAgent: () => ({ id: "shell", name: "Shell", command: "bash", args: [] }) };
        trace.push({ current: graph.layout.toConfig(ws), frozen: graph.layout.toConfig(frozen),
          metadata: structuredClone(usePaneMetadataStore.getState().metadata),
          volatile: structuredClone(usePaneMetadataStore.getState().volatileMetadata),
          launch: graph.launch.buildTerminalPaneLaunch(ws.panes[0], ws.panes[0].tabs[0], agents) });
      };
      // No pre-expiry read is inserted. Each graph receives the exact same
      // awaited snapshot and subsequent source/event order, including a stale
      // untrusted B, a trusted B, unknown and a recovered A.
      mocks.snapshot.mockResolvedValue({ pty: event(kind, A, true) });
      await graph.live.hydrateLiveAgents(["pty"]); take();
      for (const input of [event(kind, A, true), event(kind, B, false), event(kind, B, true),
        event(kind, undefined, false, false), event(kind, A, true)]) { graph.live.applyPtyMetadata(input); take(); }
      // Clock-only deadline transition, unknown PID observation, confirmed
      // shell, then first accepted successor B. Both graphs take these exact
      // inputs in this order; no extra validation read is introduced.
      vi.mocked(Date.now).mockReturnValue(110_000);
      graph.live.applyPtyMetadata({ ...event(kind, undefined, false, false), process_name: "unknown" }); take();
      graph.live.applyPtyMetadata(event(kind, undefined, false, false)); take();
      graph.live.applyPtyMetadata(event(kind, B, true)); take();
      results.push(trace);
      vi.mocked(Date.now).mockReturnValue(100_000);
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[0][0].current.panes[0].tabs![0].agent_session_id).toBe(A);
  });
});
