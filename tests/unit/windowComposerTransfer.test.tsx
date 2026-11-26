// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DetachedPaneOrigin, PendingWorkspaceConfig, WorkspaceConfig, WindowFragment } from "../../src/lib/ipc";
import type { PaneMoveExecution } from "../../src/lib/paneMoveOperation";

type Listener = (event: { payload: unknown }) => void;
const bridge = vi.hoisted(() => ({
  label: "main",
  windows: new Map<string, Map<string, Set<Listener>>>(),
  invoke: vi.fn(),
  emitTo: vi.fn(),
  destroy: vi.fn(),
  send: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(), invoke: bridge.invoke,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, callback: Listener, options?: { target?: { label: string } }) => {
    const listeners = bridge.windows.get(options?.target?.label ?? bridge.label);
    if (!listeners) return () => {}; // A target without a mounted mock WebView receives no events.
    if (!listeners.has(name)) listeners.set(name, new Set());
    const callbacks = listeners.get(name)!;
    callbacks.add(callback);
    return () => { callbacks.delete(callback); };
  },
  emit: async (name: string, payload: unknown) => {
    for (const label of bridge.windows.keys()) await bridge.emitTo(label, name, payload);
  },
  emitTo: bridge.emitTo,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getAllWindows: async () => [...bridge.windows.keys()].map(label => ({ label })),
  getCurrentWindow: () => {
    const label = bridge.label;
    return { label, destroy: () => bridge.destroy(label), onCloseRequested: async () => () => {},
      outerPosition: async () => ({ x: 0, y: 0 }), scaleFactor: async () => 1, setTitle: async () => {} };
  },
}));
vi.mock("../../src/components/layout/socketCommands", async original => ({
  ...await original<typeof import("../../src/components/layout/socketCommands")>(), handleSocketCommand: bridge.send,
}));
vi.mock("../../src/components/terminal/XTermWrapper", async original => ({
  ...await original<typeof import("../../src/components/terminal/XTermWrapper")>(),
  default: () => <div className="xterm" />,
}));
vi.mock("../../src/lib/tearout/sessionAttachment", async original => ({
  ...await original<typeof import("../../src/lib/tearout/sessionAttachment")>(),
  expectTearoutAttachments: () => ({ prepared: Promise.resolve(), ready: Promise.resolve(), dispose: vi.fn() }),
  rememberTearoutDormantSessions: vi.fn(),
}));

const sessionId = "pty-original";
const message = "Keep this unsent message";
const workspace: WorkspaceConfig = {
  id: "moved", name: "Moved tab", created_at: 1, grid_template_id: "1x1",
  panes: [{
    pane_id: "moved-pane", agent_id: "shell", session_id: sessionId, active_tab_id: "moved-tab",
    tabs: [{ tab_id: "moved-tab", agent_id: "shell", session_id: sessionId, type: "terminal" }],
  }],
};
const target = { command: "claude", agentKind: "claude" as const };
const settings = { schema_version: 1, theme_id: "default", font_size: 14, line_height: 1.2, font_family: "monospace" };

