// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { WorkspaceConfig } from "../../src/lib/ipc";

type WindowListener = (event: { payload: unknown }) => void;

const bridge = vi.hoisted(() => ({
  label: "source",
  listeners: new Map<string, WindowListener>(),
  invoke: vi.fn(),
  emitTo: vi.fn(),
  send: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: bridge.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, callback: WindowListener) => {
    const key = `${bridge.label}:${name}`;
    bridge.listeners.set(key, callback);
    return () => { bridge.listeners.delete(key); };
  },
  emit: vi.fn(),
  emitTo: bridge.emitTo,
}));
vi.mock("../../src/lib/windowContext", () => ({ windowLabel: () => bridge.label, isMainWindow: () => bridge.label === "receiver" }));
vi.mock("../../src/components/layout/socketCommands", () => ({ handleSocketCommand: bridge.send }));
vi.mock("../../src/lib/tearout/sessionAttachment", () => ({
  expectTearoutAttachments: () => ({ prepared: Promise.resolve(), ready: Promise.resolve(), dispose: vi.fn() }),
  rememberTearoutDormantSessions: vi.fn(),
}));

const sessionId = "pty-original";
const message = "Keep this unsent message";
const workspace: WorkspaceConfig = {
  id: "moved", name: "Moved tab", created_at: 1, grid_template_id: "1x1",
  panes: [{
    pane_id: "moved-pane", agent_id: "shell", session_id: sessionId,
    tabs: [{ tab_id: "moved-tab", agent_id: "shell", session_id: sessionId, type: "terminal" }],
  }],
};

it("recovers the in-flight draft after moving the tab, closing the source and failing before the write", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  bridge.invoke.mockImplementation(async (command: string) => command === "is_session_alive" ? true : undefined);
  let rejectWrite!: (reason: Error) => void;
  bridge.send.mockReturnValue(new Promise((_, reject) => { rejectWrite = reject; }));
  bridge.emitTo.mockImplementation(async (label: string, name: string, payload: unknown) => {
    bridge.listeners.get(`${label}:${name}`)?.({ payload: structuredClone(payload) });
  });
  const host = document.body.appendChild(document.createElement("div"));
  let root: Root | undefined;
  let stopSource: (() => void) | undefined;
  let stopReceiver: (() => void) | undefined;
  try {
    const source = await import("../../src/lib/tearout/runtime");
    const { PaneComposer } = await import("../../src/components/composer/PaneComposer");
    const { useComposerStore } = await import("../../src/stores/composerStore");
    stopSource = source.installTearoutRuntime({ serialize: () => workspace, publish: async () => {} });
    root = createRoot(host);
    await act(async () => {
      useComposerStore.getState().setDraft(sessionId, message);
      root!.render(<PaneComposer sessionId={sessionId} target={{ command: "claude", agentKind: "claude" }} />);
    });
    await act(async () => {
      host.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(bridge.send).toHaveBeenCalledTimes(1);
    expect(host.querySelector("textarea")?.value).toBe("");
    // Each WebView has its own module graph. The receiver acknowledges the
    // actual delivered tab before the source WebView closes.
    vi.resetModules();
    bridge.label = "receiver";
    const receiver = await import("../../src/lib/tearout/runtime");
    const { PaneComposer: ReceivedComposer } = await import("../../src/components/composer/PaneComposer");
    stopReceiver = receiver.installTearoutRuntime({ serialize: () => workspace, publish: async () => {} });
    await act(async () => {});
    bridge.label = "source";
    await act(async () => {
      await source.sendTearoutWorkspaces("receiver", [workspace], [sessionId], undefined, "test-move");
    });
    expect(bridge.emitTo).toHaveBeenCalledWith("source", "mycmux://tearout-receipt", { token: "test-move", ok: true });
    await act(async () => {
      await bridge.emitTo("receiver", "mycmux://tearout-finalize", { token: "test-move", source: "source" });
    });

    await act(async () => { root!.unmount(); });
    root = undefined;
    stopSource();
    stopSource = undefined;
    bridge.label = "receiver";
    await act(async () => { rejectWrite(new Error("synthetic failure before the write")); });
    root = createRoot(host);
    await act(async () => {
      root!.render(<ReceivedComposer sessionId={sessionId} target={{ command: "claude", agentKind: "claude" }} />);
    });
    const recover = [...host.querySelectorAll("button")].find(button => button.textContent === "下書きに戻す");
    expect(recover).toBeDefined();
    await act(async () => { recover!.click(); });
    expect(host.querySelector("textarea")?.value).toBe(message);
    expect(bridge.send).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => { root?.unmount(); });
    stopReceiver?.();
    stopSource?.();
    host.remove();
    vi.unstubAllGlobals();
  }
});
