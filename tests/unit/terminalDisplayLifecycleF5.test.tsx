// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), nextContext: 0, nextChannel: 0, seq: 0, backendAt: 0, blockPaint: false,
  webglOwners: new Set<object>(), exit: undefined as (() => void) | undefined,
  channelMismatch: false, blockDomPaint: false,
  observeWrite: undefined as ((term: import("@xterm/xterm").Terminal, data: string | Uint8Array) => void) | undefined,
  terminalInstances: [] as any[], probeFails: false, attachFails: false, holdCallbacks: false, held: [] as Array<() => void>,
  channels: new Map<string, any>(), raw: "P\r\n", offset: 0, producerEpoch: 1, alive: true,
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  Channel: class<T> {
    onmessage?: (message: T) => void; id = ++mocks.nextChannel;
  },
  invoke: async (command: string, ...parameters: any[]) => {
    const args = parameters[0] ?? {};
    if (command === "get_session_attachment_contexts") {
      if (args.existingOnly && !mocks.alive) throw "tearout_session_not_alive";
      return args.sessionIds.map((session_id: string) => ({
        backend_epoch: "fixture-backend", transfer_id: args.transferToken ?? null, transfer_token: args.transferToken ?? null,
        session_id, window_label: "main", window_incarnation: "fixture-window",
        attachment_epoch: ++mocks.nextContext, nonce: String(mocks.nextContext), existing_only: args.existingOnly || mocks.alive,
      }));
    }
    if (command === "create_session" || command === "tearout_attach") mocks.channels.set(args.sessionId, args.onData);
    const result = await mocks.invoke(command, ...parameters);
    return command === "create_session" || command === "tearout_attach" ? result ?? args.attachmentContext : result;
  },
}));

vi.mock("../../src/lib/ipc", async original => {
  const ipc = await original<typeof import("../../src/lib/ipc")>();
  return {
    ...ipc,
    getSessionChannelId: (...args: Parameters<typeof ipc.getSessionChannelId>) =>
      mocks.channelMismatch ? undefined : ipc.getSessionChannelId(...args),
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  listen: vi.fn((name: string, listener: (event: { payload: { session_epoch: number } }) => void) => {
    if (name.startsWith("pty-exit-")) mocks.exit = () => listener({ payload: { session_epoch: mocks.producerEpoch } });
    return Promise.resolve(() => {});
  }),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }),
}));

vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn(() => Promise.resolve()) }));

vi.mock("allotment", async () => {
  const React = await import("react");
  const Pane = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  const Allotment = Object.assign(
    React.forwardRef(function MockAllotment(
      { children }: { children?: React.ReactNode },
      _ref: React.ForwardedRef<unknown>,
    ) {
      return <div data-allotment>{children}</div>;
    }),
    { Pane },
  );
  return { Allotment };
});

vi.mock("../../src/components/terminal/AgentTabConversation", async () => {
  const { useLayoutEffect } = await import("react");
  return { AgentTabConversation: ({ onVisible }: { onVisible: (visible: boolean) => void }) => {
    useLayoutEffect(() => { onVisible(true); return () => onVisible(false); }, [onVisible]);
    return null;
  } };
});

vi.mock("@xterm/xterm", async original => {
  const actual = await original<typeof import("@xterm/xterm")>();
  class ObservedTerminal extends actual.Terminal {
    constructor(options: any) { super({ ...options, cols: 80, rows: 24 }); mocks.terminalInstances.push(this); }
    get onRender() {
      return (listener: (event: { start: number; end: number }) => void) =>
        super.onRender(event => {
          const blocked = mocks.webglOwners.has(this) ? mocks.blockPaint : mocks.blockDomPaint;
          if (!blocked) listener(event);
        });
    }
    write(data: string | Uint8Array, callback?: () => void): void {
      mocks.observeWrite?.(this, data);
      super.write(data, () => {
        if (mocks.holdCallbacks && callback) mocks.held.push(callback);
        else callback?.();
      });
    }
  }
  return { ...actual, Terminal: ObservedTerminal };
});
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { activate(): void {} dispose(): void {} fit(): void {} } }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class {
  onContextLoss() { return { dispose() {} }; }
  private term?: object;
  activate(term: object) { this.term = term; mocks.webglOwners.add(term); }
  dispose() { if (this.term) mocks.webglOwners.delete(this.term); }
} }));

import TerminalPane from "../../src/components/workspace/TerminalPane";
import { terminalPaneStrings } from "../../src/components/workspace/terminalPaneStrings";
import { useToastStore } from "../../src/stores/toastStore";
import { sessionDraft, eraseSequenceFor, restorableText } from "../../src/lib/inputLineDraft";
import { MAX_CACHED_TERMINALS, cacheOrDisposeOnUnmount, type CachedTerm } from "../../src/components/terminal/terminalCache";
import { TerminalStreamHealth, terminalHealthMonitor } from "../../src/lib/terminalStreamHealth";
import { observePtyEpoch, ptyReadGeneration } from "../../src/lib/ptyReadGeneration";
import { reportTerminalDiagnostic } from "../../src/lib/terminalDiagnostics";
import { admitPaintRepair } from "../../src/components/terminal/terminalPaintBudget";
import XTermWrapper, { TERMINAL_SEARCH_EVENT } from "../../src/components/terminal/XTermWrapper";
import { evictTerminalCache, liveTerms, termCache, isTerminalParsingCurrentOutput } from "../../src/components/terminal/terminalCache";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useUiStore } from "../../src/stores/uiStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useDashboardViewStore } from "../../src/stores/dashboardViewStore";

let host: HTMLDivElement, root: Root, sequence = 0, sessionId: string;
async function mount(withHeader = false, initialReplay?: string[], requireCurrent = true) {
  await act(async () => root.render(withHeader
    ? <TerminalPane pane={useWorkspaceListStore.getState().workspaces[0].panes[0]} workspaceId="w" />
    : <XTermWrapper workspaceId="w" sessionId={sessionId} command="synthetic-shell" args={[]} initialReplay={initialReplay} />));
  await vi.waitFor(() => expect(liveTerms.has(sessionId)).toBe(true));
  if (requireCurrent) await vi.waitFor(() => expect(isTerminalParsingCurrentOutput(sessionId)).toBe(true));
}
function text(): string[] {
  const term = liveTerms.get(sessionId)!;
  return Array.from({ length: term.buffer.active.length }, (_, row) => term.buffer.active.getLine(row)?.translateToString(true) ?? "");
}
function snapshot(): ArrayBuffer {
  const data = new TextEncoder().encode(mocks.raw), frame = new ArrayBuffer(48 + data.length), view = new DataView(frame);
  new Uint8Array(frame).set([0x4d, 0x43, 0x53, 0x32]);
  view.setBigUint64(8, BigInt(mocks.offset), true); view.setBigUint64(16, BigInt(mocks.offset + data.length), true);
  view.setBigUint64(24, BigInt(mocks.producerEpoch), true);
  new Uint8Array(frame, 48).set(data); return frame;
}
function output(data: string): void {
  const start = mocks.offset + new TextEncoder().encode(mocks.raw).length;
  mocks.raw += data;
  deliverFrame(data, start);
}
function deliverFrame(data: string, start: number, resync = false): void {
  const bytes = new TextEncoder().encode(data);
  const frame = new ArrayBuffer(40 + bytes.length), view = new DataView(frame);
  new Uint8Array(frame).set([0x4d, 0x43, 0x58, 0x31]);
  view.setUint32(4, Number(resync), true);
  view.setBigUint64(8, 1n, true); view.setBigUint64(16, BigInt(++mocks.seq), true);
  view.setBigUint64(24, BigInt(start), true); view.setBigUint64(32, BigInt(start + bytes.length), true);
  new Uint8Array(frame, 40).set(bytes); mocks.channels.get(sessionId).onmessage(frame);
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 1056, bottom: 480, width: 1056, height: 480, toJSON: () => ({}) });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1056);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(480);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    font: "14px monospace", fillStyle: "#000000", globalCompositeOperation: "copy",
    measureText: (value: string) => ({ width: value.length * 8, actualBoundingBoxAscent: 11, actualBoundingBoxDescent: 3 }),
    fillRect() {}, clearRect() {}, drawImage() {}, putImageData() {},
    getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
    createLinearGradient: () => ({ addColorStop() {} }),
  } as never);
  mocks.invoke.mockReset(); mocks.terminalInstances.length = 0; mocks.held.length = 0;
  mocks.seq = 0; mocks.backendAt = 0; mocks.blockPaint = mocks.blockDomPaint = false;
  mocks.webglOwners.clear(); mocks.exit = undefined; mocks.channelMismatch = false;
  mocks.probeFails = mocks.attachFails = false;
  useToastStore.setState({ toasts: [] });
  mocks.holdCallbacks = false; mocks.channels.clear(); mocks.raw = "P\r\n"; mocks.offset = 0; mocks.producerEpoch = 1; mocks.alive = true;
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "get_session_output_snapshot") return { [sessionId]: mocks.backendAt };
    if (command === "get_codex_restore_epoch") return mocks.producerEpoch;
    if (command === "get_terminal_config") return { font_size: 14, shell: "synthetic-shell", background: "#000000", foreground: "#ffffff", ansi: [], windows_build_number: null };
    if (command === "is_session_alive" && mocks.probeFails) throw Error("synthetic-probe-error");
    if (command === "create_session" && mocks.attachFails) throw "synthetic-attach-error";
    if (command === "is_session_alive") return mocks.alive;
    if (command === "get_session_scrollback") return snapshot();
    if (command === "get_transcript_user_prompts") return [];
    return undefined;
  });
  sessionId = (++sequence).toString(16).padStart(8, "0") + "-a123-4020-b013-000000000000";
  useSettingsStore.setState({ agentTabContent: "terminal", terminalRenderer: "dom", notificationsEnabled: true });
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {}, lastLog: {}, lastLogAt: {} });
  useDashboardViewStore.setState({ open: false });
  useUiStore.setState({ activePaneId: sessionId, focusRevision: 0, zoomedPaneId: null });
  useWorkspaceListStore.setState({ activeWorkspaceId: "w", workspaces: [{ id: "w", name: "Fixture", gridTemplateId: "1x1", status: "running", createdAt: 1,
    panes: [{ id: "p", sessionId, agentId: "shell-starter", activeTabId: "t", tabs: [{ id: "t", sessionId, agentId: "shell-starter", type: "terminal" }] }] }] });
  host = document.createElement("div"); host.dataset.cmuxThemedRoot = "true"; host.style.cssText = "height:480px;width:1056px";
  document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); evictTerminalCache(sessionId); host.remove();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});