let nextWindow: string;
let publishHook: ((fragment: WindowFragment) => Promise<void>) | undefined;
const published = new Map<string, WindowFragment>();
const pending = new Map<string, PendingWorkspaceConfig[]>();
const transfers = new Map<string, { receiver: string; source: string }>();
const cleanup: (() => void | Promise<void>)[] = [];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("__MYCMUX_WORKSPACE_CREATION_ID__", undefined);
  nextWindow = "mycmux-w2";
  publishHook = undefined;
  published.clear();
  pending.clear();
  transfers.clear();
  bridge.windows.clear();
  sessionStorage.clear();
  vi.resetAllMocks();
  bridge.emitTo.mockImplementation(async (label: string, event: string, payload: unknown) => {
    // Geometry approval is established by the native drag in production. These
    // tests exercise the ownership transfer after that approval.
    const received = event === "mycmux://tearout-delivery" ? { ...payload as object, approval: undefined } : payload;
    for (const listener of bridge.windows.get(label)?.get(event) ?? []) listener({ payload: structuredClone(received) });
  });
  bridge.invoke.mockImplementation(async (command: string, args) => {
    switch (command) {
      case "is_session_alive": return true;
      case "get_app_settings": return settings;
      case "load_persistent_data": return { supported: true, schemaVersion: 1, data: { schema_version: 1, workspaces: [], settings } };
      case "get_window_fragments":
      case "list_running_session_ids":
      case "list_pets": return [];
      case "get_pty_metadata_snapshot":
      case "read_agent_session_mappings": return {};
      case "take_pending_adoption": {
        const configs = pending.get(args.label) ?? [];
        if (args.confirmDockAdoptions) {
          const confirmed: string[] = [];
          pending.set(args.label, configs.filter(config => {
            const token = config.detached_dock_receipt?.token;
            if (!token || !args.confirmDockAdoptions.includes(token)) return true;
            confirmed.push(token);
            return false;
          }));
          return confirmed;
        }
        pending.set(args.label, configs.filter(config => config.detached_dock_receipt));
        return configs;
      }
      case "publish_window_fragment": {
        const fragment: WindowFragment | undefined = args.fragment;
        if (!fragment) return 0;
        await publishHook?.(fragment);
        published.set(fragment.window_label, fragment);
        return;
      }
      case "set_window_close_intent":
        if (args.destroy) await bridge.destroy(bridge.label);
        return;
      case "open_workspace_window":
        window.__MYCMUX_WORKSPACE_CREATION_ID__ = args.creationId;
        return nextWindow;
      case "tearout_prepare":
        transfers.set(args.id, { receiver: args.receiver, source: bridge.label });
        return;
      case "tearout_finalize": {
        const move = transfers.get(args.id)!;
        await bridge.emitTo(move.receiver, "mycmux://tearout-finalize", { token: args.token, source: move.source });
        return;
      }
      case "tearout_retire":
        if (args.finalizeLabel) await bridge.emitTo(args.finalizeLabel, "mycmux://tearout-finalize", {
          token: args.finalizeToken, source: args.label,
        });
        await bridge.destroy(args.label);
        return;
      case "release_workspaces": {
        const configs = published.get(args.fromLabel)?.workspaces.filter(config => args.workspaceIds.includes(config.id)) ?? [];
        pending.set(args.toLabel, configs.map(config => args.composerSends?.length
          ? { ...config, detached_dock_receipt: { token: crypto.randomUUID(), sends: args.composerSends } }
          : config));
        await bridge.emitTo(args.toLabel, "mycmux://window-adopt", {
          from_label: args.fromLabel, to_label: args.toLabel, workspace_ids: args.workspaceIds,
        });
        return configs.length;
      }
    }
  });
});

