// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as attachments from "../../src/lib/tearout/sessionAttachment";

const native = vi.hoisted(() => ({ invoke: vi.fn(), next: 0, send: vi.fn(), live: new Set<string>(),
  contexts: new Map<string, any>(), channels: new Map<string, any>(), spawns: 0, events: [] as string[] }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {}, emitTo: async () => {} }));
vi.mock("../../src/lib/windowContext", () => ({ windowLabel: () => "main", hasWindowRole: () => true, setWindowRole: () => {}, isMainWindow: () => true }));
vi.mock("../../src/lib/tearout/runtime", () => ({
  waitForTearoutReceiver: async () => {}, sendTearoutWorkspaces: native.send,
  visitTearoutLocation: () => {}, isPreOwnershipTearoutRefusal: () => false,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke, Channel: class { id = ++native.next; } }));
function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
// Execute the production async closure itself, including its completion callback.
// Only its surrounding renderer state and transport boundary are supplied here.
function wrapperAttach(createSession: (...args: any[]) => Promise<unknown>, id: string, extra: Record<string, unknown> = {}) {
  const source = readFileSync("src/components/terminal/XTermWrapper.tsx", "utf8");
  const start = source.indexOf("    const attachFrontendChannel = async");
  const end = source.indexOf("    const restartAgent =", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const code = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const scope = { ...attachments, sessionId: id, pumpGeneration: 1, disposed: false, termDisposed: false,
    recoveryLaunch: null, launchParamsRef: { current: {} }, buildLaunchRequest: () => ({ command: "shell", args: [] }),
    createSession, restoreConfirmed: false, ackBatch: vi.fn(), enqueueFrontendBatch: vi.fn(),
    getSessionChannelId: () => 7, ownedChannelId: undefined, streamHealth: { attached: vi.fn() },
    frontendChannelReady: false, term: null, registerReadAuthority: vi.fn(),
    consumeCodexRestoreReason: vi.fn(), consumeHandoffLaunchEnv: vi.fn(),
    lastSentCols: 0, lastSentRows: 0, terminalSizeCache: new Map(), resizeSession: async () => {},
    frontendVisible: null, refreshFrontendVisible: vi.fn(), terminalScrollbackResyncNeeded: new Set(),
    syncDroppedBatchScrollbackIfNeeded: async () => {}, scheduleFrontendResync: vi.fn(), ...extra,
  };
  return new Function("scope", "with (scope) { " + code + "; return attachFrontendChannel; }")(scope) as (cols: number, rows: number) => Promise<void>;
}
beforeEach(() => {
  native.contexts.clear(); native.channels.clear(); native.live.clear(); native.events = []; native.spawns = 0;
  native.send.mockReset();
  Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
  native.invoke.mockImplementation(async (command: string, args: any = {}) => {
    native.events.push(command);
    if (command === "get_session_attachment_contexts") {
      return args.sessionIds.map((session_id: string) => {
        const context = { backend_epoch: "backend", session_id, window_label: args.transferToken ? "receiver" : "main",
          window_incarnation: "window", attachment_epoch: ++native.next, nonce: String(native.next),
          transfer_id: args.transferToken ?? null, transfer_token: args.transferToken ?? null,
          existing_only: args.existingOnly || native.live.has(session_id) };
        native.contexts.set(session_id, context); return context;
      });
    }
    if (command === "create_session" || command === "tearout_attach") {
      const context = args.attachmentContext;
      if (!attachments.sameAttachmentContext(context, native.contexts.get(args.sessionId))) throw new Error("attachment_context_stale");
      if (!native.live.has(args.sessionId)) {
        if (context.existing_only) throw new Error("tearout_session_not_alive");
        native.live.add(args.sessionId); native.spawns++;
      }
      if (!args.backgroundOnly) native.channels.set(args.sessionId, args.onData);
      return context;
    }
    if (command === "is_session_alive") return native.live.has(args.sessionId);
    if (command === "open_workspace_window") return "receiver";
    if (command === "tearout_phase" && args.phase === "rolled_back") { native.contexts.clear(); native.channels.clear(); }
    return undefined;
  });
});
it("A04 rejects an old real XTermWrapper success after a new expectation is registered", async () => {
  const id = "pty-a04-baseline";
  const old = attachments.expectTearoutAttachments([id]);
  const gate = deferred();
  const create = vi.fn(async (...args: any[]) => {
    await gate.promise;
    return { context: await args[9]?.attachment?.context, channelId: 7 };
  });
  const run = wrapperAttach(create, id)(80, 24);
  await vi.waitFor(() => expect(create).toHaveBeenCalledOnce(), { timeout: 10000 });
  const current = attachments.expectTearoutAttachments([id]);
  let resolved = false;
  void current.ready.then(() => { resolved = true; }, () => {});
  gate.resolve(); await run; await Promise.resolve();
  expect(resolved, "old completion must not resolve the new attachment expectation").toBe(false);
  old.dispose(); current.dispose();
});

import * as ipc from "../../src/lib/ipc";
import { performWorkspaceWindowMove } from "../../src/lib/workspaceTearOut";
import { installMacTearoutPrewarm } from "../../src/lib/tearout/macPrewarm";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { endTearoutOperation } from "../../src/lib/tearout/operation";
import type { Workspace } from "../../src/types";

afterEach(() => { endTearoutOperation(); });
function emitOutput(id: string, text: string) {
  const data = new TextEncoder().encode(text), frame = new ArrayBuffer(40 + data.length);
  const view = new DataView(frame); new Uint8Array(frame).set([77, 67, 88, 49]);
  for (const [at, value] of [[8, 1], [16, 1], [24, 0], [32, data.length]]) view.setBigUint64(at, BigInt(value), true);
  new Uint8Array(frame, 40).set(data); native.channels.get(id).onmessage(frame);
}
function actualAttach(id: string, received: string[] = []) {
  return wrapperAttach(ipc.createSession, id, { getSessionChannelId: ipc.getSessionChannelId,
    enqueueFrontendBatch: (batch: ipc.FrontendDataBatch) => received.push(new TextDecoder().decode(batch.data)) });
}
it.each(["success", "failure"] as const)("A04 old IPC %s and dispose preserve the new actual wrapper channel", async outcome => {
  const id = "pty-a04-" + outcome; native.live.add(id);
  const original = native.invoke.getMockImplementation()!;
  const release = deferred<attachments.AttachmentContext>(); let oldChannel: any, oldContext: attachments.AttachmentContext;
  native.invoke.mockImplementation(async (command: string, args: any) => {
    if (command === "tearout_attach" && !oldChannel) { oldChannel = args.onData; oldContext = args.attachmentContext; return release.promise; }
    return original(command, args);
  });
  const old = attachments.expectTearoutAttachments([id]);
  const oldRun = actualAttach(id)(80, 24).catch(error => error);
  await vi.waitFor(() => expect(oldChannel).toBeDefined(), { timeout: 10000 });
  const current = attachments.expectTearoutAttachments([id]);
  let rejected = false; void current.ready.catch(() => { rejected = true; });
  const received: string[] = []; const currentRun = actualAttach(id, received)(80, 24);
  if (outcome === "success") release.resolve(oldContext!); else release.reject(new Error("old failure"));
  await oldRun; await currentRun; await current.ready;
  const channelId = ipc.getSessionChannelId(id);
  expect(channelId).toBeDefined(); expect(channelId).not.toBe(oldChannel.id);
  old.dispose();
  ipc.retireSessionAttachment(id, { context: oldContext!, channelId: oldChannel.id });
  expect(ipc.getSessionChannelId(id)).toBe(channelId);
  expect(ipc.getSessionChannelId(id, oldContext!)).toBeUndefined();
  emitOutput(id, "current-output");
  expect(received).toEqual(["current-output"]); expect(rejected).toBe(false);
  current.dispose();
});
it("A03 ordinary mounts require backend contexts and do not duplicate a newly created PTY", async () => {
  const id = "pty-normal"; await actualAttach(id)(80, 24); await actualAttach(id)(80, 24);
  expect(native.spawns).toBe(1);
  const calls = native.invoke.mock.calls.filter(([command]) => command === "create_session");
  expect(calls).toHaveLength(2);
  expect(calls.every(([, args]) => Boolean((args as any).attachmentContext?.nonce))).toBe(true);
  expect(calls.map(([, args]) => (args as any).attachmentContext.attachment_epoch)[1])
    .toBeGreaterThan((calls[0][1] as any).attachmentContext.attachment_epoch);
});
it("A04 a mismatched native response cannot publish an active channel or resolve a receipt", async () => {
  const id = "pty-wrong-response"; native.live.add(id);
  const original = native.invoke.getMockImplementation()!;
  native.invoke.mockImplementation(async (command: string, args: any) => command === "tearout_attach"
    ? { ...args.attachmentContext, nonce: "wrong" } : original(command, args));
  const lease = attachments.expectTearoutAttachments([id]);
  await expect(actualAttach(id)(80, 24)).rejects.toBeInstanceOf(ipc.SessionClosedError);
  await expect(lease.ready).rejects.toBeInstanceOf(ipc.SessionClosedError);
  expect(ipc.getSessionChannelId(id)).toBeUndefined(); lease.dispose();
});
function workspace(ids: string[]): Workspace {
  return { id: "source", name: "source", status: "running", createdAt: 1, gridTemplateId: "1x1",
    panes: [{ id: "pane", agentId: "shell", sessionId: ids[0], activeTabId: "tab-0",
      tabs: ids.map((sessionId, index) => ({ id: "tab-" + index, sessionId, agentId: "shell", type: "terminal" })) }] };
}

it.each(["Win32", "MacIntel"])("A05 actual ordinary detach confirm restores all live streams and fences callbacks through the next move on %s with the feature off", async platform => {
  Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
  useSettingsStore.setState({ nativePaneTearoutEnabled: false });
  const ids = ["pty-restore-" + platform, "pty-hidden-" + platform], stopped = "pty-stopped-" + platform;
  ids.forEach(id => native.live.add(id));
  const original = workspace([...ids, stopped]);
  useWorkspaceListStore.setState({ workspaces: [original], activeWorkspaceId: original.id });
  const oldGates = [deferred(), deferred()];
  let oldLease!: ReturnType<typeof attachments.expectTearoutAttachments>, late: Promise<void>[] = [];
  native.send.mockImplementation(async (_label: string, _configs: unknown, live: string[], _selection: unknown, token: string) => {
    expect(live.sort()).toEqual([...ids].sort());
    oldLease = attachments.expectTearoutAttachments(ids, "transfer", undefined, token);
    await oldLease.prepared;
    late = oldGates.map(gate => wrapperAttach(async (...args) => {
      const context = await args[9].attachment.context;
      await gate.promise; return { context, channelId: 7 };
    }, ids[0])(80, 24));
    throw new Error("synthetic-receipt-failure");
  });
  const received = new Map(ids.map(id => [id, [] as string[]]));
  let restoredMounts: Promise<void>[] = [], restored = false;
  const unsubscribe = useWorkspaceListStore.subscribe(state => {
    if (!restored && state.workspaces.some(ws => ws.id === original.id)
      && ids.every(attachments.hasTearoutSessionAttachment)) {
      restored = true; restoredMounts = ids.map(id => actualAttach(id, received.get(id)!)(80, 24));
    }
  });
  const execution = { assertSource: () => {}, mark: vi.fn(), result: vi.fn() };
  try {
    await expect(performWorkspaceWindowMove({ operationId: "move-" + platform, source: { kind: "workspace", workspaceId: original.id },
      destination: { kind: "window" }, expected: { owners: [] } } as any, execution as any, {}))
      .rejects.toThrow("synthetic-receipt-failure");
    await Promise.all(restoredMounts);
    expect(restored).toBe(true);
    expect(native.events.indexOf("tearout_phase")).toBeGreaterThan(-1);
    ids.forEach(id => emitOutput(id, "after-restore"));
    oldGates[0].resolve(); await late[0];
    expect(native.spawns).toBe(0);
    expect(useWorkspaceListStore.getState().workspaces[0].panes[0].tabs.map(tab => tab.sessionId)).toEqual([...ids, stopped]);
    expect(attachments.isTearoutSessionDormant(stopped)).toBe(true);
    const next = attachments.expectTearoutAttachments(ids, "transfer", undefined, "next-" + platform);
    await next.prepared; let ready = false; void next.ready.then(() => { ready = true; }, () => {});
    oldLease.dispose(); oldGates[1].resolve(); await late[1]; expect(ready).toBe(false);
    await Promise.all(ids.map(id => actualAttach(id, received.get(id)!)(80, 24))); await next.ready;
    ids.forEach(id => emitOutput(id, "next-move"));
    expect([...received.values()]).toEqual(ids.map(() => ["after-restore", "next-move"]));
    expect(native.spawns).toBe(0); next.dispose();
  } finally { unsubscribe(); oldLease?.dispose(); }
}, 15000);
it("A03/A05 actual Mac prewarm obtains authority, attaches every live candidate, and leaves dormant tabs stopped", async () => {
  Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
  const ids = ["pty-warm-one", "pty-warm-two"], stopped = "pty-warm-stopped";
  ids.forEach(id => native.live.add(id));
  useWorkspaceListStore.setState({ workspaces: [workspace([...ids, stopped])], activeWorkspaceId: "source" });
  useSettingsStore.setState({ nativePaneTearoutEnabled: true, macNativePaneTearoutEnabled: true });
  const stop = installMacTearoutPrewarm(() => false);
  try {
    await vi.waitFor(() => expect(ids.every(attachments.hasTearoutSessionAttachment)).toBe(true), { timeout: 10000 });
    const received = new Map(ids.map(id => [id, [] as string[]]));
    await Promise.all(ids.map(id => actualAttach(id, received.get(id)!)(80, 24)));
    await vi.waitFor(() => expect(ids.some(attachments.hasTearoutSessionAttachment)).toBe(false), { timeout: 10000 });
    ids.forEach(id => emitOutput(id, "prewarmed"));
    expect([...received.values()]).toEqual([["prewarmed"], ["prewarmed"]]);
    expect(native.spawns).toBe(0); expect(native.channels.has(stopped)).toBe(false);
  } finally { stop(); }
});