const recovery = (reason: "paint" | "channel" | "manual") =>
  mocks.invoke.mock.calls.filter(([command, args]) =>
    command === "report_renderer_heartbeat" && args?.diagnostic?.reason === reason)
    .map(([, args]) => args.diagnostic);

async function stallWebgl({ failRefresh = false, covered = false, withHeader = false, beforePoll }: {
  failRefresh?: boolean;
  covered?: boolean;
  withHeader?: boolean;
  beforePoll?: (step: number) => void | Promise<void>;
} = {}) {
  useSettingsStore.setState({ terminalRenderer: "webgl", agentTabContent: covered ? "conversation" : "terminal" });
  if (covered) usePaneMetadataStore.getState().setVolatileMetadata(sessionId, { ptyAlive: true, liveAgentKind: "codex" });
  await mount(withHeader);
  if (covered) expect(host.querySelector("[data-hanabi-terminal-surface][inert]")).toBeTruthy();
  const term = liveTerms.get(sessionId)!;
  expect(mocks.webglOwners.has(term)).toBe(true);
  const originalRefresh = term.refresh.bind(term);
  const domRefreshes: Array<[number, number]> = [];
  vi.spyOn(term, "refresh").mockImplementation((start, end) => {
    if (!mocks.webglOwners.has(term)) {
      domRefreshes.push([start, end]);
      if (failRefresh && domRefreshes.length === 1) throw Error("synthetic refresh failure");
    }
    originalRefresh(start, end);
  });
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const wallStart = now, elapsedStart = performance.now();
  vi.spyOn(performance, "now").mockImplementation(() => elapsedStart + now - wallStart);
  mocks.blockPaint = true;
  await terminalHealthMonitor.poll();
  for (let i = 0; i < 8; i++) {
    await beforePoll?.(i);
    now += 2000;
    mocks.backendAt = now - 10;
    await act(async () => output("line-" + i + "\r\n"));
    if (host.style.visibility !== "hidden") {
      await vi.waitFor(() => expect(text()).toContain("line-" + i));
    }
    await terminalHealthMonitor.poll();
  }
  return { term, domRefreshes };
}

it("paintRepair switches WebGL to DOM and refreshes the whole same Terminal", async () => {
  const { term, domRefreshes } = await stallWebgl();
  await vi.waitFor(() => expect(recovery("paint").map(row => row.event)).toContain("end"), { timeout: 3800 });
  expect(mocks.webglOwners.has(term)).toBe(false);
  expect(domRefreshes[0]).toEqual([0, term.rows - 1]);
  expect(liveTerms.get(sessionId)).toBe(term);
  expect(mocks.terminalInstances).toEqual([term]);
  expect(attached()).toHaveLength(1);
  expect(mocks.invoke.mock.calls.filter(([c]) => c === "get_session_scrollback")).toHaveLength(1);
});

it("paintRepair fails when the product's full refresh throws after WebGL disposal", async () => {
  await stallWebgl({ failRefresh: true });
  expect(recovery("paint").map(row => row.event)).toContain("failed");
  expect(recovery("paint").map(row => row.event)).not.toContain("end");
});

it("paintRepair discards evidence when the terminal hides and returns between polls", async () => {
  const { term } = await stallWebgl({ beforePoll: step => {
    if (step !== 5) return;
    host.style.visibility = "hidden";
    window.dispatchEvent(new Event("mycmux:workspace-visibility-change"));
    host.style.visibility = "visible";
    window.dispatchEvent(new Event("mycmux:workspace-visibility-change"));
  } });
  expect(mocks.webglOwners.has(term)).toBe(true);
  expect(recovery("paint")).toHaveLength(0);
});

it("a conversation overlay keeps the hidden renderer out of paint-stall recovery", async () => {
  const { term } = await stallWebgl({ covered: true });
  expect(mocks.webglOwners.has(term)).toBe(true);
  expect(recovery("paint")).toHaveLength(0);
});

async function zoomPeer(zoomed: boolean, mainWindow = false) {
  await act(async () => {
    useUiStore.getState().setZoomedPaneId(zoomed ? "peer-pane" : null);
    // In the main shell, CSS hides the sibling. Native siblings stay sized and CSS-visible.
    if (mainWindow) host.style.visibility = zoomed ? "hidden" : "visible";
  });
}

it.each(["main", "native"])("paintRepair excludes a pane behind zoom in the %s window", async shell => {
  const { term } = await stallWebgl({ withHeader: true, beforePoll: async step => {
    if (step === 0) await zoomPeer(true, shell === "main");
  } });
  expect(mocks.webglOwners.has(term)).toBe(true);
  expect(recovery("paint")).toHaveLength(0);
});

it("paintRepair starts fresh after a native pane is briefly covered by zoom", async () => {
  const { term } = await stallWebgl({ withHeader: true, beforePoll: async step => {
    if (step !== 5) return;
    await zoomPeer(true);
    await zoomPeer(false);
  } });
  expect(mocks.webglOwners.has(term)).toBe(true);
  expect(recovery("paint")).toHaveLength(0);
});

it("paintRepair starts fresh after the dashboard opens and closes between polls", async () => {
  const { term } = await stallWebgl({ beforePoll: step => {
    if (step !== 5) return;
    useDashboardViewStore.getState().openView();
    useDashboardViewStore.getState().close();
  } });
  expect(mocks.webglOwners.has(term)).toBe(true);
  expect(recovery("paint")).toHaveLength(0);
});

it("a closing page hands off pending diagnostic totals", () => {
  for (let attempt = 0; attempt < 2; attempt++) {
    reportTerminalDiagnostic("recovery", "failed", sessionId, {}, {}, { reason: "paint" });
  }
  expect(recovery("paint")).toHaveLength(1);
  window.dispatchEvent(new Event("pagehide"));
  const summaries = mocks.invoke.mock.calls.map(([, args]) => args?.diagnostic)
    .filter(row => row?.event === "coalesced");
  expect(summaries).toContainEqual(expect.objectContaining({ numbers: { coalesced: 1, count_paint_failed: 1 } }));
});

