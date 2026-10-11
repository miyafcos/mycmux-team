import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyPtyMetadata, connectLiveAgentHydration } from "../../src/lib/liveAgentMetadata";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { codexRestoreNoticeActive, invalidateCodexRestoreNotice, publishCodexRestoreNoticeEpoch } from "../../src/lib/codexRestoreLifecycle";
import { getPtyMetadataSnapshot, onPtyWorkDone, type PtyMetadata } from "../../src/lib/ipc";
import type { Workspace } from "../../src/types";

const transport = vi.hoisted(() => ({ invoke: vi.fn(), listeners: new Map<string, Array<(event: { payload: unknown }) => void>>() }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: transport.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name: string, callback: (event: { payload: unknown }) => void) => {
  transport.listeners.set(name, [...transport.listeners.get(name) ?? [], callback]);
  return () => transport.listeners.set(name, (transport.listeners.get(name) ?? []).filter(value => value !== callback));
}) }));
let stop: (() => void) | undefined;
beforeEach(() => {
  vi.clearAllMocks(); transport.listeners.clear();
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {}, lastLog: {}, lastLogAt: {} });
});
afterEach(() => { stop?.(); stop = undefined; });
const orders = ["monitor,exit,query", "monitor,query,exit", "exit,monitor,query", "exit,query,monitor", "query,monitor,exit", "query,exit,monitor"];
const cases = orders.flatMap(order => [false, true].map(observed => ({ order, observed })));
it.each(cases)("INTEG-5 rejects retired E1 payloads in $order order; E2 observed=$observed", async ({ order, observed }) => {
  const p = `integ5-${order}-${observed}`;
  const c = "a5a0d2df-1a12-4d9c-b9ae-d49a5daafc01";
  const e1 = 101, e2 = 102;
  const ws: Workspace = { id: p, name: p, createdAt: 1, status: "running", gridTemplateId: "1x1", splitColumns: [[p]],
    panes: [{ id: p, sessionId: p, agentId: "codex", activeTabId: p, tabs: [{ id: p, sessionId: p, agentId: "codex", type: "terminal", agentKind: "codex", agentSessionId: c }] }] };
  useWorkspaceListStore.getState()._replaceWorkspaces([ws]);
  const meta = (epoch: number, birth: number): PtyMetadata & { session_epoch: number } => ({ session_id: p, session_epoch: epoch,
    cwd: "fixture", git_branch: epoch === e1 ? "retired-branch" : "current-branch", process_name: "codex", agent_active: true,
    live_agent_kind: "codex", agent_kind: "codex", agent_session_id: c, agent_session_trusted: true,
    observed_at: Date.now() + (epoch === e1 ? 10_000 : 0), agent_started_at: birth });
  const old = meta(e1, 1000), current = meta(e2, 2000);
  let releaseQuery!: (value: Record<string, PtyMetadata>) => void;
  const heldQuery = new Promise<Record<string, PtyMetadata>>(resolve => { releaseQuery = resolve; });
  transport.invoke.mockImplementation((name: string) => name === "get_pty_metadata_snapshot" ? heldQuery : name === "get_codex_restore_epoch" ? Promise.resolve(e2) : Promise.resolve(null));
  publishCodexRestoreNoticeEpoch(p, e1); applyPtyMetadata(old);
  stop = connectLiveAgentHydration(Promise.resolve());
  await vi.waitFor(() => expect(transport.invoke).toHaveBeenCalledWith("get_pty_metadata_snapshot"));
  const oldWorkDone = vi.fn();
  const stopWorkDone = await onPtyWorkDone(oldWorkDone);
  const deliver = (event: string, payload: unknown): void => { for (const callback of transport.listeners.get(event) ?? []) callback({ payload }); };
  // E1 is logically retired and E2 published while the same P/C/tab remains owned.
  invalidateCodexRestoreNotice(p); deliver("codex-restore-invalidated", { session_id: p });
  publishCodexRestoreNoticeEpoch(p, e2); deliver("codex-restore-published", { session_id: p, session_epoch: e2 });
  if (observed) applyPtyMetadata(current);
  for (const step of order.split(",")) {
    if (step === "monitor") { applyPtyMetadata(old); deliver("pty_work_done", { session_id: p, session_epoch: e1, prev_process: "codex", current_process: "bash" }); }
    if (step === "exit") { deliver(`pty-exit-${p}`, { session_epoch: e1 }); deliver(`pty-exit-${p}`, null); }
    if (step === "query") releaseQuery({ [p]: old });
    await Promise.resolve(); await Promise.resolve();
  }
  await vi.waitFor(() => expect(usePaneMetadataStore.getState().volatileMetadata[p]?.ptyAlive).toBe(true));
  const live = usePaneMetadataStore.getState().volatileMetadata[p];
  expect(live.liveAgentStartedAt).not.toBe(1000);
  expect(live.liveAgentKind).toBe(observed ? "codex" : null);
  if (observed) expect(live.liveAgentStartedAt).toBe(2000);
  stopWorkDone();
  expect(oldWorkDone).not.toHaveBeenCalled();
  expect(codexRestoreNoticeActive(p, e1)).toBe(false);
  expect(codexRestoreNoticeActive(p, e2)).toBe(true);
});

// The shared query consumer also serves delegation/dormancy/close/sweep callers.
it.each(["retired", "missing"])("INTEG-5 shared snapshot rejects a delayed %s E1 response without declaring E2 dead", async response => {
  const p = `integ5-shared-${response}`;
  const workspace: Workspace = { id: p, name: p, createdAt: 1, status: "running", gridTemplateId: "1x1", splitColumns: [[p]],
    panes: [{ id: p, sessionId: p, agentId: "codex", activeTabId: p, tabs: [{ id: p, sessionId: p, agentId: "codex", type: "terminal", agentKind: "codex", agentSessionId: "a5a0d2df-1a12-4d9c-b9ae-d49a5daafc01" }] }] };
  useWorkspaceListStore.getState()._replaceWorkspaces([workspace]);
  publishCodexRestoreNoticeEpoch(p, 201);
  let release!: (value: Record<string, PtyMetadata>) => void;
  transport.invoke.mockReturnValue(new Promise<Record<string, PtyMetadata>>(resolve => { release = resolve; }));
  const held = getPtyMetadataSnapshot();
  await vi.waitFor(() => expect(transport.invoke).toHaveBeenCalledWith("get_pty_metadata_snapshot"));
  invalidateCodexRestoreNotice(p); publishCodexRestoreNoticeEpoch(p, 202);
  release(response === "missing" ? {} : { [p]: { session_id: p, session_epoch: 201, cwd: "old", process_name: "codex", live_agent_kind: "codex", agent_started_at: 1000 } });
  const current = (await held)[p];
  expect(current?.session_epoch).toBe(202);
  expect(current?.process_name).toBeUndefined();
  expect(current?.agent_started_at).toBeUndefined();
});

it("INTEG-5 shared snapshot preserves a confirmed current E2 exit", async () => {
  const p = "integ5-current-exit";
  const workspace: Workspace = { id: p, name: p, createdAt: 1, status: "running", gridTemplateId: "1x1", splitColumns: [[p]],
    panes: [{ id: p, sessionId: p, agentId: "codex", activeTabId: p, tabs: [{ id: p, sessionId: p, agentId: "codex", type: "terminal" }] }] };
  useWorkspaceListStore.getState()._replaceWorkspaces([workspace]);
  publishCodexRestoreNoticeEpoch(p, 302);
  transport.invoke.mockResolvedValue({}); // Current owner was already published when this exit query started.
  expect((await getPtyMetadataSnapshot())[p]).toBeUndefined();
});