afterEach(async () => {
  for (const stop of cleanup.reverse()) {
    await act(async () => { await stop(); });
  }
  cleanup.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function openView(label: string, withPersistence = false) {
  vi.resetModules();
  bridge.label = label;
  bridge.windows.set(label, new Map());
  const { windowLabel } = await import("../../src/lib/windowContext");
  expect(windowLabel()).toBe(label);
  const runtime = await import("../../src/lib/tearout/runtime");
  const socket = await import("../../src/components/layout/SocketListener");
  const ipc = await import("../../src/lib/ipc");
  const { PaneComposer } = await import("../../src/components/composer/PaneComposer");
  const { useComposerStore } = await import("../../src/stores/composerStore");
  const { useWorkspaceListStore } = await import("../../src/stores/workspaceListStore");
  const { restoreWorkspaceConfigs } = await import("../../src/lib/workspaceRestore");
  const { performWorkspaceWindowMove } = await import("../../src/lib/workspaceTearOut");
  const { createPaneMoveRequest, executePaneMove } = await import("../../src/lib/paneMoveOperation");
  const { useSettingsStore } = await import("../../src/stores/settingsStore");
  useSettingsStore.setState({ nativePaneTearoutEnabled: false, macNativePaneTearoutEnabled: false });
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  function Persist() { socket.useWorkspacePersist(); return null; }
  if (withPersistence) {
    await act(async () => root.render(<Persist />));
  } else {
    const stop = runtime.installTearoutRuntime({
      serialize: socket.toTransferConfig,
      publish: () => ipc.publishWindowFragment(socket.buildWindowFragment("transfer")),
    });
    cleanup.push(stop);
  }
  cleanup.push(async () => { root.unmount(); host.remove(); });
  return {
    label, host, root, socket, runtime, restoreWorkspaceConfigs,
    // The move executor's dynamic imports resolve in the latest test module
    // graph. Call its actual workspace transport in the source's graph.
    moveWorkspace: async (detachedFrom?: DetachedPaneOrigin) => {
      const request = createPaneMoveRequest({ kind: "workspace", workspaceId: workspace.id, label: "" },
        { kind: "window", detachedFrom });
      const execution: PaneMoveExecution = {
        assertSource: () => { expect(useWorkspaceListStore.getState().getWorkspace(workspace.id)).toBeDefined(); },
        mark: vi.fn(),
        result: (status, reason) => ({ operationId: request.operationId, status, reason, receipt: "pending", phase: "requested" }),
      };
      const result = await performWorkspaceWindowMove(request, execution, {});
      expect(result.status, result.reason).toBe("moved");
    },
    composer: useComposerStore, list: useWorkspaceListStore,
    executeWorkspace: () => executePaneMove(createPaneMoveRequest({ kind: "workspace", workspaceId: workspace.id, label: "" }, { kind: "window" })),
    publish: () => ipc.publishWindowFragment(socket.buildWindowFragment("transfer")),
    showComposer: async () => act(async () => root.render(<>
      {withPersistence && <Persist />}<PaneComposer sessionId={sessionId} target={target} />
    </>)),
  };
}
type View = Awaited<ReturnType<typeof openView>>;

function recoveryButton(view: View, text = "下書きに戻す") {
  return [...view.host.querySelectorAll("button")].find(button => button.textContent?.trim() === text);
}
async function recover(view: View) {
  await view.showComposer();
  const button = recoveryButton(view);
  expect(button).toBeDefined();
  await act(async () => button!.click());
  expect(view.host.querySelector("textarea")?.value).toBe(message);
}
async function beginSend(view: View) {
  let reject!: (reason: Error) => void;
  bridge.send.mockReturnValue(new Promise((_, fail) => { reject = fail; }));
  await act(async () => view.composer.getState().setDraft(sessionId, message));
  await view.showComposer();
  await act(async () => view.host.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(bridge.send).toHaveBeenCalledTimes(1);
  return () => reject(new Error("synthetic failure before the write"));
}
function dock(source: View, receiver: View) {
  return bridge.emitTo(source.label, "mycmux://tearout-outgoing", {
    token: "dock-result", deliveryToken: "dock-body", requester: source.label,
    approval: { receiver: receiver.label, token: "drop", target: { kind: "workspace" } },
  });
}

it.each(["dock", "workspace"])("recovers the failed send when publication blocks %s delivery", async mode => {
  const source = await openView("main");
  source.restoreWorkspaceConfigs([workspace]);
  const failSend = await beginSend(source);
  const receiver = await openView(nextWindow);
  bridge.label = source.label;
  const allowPublication = deferred();
  let publicationStarted = false;
  publishHook = async fragment => {
    if (fragment.window_label === source.label && fragment.workspaces.length === 0) {
      publicationStarted = true;
      await allowPublication.promise;
    }
  };
  let move: Promise<{ error?: unknown }> | undefined;
  try {
    await act(async () => {
      move = (mode === "dock" ? dock(source, receiver) : source.moveWorkspace())
        .then(() => ({}), error => ({ error }));
      await vi.waitFor(() => {
        expect(publicationStarted, JSON.stringify(bridge.invoke.mock.calls.map(([name, args]) =>
          [name, name === "publish_window_fragment" ? args.fragment?.window_label : null]))).toBe(true);
      }, { timeout: 1500 });
    });
    expect(source.list.getState().workspaces).toHaveLength(0);
    expect(bridge.emitTo.mock.calls.some(([, event]) => event === "mycmux://tearout-delivery")).toBe(false);
    await act(async () => failSend());
  } finally {
    await act(async () => {
      allowPublication.resolve();
      expect((await move)?.error).toBeUndefined();
      if (mode === "dock" && publicationStarted)
        await vi.waitFor(() => expect(bridge.destroy).toHaveBeenCalledWith(source.label));
    });
  }
  expect(bridge.emitTo).toHaveBeenCalledWith(source.label, "mycmux://tearout-receipt", expect.objectContaining({ ok: true }));
  await act(async () => source.root.render(null));
  await recover(receiver);
  expect(bridge.send).toHaveBeenCalledTimes(1);
}, 10_000);


it.each(["dock", "window"])("carries the send that fails while %s still waits for live sessions", async kind => {
  const receiver = await openView(nextWindow);
  const source = await openView("main");
  source.restoreWorkspaceConfigs([workspace]);
  const failSend = await beginSend(source);
  const liveness = deferred();
  let checking = false;
  const invoke = bridge.invoke.getMockImplementation()!;
  bridge.invoke.mockImplementation(async (command, args) => {
    if (command === "is_session_alive" && !checking) {
      checking = true;
      await liveness.promise;
    }
    return invoke(command, args);
  });
  let moving!: Promise<unknown>;
  try {
    await act(async () => {
      moving = kind === "dock" ? dock(source, receiver) : Promise.resolve(source.executeWorkspace());
      await vi.waitFor(() => expect(checking).toBe(true), { timeout: 1500 });
    });
    expect(source.list.getState().workspaces).toHaveLength(1);
    await act(async () => failSend());
  } finally {
    await act(async () => {
      liveness.resolve();
      const result = await moving;
      if (kind === "window") expect(result).toMatchObject({ status: "moved" });
      else await vi.waitFor(() => expect(bridge.destroy).toHaveBeenCalledWith(source.label));
    });
  }
  await act(async () => source.root.render(null));
  await recover(receiver);
  expect(bridge.send).toHaveBeenCalledTimes(1);
}, 10_000);

it("keeps the failed send recoverable at the source when the initial move reservation refuses", async () => {
  const source = await openView("main");
  source.restoreWorkspaceConfigs([workspace]);
  const failSend = await beginSend(source);
  const reserved = deferred();
  let waiting = false;
  const invoke = bridge.invoke.getMockImplementation()!;
  bridge.invoke.mockImplementation(async (command, args) => {
    if (command === "tearout_transfer_refusal") {
      waiting = true;
      await reserved.promise;
      return { kind: "rejected_busy", pre_ownership: true, phase: "moving", label: source.label,
        owner_id: "other-move", source: "other-window" };
    }
    return invoke(command, args);
  });
  let moving!: Promise<unknown>;
  try {
    await act(async () => {
      moving = Promise.resolve(source.executeWorkspace());
      await vi.waitFor(() => expect(waiting).toBe(true), { timeout: 1500 });
    });
    await act(async () => failSend());
  } finally {
    await act(async () => {
      reserved.resolve();
      expect(await moving).toMatchObject({ status: "refused" });
    });
  }
  expect(source.list.getState().workspaces).toHaveLength(1);
  await recover(source);
  expect(bridge.destroy).not.toHaveBeenCalled();
  expect(bridge.send).toHaveBeenCalledTimes(1);
}, 10_000);

it("does not offer a draft again after the tab moves B to C, is recovered, and returns to B", async () => {
  const original = await openView("main");
  original.restoreWorkspaceConfigs([workspace]);
  const failSend = await beginSend(original);
  const first = await openView(nextWindow);
  bridge.label = original.label;
  await act(async () => { await original.moveWorkspace(); });
  await act(async () => { original.root.render(null); failSend(); });
  const second = await openView("mycmux-w3");
  nextWindow = second.label;
  bridge.label = first.label;
  await act(async () => { await first.moveWorkspace(); });
  expect(first.list.getState().workspaces).toHaveLength(0);
  await recover(second);

  bridge.label = second.label;
  await act(async () => {
    await dock(second, first);
    await vi.waitFor(() => expect(bridge.destroy).toHaveBeenCalledWith(second.label));
  });
  expect(first.list.getState().workspaces.flatMap(ws => ws.panes).flatMap(pane => pane.tabs).map(tab => tab.sessionId)).toEqual([sessionId]);
  await first.showComposer();
  expect(recoveryButton(first)).toBeUndefined();
  expect(bridge.send).toHaveBeenCalledTimes(1);
});

it("returns the draft to its source when the receiver rejects publication", async () => {
  const source = await openView("main");
  source.restoreWorkspaceConfigs([workspace]);
  source.composer.getState().adoptPaneSends([{ sessionId, id: "received-draft", text: message }]);
  const receiver = await openView(nextWindow);
  bridge.label = source.label;
  publishHook = async fragment => {
    if (fragment.window_label === receiver.label && fragment.workspaces.length) throw new Error("receiver publish failed");
  };
  await act(async () => {
    await dock(source, receiver);
    await vi.waitFor(() => expect(bridge.emitTo).toHaveBeenCalledWith(
      source.label, "mycmux://tearout-receipt", expect.objectContaining({ token: "dock-result", ok: false }),
    ));
  });
  expect(bridge.destroy).not.toHaveBeenCalled();
  expect(source.list.getState().workspaces.map(ws => ws.id)).toEqual([workspace.id]);
  expect(receiver.list.getState().workspaces).toHaveLength(0);
  await recover(source);
  expect(bridge.send).not.toHaveBeenCalled();
});


it("cannot recover provisional sends in the receiver before a dock is rolled back", async () => {
  const source = await openView("main");
  source.restoreWorkspaceConfigs([workspace]);
  source.composer.getState().adoptPaneSends([{ sessionId, id: "staged", text: message }]);
  const receiver = await openView(nextWindow);
  bridge.label = source.label;
  const reached = deferred();
  const cancel = deferred();
  const invoke = bridge.invoke.getMockImplementation()!;
  bridge.invoke.mockImplementation(async (name, args) => {
    if (name === "tearout_phase" && args.phase === "received") {
      reached.resolve();
      await cancel.promise;
      throw new Error("synthetic failure before dock finalization");
    }
    return invoke(name, args);
  });
  try {
    await act(async () => { await dock(source, receiver); await reached.promise; });
    expect(receiver.list.getState().workspaces).toHaveLength(1);
    await receiver.showComposer();
    await act(async () => recoveryButton(receiver)?.click());
    await act(async () => receiver.composer.getState().restoreMovedPaneSends(sessionId));
  } finally {
    await act(async () => {
      cancel.resolve();
      await vi.waitFor(() => expect(bridge.emitTo).toHaveBeenCalledWith(
        source.label, "mycmux://tearout-receipt", expect.objectContaining({ token: "dock-result", ok: false }),
      ));
    });
  }
  expect(receiver.list.getState().workspaces).toHaveLength(0);
  expect(receiver.composer.getState().draftBySession[sessionId]).toBeUndefined();
  expect(receiver.composer.getState().paneSendsBySession[sessionId]).toBeUndefined();
  await recover(source);
  expect(bridge.send).not.toHaveBeenCalled();
}, 10_000);

it("recovers one legacy return body when the receiving renderer reloads after its provisional receipt", async () => {
  const source = await openView(nextWindow);
  source.restoreWorkspaceConfigs([workspace]);
  source.composer.getState().adoptPaneSends([{ sessionId, id: "legacy-reload", text: message }]);
  const first = await openView("mycmux-w3", true);
  const allowReceipt = deferred();
  const offered = deferred();
  const deliver = bridge.emitTo.getMockImplementation()!;
  bridge.emitTo.mockImplementation(async (label, event, payload) => {
    if (event === "mycmux://detached-dock-drafts-receipt") {
      offered.resolve();
      await allowReceipt.promise;
    }
    await deliver(label, event, payload);
  });
  bridge.label = source.label;
  let returning!: Promise<void>;
  let reloaded!: View;
  try {
    await act(async () => {
      returning = source.socket.transferWindowWorkspacesAndClose(first.label);
      await offered.promise;
    });
    expect(bridge.destroy).not.toHaveBeenCalled();
    await act(async () => first.root.render(null));
    reloaded = await openView(first.label, true);
  } finally {
    bridge.label = source.label;
    await act(async () => { allowReceipt.resolve(); await returning; });
  }
  await vi.waitFor(() => expect(reloaded.list.getState().workspaces).toHaveLength(1));
  expect(source.composer.getState().paneSendsBySession[sessionId]).toBeUndefined();
  expect(first.composer.getState().paneSendsBySession[sessionId]).toBeUndefined();
  expect(reloaded.composer.getState().paneSendsBySession[sessionId]).toHaveLength(1);
  await recover(reloaded);
  expect(reloaded.composer.getState().paneSendsBySession[sessionId]).toBeUndefined();
  expect(bridge.send).not.toHaveBeenCalled();
}, 10_000);

it("can copy the body in a legacy detached window and recover it after docking in another peer", async () => {
  const original = await openView("main");
  original.restoreWorkspaceConfigs([workspace]);
  const failSend = await beginSend(original);
  const detached = await openView(nextWindow);
  const { default: DetachedPaneShell } = await import("../../src/components/layout/DetachedPaneShell");
  const { detachedWorkspaceForWindow } = await import("../../src/lib/detachedPane");
  bridge.label = original.label;
  await act(async () => {
    await original.moveWorkspace({ workspace_id: "origin", pane_id: "other-pane", tab_id: "moved-tab", index: 0 });
  });
  await act(async () => { original.root.render(null); failSend(); });

  bridge.label = detached.label;
  const shell = detachedWorkspaceForWindow(detached.list.getState().workspaces, false);
  expect(shell).not.toBeNull();
  const clipboard = vi.fn(async (_text: string) => {});
  vi.stubGlobal("navigator", { platform: navigator.platform, userAgent: navigator.userAgent, clipboard: { writeText: clipboard } });
  await act(async () => detached.root.render(<DetachedPaneShell workspace={shell!} />));
  const panel = detached.host.querySelector("details");
  expect.soft(panel?.querySelector("textarea")?.value).toBe(message);
  const copy = recoveryButton(detached, "コピー");
  expect.soft(copy).toBeDefined();
  if (copy) {
    await act(async () => copy.click());
    expect.soft(clipboard).toHaveBeenCalledWith(message);
  }

  const receiver = await openView("mycmux-w3", true);
  bridge.label = detached.label;
  const allowReceipt = deferred();
  const deliver = bridge.emitTo.getMockImplementation()!;
  bridge.emitTo.mockImplementation(async (label: string, event: string, payload: unknown) => {
    if (event === "mycmux://detached-dock-drafts-receipt") await allowReceipt.promise;
    await deliver(label, event, payload);
  });
  let returning: Promise<void> | undefined;
  try {
    await act(async () => {
      returning = detached.socket.transferWindowWorkspacesAndClose(receiver.label);
      await vi.waitFor(() => expect(bridge.emitTo).toHaveBeenCalledWith(
        detached.label, "mycmux://detached-dock-drafts-receipt", expect.objectContaining({ accepted: true }),
      ), { timeout: 1500 });
    });
    expect(bridge.destroy).not.toHaveBeenCalled();
    expect(bridge.invoke.mock.calls.some(([command]) => command === "release_workspaces")).toBe(false);
  } finally {
    await act(async () => { allowReceipt.resolve(); await returning; });
  }
  expect(bridge.destroy).toHaveBeenCalledWith(detached.label);
  await recover(receiver);
  expect(bridge.send).toHaveBeenCalledTimes(1);
});

it("revokes the old renderer's right to destroy after a reload during close preparation", async () => {
  const source = await openView(nextWindow);
  source.restoreWorkspaceConfigs([workspace]);
  const reached = deferred();
  const resume = deferred();
  const invoke = bridge.invoke.getMockImplementation()!;
  let generation = 0;
  let preparingClose = false;
  bridge.invoke.mockImplementation(async (name, args) => {
    if (name === "publish_window_fragment" && args.readCloseIntentDocument) return generation;
    if (name === "set_window_close_intent") {
      if (args.document !== generation) throw new Error("window close intent document is stale");
      if (args.destroy) return bridge.destroy(source.label);
      preparingClose = args.closing;
      return;
    }
    if (name === "publish_window_fragment" && preparingClose) throw new Error("window is closing");
    if (name === "take_pending_adoption" && preparingClose) {
      reached.resolve();
      await resume.promise;
    }
    return invoke(name, args);
  });

  let closing!: Promise<unknown>;
  let next!: View;
  try {
    await act(async () => {
      closing = source.socket.closeWindowWorkspacesAndDestroy().catch(error => error);
      await reached.promise;
    });
    expect(preparingClose).toBe(true);
    generation++;
    preparingClose = false;
    next = await openView(source.label);
    next.restoreWorkspaceConfigs([workspace]);
    await next.publish();
  } finally {
    await act(async () => { resume.resolve(); await closing; });
  }
  expect(published.get(next.label)?.workspaces).toHaveLength(1);
  expect(bridge.destroy).not.toHaveBeenCalled();
}, 10_000);

it("removes the detached shell after return commits and retries destruction without touching the moved PTY", async () => {
  const source = await openView(nextWindow, true);
  const { default: Shell } = await import("../../src/components/layout/DetachedPaneShell");
  const { detachedWorkspaceForWindow } = await import("../../src/lib/detachedPane");
  function Host() {
    const shell = source.list(state => detachedWorkspaceForWindow(state.workspaces, false));
    return shell ? <Shell workspace={shell} /> : null;
  }
  await act(async () => {
    source.restoreWorkspaceConfigs([{ ...workspace, detached: true }]);
    source.root.render(<Host />);
  });
  const receiver = await openView("mycmux-w3", true);
  bridge.label = source.label;
  bridge.destroy.mockRejectedValueOnce(new Error("synthetic native destroy failure"));
  await act(async () => {
    await expect(source.socket.transferWindowWorkspacesAndClose(receiver.label)).rejects.toThrow("synthetic native destroy failure");
  });
  expect(receiver.list.getState().workspaces).toHaveLength(1);
  const close = source.host.querySelector<HTMLButtonElement>('button[aria-label="このタブを閉じる"]');
  if (close) await act(async () => close.click());
  expect.soft(close).toBeNull();
  expect.soft(source.list.getState().workspaces).toHaveLength(0);
  // Exercise both routes a stale shell could still call. Neither may terminate
  // a session already handed to the peer.
  await act(async () => { await source.socket.closeWindowWorkspacesAndDestroy(); });
  expect(bridge.invoke.mock.calls.filter(([name]) => name === "kill_session")).toEqual([]);
  expect(bridge.invoke.mock.calls.filter(([name]) => name === "release_workspaces")).toHaveLength(1);
  expect(bridge.destroy).toHaveBeenCalledTimes(2);
}, 10_000);

it("lets a detached tab copy two multiline sends independently", async () => {
  const source = await openView(nextWindow);
  source.restoreWorkspaceConfigs([{ ...workspace, detached: true }]);
  const drafts = ["First line\nFirst continuation", "Second line\nSecond continuation"];
  source.composer.getState().adoptPaneSends(drafts.map((text, index) => ({ sessionId, id: String(index), text })));
  const { default: Shell } = await import("../../src/components/layout/DetachedPaneShell");
  const { detachedWorkspaceForWindow } = await import("../../src/lib/detachedPane");
  const clipboard = vi.fn(async (_text: string) => {});
  vi.stubGlobal("navigator", { platform: navigator.platform, userAgent: navigator.userAgent, clipboard: { writeText: clipboard } });
  await act(async () => source.root.render(<Shell workspace={detachedWorkspaceForWindow(source.list.getState().workspaces, false)!} />));
  const panel = source.host.querySelector("details")!;
  expect.soft(panel.querySelector("summary")?.textContent).toContain("送信結果");
  expect.soft([...panel.querySelectorAll("textarea")].map(field => field.value)).toEqual(drafts);
  await act(async () => { for (const button of panel.querySelectorAll("button")) button.click(); });
  expect(clipboard.mock.calls).toEqual(drafts.map(text => [text]));
});