it("channel recovery without channel ownership is aborted, with no diagnostic ring read", async () => {
  await mount();
  let now = Date.now();
  const wallStart = now, elapsedStart = performance.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.spyOn(performance, "now").mockImplementation(() => elapsedStart + now - wallStart);
  await terminalHealthMonitor.poll();
  mocks.invoke.mockClear();
  mocks.channelMismatch = true;
  now += 11000;
  mocks.backendAt = now - 1;
  await terminalHealthMonitor.poll();
  await vi.waitFor(() => expect(recovery("channel").map(row => row.event)).toContain("aborted"));
  expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "get_session_scrollback")).toBe(false);
});

it("a late parser callback from invalidated read authority contributes no paint evidence", async () => {
  await mount();
  const observe = vi.spyOn(TerminalStreamHealth.prototype, "observeParse");
  mocks.holdCallbacks = true;
  await act(async () => output("old generation\r\n"));
  await vi.waitFor(() => expect(mocks.held).toHaveLength(1));
  const oldAuthority = ptyReadGeneration(sessionId);
  observePtyEpoch(sessionId, mocks.producerEpoch + 1);
  expect(ptyReadGeneration(sessionId)).not.toBe(oldAuthority);
  mocks.holdCallbacks = false;
  mocks.held.shift()!();
  expect(observe).not.toHaveBeenCalled();
});

const menuLabel = "このタブの表示を描き直す";
async function menuAction(menu: "overflow" | "context" = "overflow", beforeClick?: () => void) {
  if (menu === "context") {
    const tab = host.querySelector<HTMLElement>('[data-tab-id="t"]')!;
    await act(async () => { tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 60, clientY: 20 })); });
  } else {
    const trigger = host.querySelector<HTMLButtonElement>(`button[aria-label="${terminalPaneStrings.paneActions}"]`)!;
    await act(async () => trigger.click());
  }
  const item = [...document.querySelectorAll<HTMLElement>('button,[role="menuitem"]')].find(node => node.textContent === menuLabel);
  expect(item, menu).toBeTruthy();
  await act(async () => { beforeClick?.(); item!.click(); });
}
const attached = () => mocks.invoke.mock.calls.filter(([c]) => c === "create_session" || c === "tearout_attach");
const sent = () => mocks.invoke.mock.calls.filter(([c]) => c === "write_to_session").map(([, args]) => args?.data ?? "").join("");
const feedback = () => useToastStore.getState().toasts.map(toast => toast.message);
async function removeThroughLru() {
  await act(async () => root.render(null));
  expect(termCache.has(sessionId)).toBe(true);
  const fillers = Array.from({ length: MAX_CACHED_TERMINALS }, (_, i) => sessionId + "-filler-" + i);
  for (const id of fillers) cacheOrDisposeOnUnmount(id, { term: { dispose() {} } } as CachedTerm);
  expect(termCache.has(sessionId)).toBe(false);
  for (const id of fillers) evictTerminalCache(id);
}
const historicalOutput = "from-ring\r\n\x1b]9988;fixture-preview\x07\x1b[6n\x1b[c\x1b]10;?\x07";
async function historicalEffects(reopen: () => Promise<void>) {
  mocks.raw = historicalOutput;
  let preview = 0;
  const observed = (event: Event) => { preview++; event.stopImmediatePropagation(); };
  window.addEventListener("mycmux:html-out", observed, true);
  try {
    mocks.invoke.mockClear();
    await reopen();
    await vi.waitFor(() => expect(text()).toContain("from-ring"));
    await new Promise(resolve => setTimeout(resolve, 100));
    const reply = sent();
    const result = { preview, dsr: /\x1b\[\d+;\d+R/.test(reply), da: /\x1b\[\?[\d;]+c/.test(reply), color: reply.includes("]10;rgb:") };
    console.info("F5_COLD_REPLAY", JSON.stringify(result));
    return result;
  } finally { window.removeEventListener("mycmux:html-out", observed, true); }
}

it("baseColdReopen measures OSC 9988, DSR, DA and OSC color queries after a real LRU eviction", async () => {
  await mount();
  await removeThroughLru();
  const result = await historicalEffects(() => mount());
  expect(result.preview).toBe(1);
  expect(result.dsr).toBe(true);
  expect(result.da).toBe(true);
  expect(result.color).toBe(true);
});

it("manual repaint keeps the existing parser, focus, history and draft without replaying OSC or PTY replies", async () => {
  useSettingsStore.setState({ terminalRenderer: "webgl" });
  await mount(true);
  const term = liveTerms.get(sessionId)!;
  expect(mocks.webglOwners.has(term)).toBe(true);
  term.focus(); term.input("keep draft", true);
  await vi.waitFor(() => expect(restorableText(sessionDraft(sessionId))).toBe("keep draft"));
  await vi.waitFor(() => expect(sent()).toContain("keep draft"));
  const before = { ...sessionDraft(sessionId) };
  const refresh = vi.spyOn(term, "refresh");
  mocks.raw = historicalOutput;
  const preview = vi.fn((event: Event) => event.stopImmediatePropagation());
  window.addEventListener("mycmux:html-out", preview, true);
  mocks.invoke.mockClear();
  try {
    const selected = document.createElement("button");
    host.append(selected);
    await menuAction("context", () => selected.focus());
    expect(document.activeElement).toBe(selected);
    expect(liveTerms.get(sessionId)).toBe(term);
    expect(mocks.webglOwners.has(term)).toBe(false);
    expect(refresh).toHaveBeenCalledWith(0, term.rows - 1);
    expect(text()).toContain("P");
    expect(sessionDraft(sessionId)).toEqual(before);
    expect(eraseSequenceFor(sessionDraft(sessionId))).toHaveLength(10);
    expect(attached()).toHaveLength(0);
    expect(sent()).toBe("");
    expect(preview).not.toHaveBeenCalled();
    expect(mocks.invoke.mock.calls.some(([cmd]) =>
      ["is_session_alive", "get_session_scrollback", "kill_session", "resize_session"].includes(cmd))).toBe(false);
    expect(feedback()).toContain("タブの表示を描き直しました");
    expect(recovery("manual").map(row => row.event)).toEqual(["end"]);
  } finally { window.removeEventListener("mycmux:html-out", preview, true); }
});

async function pollForChannelRecovery() {
  await terminalHealthMonitor.poll();
  await act(async () => { await vi.advanceTimersByTimeAsync(11_000); });
  mocks.backendAt = Date.now() - 1;
  await terminalHealthMonitor.poll();
}

async function expectSuccessfulManualRepaint(term: import("@xterm/xterm").Terminal, menu: "overflow" | "context") {
  // Startup and successful reattach schedule refits through 240 ms, which can queue refreshes through +160 ms.
  const refitAndRefreshMs = 240 + 160;
  await act(async () => { await vi.advanceTimersByTimeAsync(refitAndRefreshMs); });
  const refresh = vi.spyOn(term, "refresh");
  await menuAction(menu, () => {
    refresh.mockClear();
    mocks.invoke.mockClear();
  });
  // Include any deferred work triggered by the menu action in the assertions.
  await act(async () => { await vi.advanceTimersByTimeAsync(refitAndRefreshMs); });
  expect(refresh).toHaveBeenCalledExactlyOnceWith(0, term.rows - 1);
  expect(feedback()).toContain("タブの表示を描き直しました");
  expect(liveTerms.get(sessionId)).toBe(term);
  expect(attached()).toHaveLength(0);
  expect(mocks.invoke.mock.calls.some(([cmd]) =>
    ["is_session_alive", "get_session_scrollback", "resize_session", "write_to_session", "write_to_session_guarded"].includes(cmd))).toBe(false);
}

it.each([["failed", "overflow"], ["aborted", "context"]] as const)(
  "manual repaint succeeds after %s channel recovery through the %s menu", async (outcome, menu) => {
    vi.useFakeTimers();
    await mount(true);
    const term = liveTerms.get(sessionId)!;
    mocks.attachFails = outcome === "failed";
    mocks.channelMismatch = outcome === "aborted";
    await pollForChannelRecovery();
    await vi.waitFor(() => expect(recovery("channel").map(row => row.event)).toContain(outcome));
    await expectSuccessfulManualRepaint(term, menu);
  },
);

it("manual repaint accepts a terminal first attached by channel recovery", async () => {
  vi.useFakeTimers();
  mocks.attachFails = true;
  await mount(true, undefined, false);
  const term = liveTerms.get(sessionId)!;
  await vi.waitFor(() => expect(text().join("\n")).toContain("synthetic-attach-error"));
  mocks.attachFails = false;
  await pollForChannelRecovery();
  await vi.waitFor(() => expect(recovery("channel").map(row => row.event)).toContain("end"));
  await expectSuccessfulManualRepaint(term, "overflow");
});

it.each(["hidden", "exited", "observed stopped", "starting"])("manual repaint rejects an unavailable terminal (%s)", async mode => {
  if (mode === "starting") {
    useWorkspaceListStore.getState().workspaces[0].panes[0].tabs[0].terminalSnapshot = ["saved line"];
    mocks.holdCallbacks = true;
  }
  await mount(true, undefined, mode !== "starting");
  const term = liveTerms.get(sessionId)!;
  if (mode === "starting") await vi.waitFor(() => expect(mocks.held.length).toBeGreaterThan(0));
  if (mode === "hidden") host.style.visibility = "hidden";
  if (mode === "exited") {
    mocks.exit!();
    await vi.waitFor(() => expect(text().join("\n")).toContain("プロセスは終了しました"));
  }
  if (mode === "observed stopped") usePaneMetadataStore.getState().setVolatileMetadata(sessionId, { ptyAlive: false });
  mocks.invoke.mockClear();
  try {
    await menuAction();
    expect(feedback()).toContain(terminalPaneStrings.displayRestoreUnavailable);
    expect(liveTerms.get(sessionId)).toBe(term);
    expect(recovery("manual")).toHaveLength(0);
    expect(attached()).toHaveLength(0);
  } finally {
    mocks.holdCallbacks = false;
    for (const complete of mocks.held.splice(0)) complete();
  }
});

it("ordinary cold reopen retains the base attach-error display after LRU", async () => {
  await mount();
  const old = liveTerms.get(sessionId)!;
  await removeThroughLru();
  mocks.attachFails = true;
  await mount(false, undefined, false);
  await vi.waitFor(() => expect(text().join("\n")).toContain("Failed to start: synthetic-attach-error"));
  expect(liveTerms.get(sessionId)).not.toBe(old);
});

it.each(["close", "lru"])("ordinary %s eviction still discards the draft and its undo text", async eviction => {
  await mount();
  const old = liveTerms.get(sessionId)!;
  old.focus();
  old.input("ordinary draft", true);
  await vi.waitFor(() => expect(restorableText(sessionDraft(sessionId))).toBe("ordinary draft"));
  if (eviction === "lru") await removeThroughLru(); else evictTerminalCache(sessionId);
  expect(restorableText(sessionDraft(sessionId))).toBeNull();
});

it("manual repaint preserves queued input order and uses an independent two-second throttle", async () => {
  await mount(true);
  const term = liveTerms.get(sessionId)!;
  const invoke = mocks.invoke.getMockImplementation()!;
  let resume!: () => void;
  const blocked = new Promise<void>(resolve => { resume = resolve; });
  mocks.invoke.mockClear().mockImplementation(async (command, ...args) => {
    if (command === "write_to_session" && args[0]?.data === "first") return blocked;
    return invoke(command, ...args);
  });
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const wallStart = now, elapsedStart = performance.now();
  vi.spyOn(performance, "now").mockImplementation(() => elapsedStart + now - wallStart);
  try {
    term.focus(); term.input("first", true);
    await vi.waitFor(() => expect(sent()).toBe("first"));
    term.input("second", true);
    for (let i = 0; i < 5; i++) expect(admitPaintRepair(sessionId, now - (5 - i) * 30_000).state).toBe("admitted");
    await menuAction();
    await menuAction();
    expect(recovery("manual").map(row => row.event)).toEqual(["end"]);
    expect(admitPaintRepair(sessionId, now).state).toBe("exhausted");
    now += 2000;
    await menuAction();
    expect(recovery("manual").map(row => row.event)).toEqual(["end", "end"]);
    expect(admitPaintRepair(sessionId, now).state).toBe("silent");
    expect(liveTerms.get(sessionId)).toBe(term);
    expect(sent()).toBe("first");
    resume();
    await vi.waitFor(() => expect(sent()).toBe("firstsecond"));
  } finally { resume(); }
});

it("manual repaint logs one failure and preserves the Terminal when refresh throws", async () => {
  await mount(true);
  const term = liveTerms.get(sessionId)!;
  mocks.invoke.mockClear();
  await menuAction("overflow", () => {
    vi.spyOn(term, "refresh").mockImplementationOnce(() => { throw Error("synthetic refresh failure"); });
  });
  expect(recovery("manual").map(row => row.event)).toEqual(["failed"]);
  expect(feedback()).toContain("タブの表示を描き直せませんでした");
  expect(liveTerms.get(sessionId)).toBe(term);
  expect(attached()).toHaveLength(0);
});

it("ordinary cold reopen follows the existing missing-PTY launch after LRU", async () => {
  await mount();
  const old = liveTerms.get(sessionId)!;
  await removeThroughLru();
  const underlying = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockClear().mockImplementation(async (command, ...args) => {
    if (command === "is_session_alive") {
      mocks.alive = false;
      mocks.raw = "new producer\r\n";
      return false;
    }
    return underlying(command, ...args);
  });
  await mount();
  await vi.waitFor(() => expect(text()).toContain("new producer"));
  expect(liveTerms.get(sessionId)).not.toBe(old);
  expect(attached().map(([cmd]) => cmd)).toEqual(["create_session"]);
  expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "kill_session")).toBe(false);
});

it("paint allowance survives a real cache remount and LRU eviction, and clears with the tab", async () => {
  const { admitPaintRepair } = await import("../../src/components/terminal/terminalPaintBudget");
  await mount();
  const first = liveTerms.get(sessionId)!;
  expect(admitPaintRepair(sessionId, 1000).state).toBe("admitted");
  await act(async () => root.render(null));
  await mount(false, undefined, false);
  expect(liveTerms.get(sessionId)).toBe(first);
  expect(admitPaintRepair(sessionId, 1001).state).toBe("cooldown");
  await removeThroughLru();
  await mount();
  expect(liveTerms.get(sessionId)).not.toBe(first);
  expect(admitPaintRepair(sessionId, 1002).state).toBe("cooldown");
  await act(async () => root.render(null));
  useWorkspaceListStore.setState({ workspaces: [] });
  expect(admitPaintRepair(sessionId, 1003)).toEqual({ state: "admitted", attempt: 1 });
});

it("heartbeat counts pending real parser tickets without a text-length diagnostic", async () => {
  const { terminalHeartbeatCounts } = await import("../../src/components/terminal/terminalCache");
  const { SgrLightRewriter } = await import("../../src/components/terminal/sgrLightTheme");
  const transformed = vi.spyOn(SgrLightRewriter.prototype, "transform");
  const samples: ReturnType<typeof terminalHeartbeatCounts>[] = [];
  mocks.observeWrite = (_term, data) => {
    if (typeof data === "string" && data.includes("F5-sample")) {
      samples.push(terminalHeartbeatCounts());
    }
  };
  transformed.mockImplementation(data => data.includes("F5-sample") ? data + "\u3042" : data);
  try {
    await mount(false, ["F5-sample-initial"]);
    await act(async () => output("F5-sample-live\r\n"));
    await vi.waitFor(() => expect(samples.length).toBeGreaterThanOrEqual(2));
    for (const sample of samples) {
      expect(sample.pendingTickets).toBeGreaterThan(0);
      expect(sample).not.toHaveProperty("pendingBytes");
    }
  } finally { mocks.observeWrite = undefined; transformed.mockRestore(); }
});

it("uses elapsed time for manual repaint after the wall clock moves back", async () => {
  await mount(true);
  let now = Date.now();
  let elapsed = Math.floor(performance.now());
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  await menuAction();
  now -= 60_000;
  elapsed += 500;
  await menuAction();
  expect(recovery("manual").map(row => row.event)).toEqual(["end"]);
  elapsed += 1_500;
  await menuAction();
  expect(recovery("manual").map(row => row.event)).toEqual(["end", "end"]);
});

it("uses elapsed time for the paint allowance when the wall clock advances", () => {
  let now = Date.now();
  let elapsed = Math.floor(performance.now());
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  expect(admitPaintRepair(sessionId).state).toBe("admitted");
  now += 60_000;
  expect(admitPaintRepair(sessionId).state).toBe("cooldown");
  elapsed += 30_000;
  expect(admitPaintRepair(sessionId).state).toBe("admitted");
});

it("refuses manual repaint when the reused terminal never attached in this mount", async () => {
  await mount(true);
  const term = liveTerms.get(sessionId)!;
  await act(async () => root.render(null));
  mocks.attachFails = true;
  await mount(true, undefined, false);
  await vi.waitFor(() => expect(feedback()).toContain("Terminal reattach failed"));
  expect(liveTerms.get(sessionId)).toBe(term);
  await menuAction();
  expect(feedback()).toContain(terminalPaneStrings.displayRestoreUnavailable);
  expect(recovery("manual")).toHaveLength(0);
});

it("cancels a pending paint outcome when read authority changes before the result", async () => {
  await stallWebgl();
  expect(recovery("paint").map(row => row.event)).toContain("start");
  observePtyEpoch(sessionId, mocks.producerEpoch + 1);
  await vi.waitFor(() => expect(recovery("paint").map(row => row.event)).toContain("aborted"), { timeout: 3_500 });
  expect(recovery("paint").map(row => row.event)).not.toContain("end");
});

it("counts the DOM paint even if WebGL is back at the outcome deadline", async () => {
  const { term } = await stallWebgl();
  expect(recovery("paint").map(row => row.event)).toContain("start");
  await vi.waitFor(() => expect(mocks.invoke.mock.calls.some(([command, args]) =>
    command === "report_renderer_heartbeat" && args?.diagnostic?.event === "fallback-ready")).toBe(true));
  await act(async () => useSettingsStore.setState({ terminalRenderer: "dom" }));
  await act(async () => useSettingsStore.setState({ terminalRenderer: "webgl" }));
  expect(mocks.webglOwners.has(term)).toBe(true);
  await vi.waitFor(() => expect(recovery("paint").map(row => row.event)).toContain("end"), { timeout: 3_500 });
});

it("drains a third write when two parsed notifications never come back", async () => {
  await mount();
  mocks.holdCallbacks = true;
  try {
    await act(async () => output("callback-missing-A\r\n"));
    await vi.waitFor(() => expect(mocks.held).toHaveLength(1));
    await act(async () => output("callback-missing-B\r\n"));
    await vi.waitFor(() => expect(mocks.held).toHaveLength(2), { timeout: 3_500 });
    mocks.holdCallbacks = false;
    await act(async () => output("callback-present-C\r\n"));
    await vi.waitFor(() => expect(text()).toContain("callback-present-C"), { timeout: 3_500 });
    expect(text().filter(line => line.startsWith("callback-"))).toEqual([
      "callback-missing-A", "callback-missing-B", "callback-present-C",
    ]);
  } finally {
    mocks.holdCallbacks = false;
    for (const callback of mocks.held.splice(0)) callback();
  }
}, 10_000);

it("does not replay the newest row after an older parse notification comes back late", async () => {
  await mount();
  mocks.holdCallbacks = true;
  await act(async () => output("older-row\r\n"));
  await vi.waitFor(() => expect(mocks.held).toHaveLength(1));
  mocks.holdCallbacks = false;
  await act(async () => output("newer-row\r\n"));
  await vi.waitFor(() => expect(text()).toContain("newer-row"), { timeout: 3_500 });
  mocks.held.shift()!();
  await act(async () => root.render(null));
  await mount(false, undefined, false);
  await vi.waitFor(() => expect(mocks.invoke.mock.calls.filter(([cmd]) =>
    cmd === "get_session_scrollback").length).toBeGreaterThan(1));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
  expect(text().filter(line => line.endsWith("-row"))).toEqual(["older-row", "newer-row"]);
}, 8_000);

it("keeps each saved row once through two successive PTY attachments", async () => {
  await mount();
  for (const next of ["next-row", "last-row"]) {
    await act(async () => root.render(null));
    mocks.producerEpoch++;
    mocks.raw += next + "\r\n";
    await mount();
    await vi.waitFor(() => expect(text()).toContain(next));
  }
  expect(text().filter(Boolean)).toEqual(["P", "next-row", "last-row"]);
});

it("does not start channel recovery for a cached PTY whose output has not advanced", async () => {
  vi.useFakeTimers();
  await mount();
  const term = liveTerms.get(sessionId);
  mocks.backendAt = Date.now() - 100;
  await act(async () => root.render(null));
  await mount(false, undefined, false);
  expect(liveTerms.get(sessionId)).toBe(term);
  await terminalHealthMonitor.poll();
  const elapsed = performance.now();
  await act(async () => { await vi.advanceTimersByTimeAsync(132_000); });
  expect(performance.now() - elapsed).toBe(132_000);
  expect(recovery("channel")).toHaveLength(0);
});

it("keeps the same terminal during a stalled WebGL paint while the live viewport advances", async () => {
  mocks.raw = Array.from({ length: 35 }, (_, index) => "prior-" + index + "\r\n").join("");
  const { term, domRefreshes } = await stallWebgl();
  expect(term.buffer.active.baseY).toBeGreaterThan(0);
  expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY);
  expect(domRefreshes).toContainEqual([0, term.rows - 1]);
  expect(liveTerms.get(sessionId)).toBe(term);
  expect(recovery("paint").filter(row => row.event === "start")).toHaveLength(1);
});

it("keeps a lone row delivered before attachment without starting paint recovery", async () => {
  useSettingsStore.setState({ terminalRenderer: "webgl" });
  mocks.blockPaint = true;
  let now = Date.now();
  const wallStart = now, elapsedStart = performance.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.spyOn(performance, "now").mockImplementation(() => elapsedStart + now - wallStart);
  const invoke = mocks.invoke.getMockImplementation()!;
  let beforeReply = false;
  mocks.invoke.mockImplementation(async (cmd, ...args) => {
    if (cmd === "create_session" && !beforeReply) {
      beforeReply = true;
      mocks.backendAt = now;
      output("lone-early-row\r\n");
    }
    return invoke(cmd, ...args);
  });
  await mount();
  expect(beforeReply).toBe(true);
  await vi.waitFor(() => expect(text().filter(line => line === "lone-early-row")).toHaveLength(1));
  await terminalHealthMonitor.poll();
  now += 10_000;
  await terminalHealthMonitor.poll();
  expect(recovery("paint")).toHaveLength(0);
});

// Move the health clocks without letting an interval take the first sample.
function controlHealthTime() {
  const wall = Date.now();
  const elapsed = performance.now();
  let age = 0;
  vi.spyOn(Date, "now").mockImplementation(() => wall + age);
  vi.spyOn(performance, "now").mockImplementation(() => elapsed + age);
  return (ms: number) => { age = ms; return Date.now(); };
}

it("waits for continuing output when the first sample precedes a lone parse callback", async () => {
  vi.useFakeTimers();
  useSettingsStore.setState({ terminalRenderer: "webgl" });
  await mount();
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  const at = controlHealthTime();
  const term = liveTerms.get(sessionId)!;
  mocks.blockPaint = true;
  mocks.holdCallbacks = true;
  try {
    mocks.backendAt = at(100);
    await act(async () => {
      output("sample-before-parse\r\n");
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(mocks.held).toHaveLength(1);
    expect(text()).toContain("sample-before-parse");
    at(2_000);
    await terminalHealthMonitor.poll();
    at(2_015);
    mocks.holdCallbacks = false;
    await act(async () => mocks.held.shift()!());
    for (let ms = 4_000; ms <= 12_000; ms += 2_000) {
      at(ms);
      await terminalHealthMonitor.poll();
    }
    expect(recovery("paint")).toHaveLength(0);
    at(14_000);
    await terminalHealthMonitor.poll();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_050); });
    expect(recovery("paint")).toHaveLength(0);
    expect(recovery("channel")).toHaveLength(0);
    expect(liveTerms.get(sessionId)).toBe(term);
  } finally {
    mocks.holdCallbacks = false;
    for (const callback of mocks.held.splice(0)) callback();
  }
});

it("keeps the ring row once when the first output sample comes 12 seconds after parsing", async () => {
  vi.useFakeTimers();
  useSettingsStore.setState({ terminalRenderer: "webgl" });
  await mount();
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  const at = controlHealthTime();
  const term = liveTerms.get(sessionId)!;
  mocks.blockPaint = true;
  mocks.backendAt = at(100);
  const start = mocks.raw.length;
  const row = "ring-first-row\r\n";
  mocks.raw += row;
  await act(async () => {
    deliverFrame("", mocks.raw.length, true);
    await vi.advanceTimersByTimeAsync(250);
    deliverFrame(row, start);
    await vi.advanceTimersByTimeAsync(50);
  });
  expect(text().filter(line => line === "ring-first-row")).toHaveLength(1);
  at(12_100);
  await terminalHealthMonitor.poll();
  at(22_099);
  await terminalHealthMonitor.poll();
  expect(recovery("paint")).toHaveLength(0);
  at(22_100);
  await terminalHealthMonitor.poll();
  await act(async () => { await vi.advanceTimersByTimeAsync(2_050); });
  expect(recovery("paint")).toHaveLength(0);
  expect(recovery("channel")).toHaveLength(0);
  expect(liveTerms.get(sessionId)).toBe(term);
});

it("recovers continuing unpainted output when the real paint cooldown expires", async () => {
  vi.useFakeTimers();
  useSettingsStore.setState({ terminalRenderer: "webgl" });
  await mount();
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  const at = controlHealthTime();
  const term = liveTerms.get(sessionId)!;
  expect(admitPaintRepair(sessionId).state).toBe("admitted");
  mocks.blockPaint = true;
  await terminalHealthMonitor.poll();
  for (let ms = 2_000; ms <= 30_000; ms += 2_000) {
    mocks.backendAt = at(ms);
    await act(async () => {
      output("cooldown-row-" + ms + "\r\n");
      await vi.advanceTimersByTimeAsync(50);
    });
    await terminalHealthMonitor.poll();
    if (ms < 30_000) expect(recovery("paint")).toHaveLength(0);
  }
  expect(text()).toContain("cooldown-row-30000");
  at(32_050);
  await act(async () => { await vi.advanceTimersByTimeAsync(2_050); });
  expect(recovery("paint").map(row => row.event)).toEqual(["stall", "start", "end"]);
  at(64_000);
  await terminalHealthMonitor.poll();
  expect(recovery("paint").filter(row => row.event === "start")).toHaveLength(1);
  expect(recovery("channel")).toHaveLength(0);
  expect(liveTerms.get(sessionId)).toBe(term);
  expect(attached()).toHaveLength(1);
});

it("keeps a lone ring row once when its identical live frame arrives later", async () => {
  useSettingsStore.setState({ terminalRenderer: "webgl" });
  await mount();
  let now = Date.now();
  const wallStart = now, elapsedStart = performance.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.spyOn(performance, "now").mockImplementation(() => elapsedStart + now - wallStart);
  mocks.blockPaint = true;
  await terminalHealthMonitor.poll();
  now += 100;
  mocks.backendAt = now;
  const start = mocks.raw.length;
  const row = "ring-first-row\r\n";
  mocks.raw += row;
  await act(async () => deliverFrame("", mocks.raw.length, true));
  await vi.waitFor(() => expect(text()).toContain("ring-first-row"));
  await act(async () => deliverFrame(row, start));
  now += 1_900;
  await terminalHealthMonitor.poll();
  now += 10_000;
  await terminalHealthMonitor.poll();
  expect(text().filter(line => line === "ring-first-row")).toHaveLength(1);
  expect(recovery("paint")).toHaveLength(0);
});

it.each(["live-first", "ring-first", "split"] as const)(
  "keeps preview order and displays each row once across ring replay (%s)", async (order) => {
    useSettingsStore.setState({ colorAdaptCommands: ["synthetic-shell"] });
    await mount();
    const previews: string[] = [];
    const preview = (event: Event) => {
      previews.push((event as CustomEvent<{ payload: string }>).detail.payload);
      event.stopImmediatePropagation();
    };
    window.addEventListener("mycmux:html-out", preview, true);
    const first = "\x1b]9988;fixture-one\x07first-preview-row\r\n";
    const second = "\x1b]9988;fixture-two\x07second-preview-row\r\n";
    const start = mocks.raw.length;
    try {
      if (order === "split") {
        const header = "\x1b]9988;";
        await act(async () => output(header));
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
        mocks.raw += first.slice(header.length) + second;
        await act(async () => deliverFrame("", mocks.raw.length, true));
        await vi.waitFor(() => expect(text()).toContain("second-preview-row"));
        await act(async () => {
          deliverFrame(first.slice(header.length), start + header.length);
          deliverFrame(second, start + first.length);
        });
      } else {
        mocks.raw += first + second;
        if (order === "ring-first") {
          await act(async () => deliverFrame("", mocks.raw.length, true));
          await vi.waitFor(() => expect(text()).toContain("second-preview-row"));
        }
        await act(async () => {
          deliverFrame(first, start, order === "live-first");
          deliverFrame(second, start + first.length);
        });
      }
      await vi.waitFor(() => expect(text()).toContain("second-preview-row"));
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
      expect(text().filter(line => line.endsWith("-preview-row"))).toEqual(["first-preview-row", "second-preview-row"]);
      expect(previews).toEqual(["fixture-one", "fixture-two"]);
    } finally { window.removeEventListener("mycmux:html-out", preview, true); }
  },
);

it("keeps selection, scrollback position, and the search field during manual repaint", async () => {
  await mount(true);
  const term = liveTerms.get(sessionId)!;
  const rows = Array.from({ length: 40 }, (_, index) => "history-" + index + "\r\n").join("");
  await act(async () => output(rows));
  await vi.waitFor(() => expect(text()).toContain("history-39"));
  await act(async () => window.dispatchEvent(new CustomEvent(TERMINAL_SEARCH_EVENT, { detail: { sessionId } })));
  const search = host.querySelector<HTMLInputElement>("[data-terminal-search] input")!;
  expect(search).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "history");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // jsdom does not lay out xterm's scroll widget; set the real buffer viewport.
  const bufferService = (term as unknown as {
    _core: { _bufferService: { scrollLines(amount: number): void } };
  })._core._bufferService;
  bufferService.scrollLines(3 - term.buffer.active.viewportY);
  term.select(0, 3, 7);
  const position = term.buffer.active.viewportY;
  const selection = term.getSelection();
  expect(position).toBeLessThan(term.buffer.active.baseY);
  expect(selection).not.toBe("");
  await menuAction("context");
  expect(feedback()).toContain(terminalPaneStrings.displayRepainted);
  expect(liveTerms.get(sessionId)).toBe(term);
  expect(term.buffer.active.viewportY).toBe(position);
  expect(term.getSelection()).toBe(selection);
  expect(host.querySelector("[data-terminal-search] input")).toBe(search);
  expect(search.value).toBe("history");
});

it("keeps WebGL while a real terminal is reading past rows and only its live tail changes", async () => {
  vi.useFakeTimers();
  useSettingsStore.setState({ terminalRenderer: "webgl" });
  mocks.raw = Array.from({ length: 60 }, (_, index) => "previous-" + index + "\r\n").join("");
  await mount();
  const term = liveTerms.get(sessionId)!;
  const bufferService = (term as unknown as {
    _core: { _bufferService: { scrollLines(amount: number): void } };
  })._core._bufferService;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
    bufferService.scrollLines(-term.buffer.active.viewportY);
    await vi.advanceTimersByTimeAsync(50);
  });
  expect(term.buffer.active.viewportY).toBe(0);
  expect(term.buffer.active.baseY).toBeGreaterThan(term.rows);
  expect(mocks.webglOwners.has(term)).toBe(true);
  const render = vi.fn();
  const listener = term.onRender(render);
  try {
    await terminalHealthMonitor.poll();
    await act(async () => {
      mocks.backendAt = Date.now();
      output("offscreen-write");
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(text()).toContain("offscreen-write");
    expect(render).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(14_000); });
    expect(term.buffer.active.viewportY).toBe(0);
    expect(recovery("paint")).toHaveLength(0);
    expect(mocks.webglOwners.has(term)).toBe(true);
  } finally { listener.dispose(); }
});

async function mountAlternateScreen(viewportY: number) {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  useSettingsStore.setState({ terminalRenderer: "webgl" });
  mocks.raw = Array.from({ length: 80 }, (_, index) => "history-" + index + "\r\n").join("");
  await mount();
  const term = liveTerms.get(sessionId)!;
  const bufferService = (term as unknown as {
    _core: { _bufferService: { scrollLines(amount: number): void } };
  })._core._bufferService;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
    bufferService.scrollLines(viewportY - term.buffer.active.viewportY);
    await vi.advanceTimersByTimeAsync(50);
  });
  expect(term.rows).toBe(24);
  expect(term.buffer.active).toMatchObject({ type: "normal", viewportY, baseY: 57 });
  expect(mocks.webglOwners.has(term)).toBe(true);
  await act(async () => {
    mocks.backendAt = Date.now();
    output("\x1b[?1049h\x1b[1;1Hfull-screen-app");
    await vi.advanceTimersByTimeAsync(100);
  });
  expect(term.buffer.active.type).toBe("alternate");
  expect(text()[0]).toBe("full-screen-app");
  return term;
}

it.each(["stopped output", "continuing offscreen output", "a completed paint"] as const)(
  "watches a return from the alternate screen to deep history with %s",
  async scenario => {
    const term = await mountAlternateScreen(0);
    const render = vi.fn();
    const listener = term.onRender(render);
    const blockInitialPaint = scenario !== "a completed paint";
    const expectRepair = scenario === "continuing offscreen output";
    const fullViewport = { start: 0, end: 23 };
    try {
      mocks.blockPaint = blockInitialPaint;
      await act(async () => {
        mocks.backendAt = Date.now();
        output("\x1b[?1049l");
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(term.buffer.active).toMatchObject({ type: "normal", viewportY: 0, baseY: 57 });
      expect(text()[0]).toBe("history-0");
      if (blockInitialPaint) expect(render).not.toHaveBeenCalled();
      else expect(render).toHaveBeenCalledWith(fullViewport);

      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      for (let i = 0; i < 10; i++) {
        await act(async () => {
          if (expectRepair || (!blockInitialPaint && i === 0)) {
            mocks.backendAt = Date.now();
            output("\x1b[24;1Hoffscreen-" + i);
          }
          await vi.advanceTimersByTimeAsync(2_000);
        });
        if (i === 2) expect(recovery("paint")).toHaveLength(0);
      }
      await act(async () => { await vi.advanceTimersByTimeAsync(38_000); });

      if (scenario === "continuing offscreen output") expect(text()[80]).toBe("offscreen-9");
      expect(term.buffer.active).toMatchObject({ type: "normal", viewportY: 0, baseY: 57 });
      expect(liveTerms.get(sessionId)).toBe(term);
      expect(recovery("channel")).toHaveLength(0);
      expect(recovery("paint").map(row => row.event)).toEqual(expectRepair ? ["stall", "start", "end"] : []);
      expect(mocks.webglOwners.has(term)).toBe(!expectRepair);
      if (scenario === "stopped output") expect(render).not.toHaveBeenCalled();
      else expect(render).toHaveBeenCalledWith(fullViewport);
    } finally {
      listener.dispose();
    }
  },
);

it.each([
  { timing: "a partial bottom-row paint", viewportY: 34, late: false },
  { timing: "an alternate-screen paint just after polling", viewportY: 0, late: true },
])("restores all 24 history rows after $timing", async ({ viewportY, late }) => {
  const term = await mountAlternateScreen(viewportY);
  const advanceTo = async (ms: number) => {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms - performance.now()); });
  };
  const render = vi.fn();
  const listener = term.onRender(render);
  const service = (term as unknown as {
    _core: { _renderService: {
      refreshRows(start: number, end: number, redrawOnly?: boolean): void;
      _renderRows(start: number, end: number): void;
    } };
  })._core._renderService;
  const renderedRows = () => term.element!.querySelectorAll(".xterm-rows > div");
  const displayedRows = () => Array.from(renderedRows(), row => row.textContent!.trimEnd());
  const refreshRows = service.refreshRows.bind(service);
  const renderRows = service._renderRows.bind(service);
  let blockRestorePaint = false;
  const refresh = vi.spyOn(service, "refreshRows").mockImplementation((...args) => {
    if (!blockRestorePaint) refreshRows(...args);
  });
  const paint = vi.spyOn(service, "_renderRows").mockImplementation((...args) => {
    if (!blockRestorePaint) renderRows(...args);
  });
  try {
    const exit = "\x1b[?1049l";
    const exitStart = mocks.raw.length;
    await advanceTo(3_999);
    mocks.raw += exit;
    mocks.backendAt = Date.now();
    const snapshots = () => mocks.invoke.mock.calls.filter(([cmd]) => cmd === "get_session_output_snapshot").length;
    const beforeExitPoll = snapshots();
    await advanceTo(4_000);
    expect(snapshots()).toBe(beforeExitPoll + 1);
    if (late) {
      term.refresh(0, 0);
      await advanceTo(4_049);
      expect(render.mock.calls).toEqual([[{ start: 0, end: 0 }]]);
      expect(term.buffer.active.type).toBe("alternate");
    }
    await advanceTo(4_050);
    render.mockClear();
    blockRestorePaint = true;
    await act(async () => deliverFrame(exit, exitStart));
    await advanceTo(4_150);
    blockRestorePaint = false;
    expect(term.buffer.active).toMatchObject({ type: "normal", viewportY, baseY: 57 });
    expect(render).not.toHaveBeenCalled();
    // The mock WebGL renderer leaves the old DOM rows in place. Simulate the lost normal-screen frame.
    renderedRows().forEach(row => row.replaceChildren());
    expect(displayedRows()).toEqual(Array(term.rows).fill(""));

    if (!late) {
      mocks.backendAt = Date.now();
      await act(async () => output("\x1b[1;1Hbottom-visible\x1b[24;1H"));
      await advanceTo(4_250);
      expect(render.mock.calls).toEqual([[{ start: 23, end: 23 }]]);
      expect(displayedRows()[23]).toBe("bottom-visible");
    }
    const firstUpdate = late ? 20_010 : 6_010;
    for (let i = 0; i < 10; i++) {
      await advanceTo(firstUpdate + i * 2_000);
      mocks.backendAt = Date.now();
      await act(async () => output("\x1b[24;1Hoffscreen-" + i));
    }
    await advanceTo(68_000);

    expect(term.buffer.active).toMatchObject({ type: "normal", viewportY, baseY: 57 });
    expect(liveTerms.get(sessionId)).toBe(term);
    const bufferRows = Array.from({ length: term.rows }, (_, row) =>
      term.buffer.active.getLine(viewportY + row)!.translateToString(true));
    expect(recovery("channel")).toHaveLength(0);
    expect(displayedRows()).toEqual(bufferRows);
    expect(render).toHaveBeenCalledWith({ start: 0, end: 23 });
    expect(recovery("paint").map(row => row.event)).toEqual(["stall", "start", "end"]);
  } finally {
    listener.dispose();
    refresh.mockRestore();
    paint.mockRestore();
  }
});

it.each(["visible", "offscreen"] as const)("repairs while reading one row above the tail after continuing %s writes", async location => {
  vi.useFakeTimers();
  useSettingsStore.setState({ terminalRenderer: "webgl" });
  mocks.raw = Array.from({ length: 60 }, (_, index) => "previous-" + index + "\r\n").join("");
  await mount();
  const term = liveTerms.get(sessionId)!;
  const bufferService = (term as unknown as {
    _core: { _bufferService: { scrollLines(amount: number): void } };
  })._core._bufferService;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
    bufferService.scrollLines(-1);
    await vi.advanceTimersByTimeAsync(50);
  });
  const { baseY, viewportY } = term.buffer.active;
  expect(viewportY).toBe(baseY - 1);
  expect(mocks.webglOwners.has(term)).toBe(true);
  mocks.blockPaint = true;
  for (let i = 0; i < 9; i++) {
    await act(async () => {
      mocks.backendAt = Date.now();
      const row = location === "visible" ? 1 : term.rows;
      // Return the cursor outside the viewport in both cases.
      output(`\x1b[${row};1H${location}-write-${i}\x1b[${term.rows};1H`);
      await vi.advanceTimersByTimeAsync(2_000);
    });
  }
  expect(text()[baseY + (location === "visible" ? 0 : term.rows - 1)]).toBe(location + "-write-8");
  expect(term.buffer.active.viewportY).toBe(viewportY);
  expect(liveTerms.get(sessionId)).toBe(term);
  expect(recovery("channel")).toHaveLength(0);
  expect(recovery("paint").map(row => row.event)).toEqual(["stall", "start", "end"]);
  expect(mocks.webglOwners.has(term)).toBe(false);
});

it("recovers missing output after an older parse callback from the same PTY arrives", async () => {
  vi.useFakeTimers();
  await mount();
  const term = liveTerms.get(sessionId)!;
  mocks.holdCallbacks = true;
  try {
    await act(async () => {
      output("held-A\r\n");
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(mocks.held).toHaveLength(1);
    mocks.holdCallbacks = false;
    await act(async () => {
      output("delivered-B\r\n");
      await vi.advanceTimersByTimeAsync(2_100);
    });
    expect(text().filter(line => line === "held-A" || line === "delivered-B")).toEqual(["held-A", "delivered-B"]);
    expect(mocks.held).toHaveLength(1);
    mocks.raw += "missing-C\r\n";
    mocks.backendAt = Date.now();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(35);
      mocks.held.shift()!();
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(recovery("channel").map(row => row.event)).toEqual(["stall", "start", "end"]);
    expect(text().filter(line => line === "missing-C")).toHaveLength(1);
    expect(liveTerms.get(sessionId)).toBe(term);
  } finally {
    mocks.holdCallbacks = false;
    for (const callback of mocks.held.splice(0)) callback();
  }
});

it("does not reattach for a 15 ms old receipt after 22.5 seconds of no output", async () => {
  vi.useFakeTimers();
  await mount();
  await act(async () => { await vi.advanceTimersByTimeAsync(22_500); });
  const attachments = attached().length;
  mocks.holdCallbacks = true;
  try {
    mocks.backendAt = Date.now();
    await act(async () => {
      output("fresh-after-idle\r\n");
      await vi.advanceTimersByTimeAsync(15);
    });
    expect(text()).toContain("fresh-after-idle");
    expect(mocks.held).toHaveLength(1);
    await terminalHealthMonitor.poll();
    expect(recovery("channel")).toHaveLength(0);
    mocks.holdCallbacks = false;
    await act(async () => {
      mocks.held.shift()!();
      await vi.advanceTimersByTimeAsync(12_000);
    });
    expect(attached()).toHaveLength(attachments);
  } finally {
    mocks.holdCallbacks = false;
    for (const callback of mocks.held.splice(0)) callback();
  }
});

it("recovers a new PTY's missing output after a previous read's parse callback arrives", async () => {
  let now = Date.now();
  const wallStart = now, elapsedStart = performance.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.spyOn(performance, "now").mockImplementation(() => elapsedStart + now - wallStart);
  await mount();
  await terminalHealthMonitor.poll();
  mocks.holdCallbacks = true;
  try {
    now += 100;
    await act(async () => output("old-parse-row\r\n"));
    await vi.waitFor(() => expect(mocks.held).toHaveLength(1));
    expect(text()).toContain("old-parse-row");
    now += 50;
    const previous = ptyReadGeneration(sessionId);
    observePtyEpoch(sessionId, ++mocks.producerEpoch);
    expect(ptyReadGeneration(sessionId)).not.toBe(previous);
    now += 50;
    mocks.backendAt = now;
    now += 100;
    mocks.holdCallbacks = false;
    await act(async () => mocks.held.shift()!());
    for (let age = 2_000; age < 10_000; age += 2_000) {
      now = wallStart + age;
      await terminalHealthMonitor.poll();
    }
    expect(recovery("channel")).toHaveLength(0);
    now = wallStart + 10_000;
    await terminalHealthMonitor.poll();
    expect(recovery("channel").filter(row => row.event === "start")).toHaveLength(1);
  } finally {
    mocks.holdCallbacks = false;
    for (const callback of mocks.held.splice(0)) callback();
  }
});

it("aborts pending paint recovery when a poll sees a hidden ancestor before the next DOM paint", async () => {
  mocks.blockDomPaint = true;
  const { term } = await stallWebgl();
  expect(recovery("paint").map(row => row.event)).toEqual(["stall", "start"]);
  host.style.visibility = "hidden";
  await terminalHealthMonitor.poll();
  host.style.visibility = "visible";
  mocks.blockDomPaint = false;
  term.refresh(0, term.rows - 1);
  await vi.waitFor(() => expect(mocks.invoke.mock.calls.some(([command, args]) =>
    command === "report_renderer_heartbeat" && args?.diagnostic?.event === "fallback-ready")).toBe(true));
  await vi.waitFor(() => expect(recovery("paint")).toHaveLength(3), { timeout: 3_500 });
  expect(recovery("paint").map(row => row.event)).toEqual(["stall", "start", "aborted"]);
});

const scrollbackReads = () => mocks.invoke.mock.calls.filter(([cmd]) => cmd === "get_session_scrollback").length;

function captureHtmlPreviews() {
  const previews: string[] = [];
  const receive = (event: Event) => {
    previews.push((event as CustomEvent<{ payload: string }>).detail.payload);
    event.stopImmediatePropagation();
  };
  window.addEventListener("mycmux:html-out", receive, true);
  return { previews, stop: () => window.removeEventListener("mycmux:html-out", receive, true) };
}

it("keeps both rows once when a late write callback overlaps a ring sync", async () => {
  await mount();
  const before = scrollbackReads();
  mocks.holdCallbacks = true;
  try {
    await act(async () => output("held-parse-row\r\n"));
    await vi.waitFor(() => expect(mocks.held).toHaveLength(1));
    mocks.raw += "from-resync-row\r\n";
    await act(async () => deliverFrame("", mocks.raw.length, true));
    await vi.waitFor(() => expect(scrollbackReads()).toBeGreaterThan(before), { timeout: 3_500 });
    mocks.holdCallbacks = false;
    for (const callback of mocks.held.splice(0)) callback();
    await vi.waitFor(() => expect(text()).toContain("from-resync-row"));
    expect(text().filter(line => line.endsWith("-row"))).toEqual(["held-parse-row", "from-resync-row"]);
  } finally {
    mocks.holdCallbacks = false;
    for (const callback of mocks.held.splice(0)) callback();
  }
}, 8_000);

it("keeps both live previews when the first is already in the initial ring", async () => {
  const { previews, stop } = captureHtmlPreviews();
  const first = "\x1b]9988;late-one\x07";
  const second = "\x1b]9988;live-two\x07done\r\n";
  const firstOffset = mocks.raw.length;
  mocks.raw += first;
  const secondOffset = mocks.raw.length;
  let complete!: () => void;
  const gate = new Promise<void>(resolve => { complete = resolve; });
  try {
    await mount();
    expect(previews).toEqual(["late-one"]);
    const original = mocks.invoke.getMockImplementation()!;
    const ringRequested = vi.fn();
    mocks.invoke.mockImplementation(async (cmd, ...args) => {
      if (cmd === "get_session_scrollback") {
        ringRequested();
        await gate;
      }
      return original(cmd, ...args);
    });

    mocks.raw += second;
    await act(async () => deliverFrame("", mocks.raw.length, true));
    await vi.waitFor(() => expect(ringRequested).toHaveBeenCalledOnce());
    await act(async () => {
      deliverFrame(first, firstOffset);
      deliverFrame(second, secondOffset);
    });
    expect(previews).toEqual(["late-one"]);
    complete();
    await vi.waitFor(() => expect(text()).toContain("done"));
    await act(async () => output("after-sync\r\n"));
    await vi.waitFor(() => expect(text()).toContain("after-sync"));
    expect(text().filter(Boolean)).toEqual(["P", "done", "after-sync"]);
    expect(previews).toEqual(["late-one", "live-two"]);
  } finally { complete(); stop(); }
});

it("keeps one live preview with an implicit gap that triggers its own ring sync", async () => {
  await mount();
  const { previews, stop } = captureHtmlPreviews();
  const before = scrollbackReads();
  const missing = "missing-from-channel\r\n";
  const preview = "\x1b]9988;behind-gap\x07gap-preview-row\r\n";
  const start = mocks.raw.length + missing.length;
  try {
    mocks.raw += missing + preview;
    await act(async () => deliverFrame(preview, start));
    await vi.waitFor(() => expect(scrollbackReads()).toBeGreaterThan(before));
    await vi.waitFor(() => expect(text()).toContain("gap-preview-row"));
    await act(async () => output("after-gap\r\n"));
    await vi.waitFor(() => expect(text()).toContain("after-gap"));
    expect(text().filter(Boolean)).toEqual(["P", "missing-from-channel", "gap-preview-row", "after-gap"]);
    expect(previews).toEqual(["behind-gap"]);
  } finally { stop(); }
});
