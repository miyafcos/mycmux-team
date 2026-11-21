// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), nextContext: 0, nextChannel: 0, seq: 0, backendAt: 0, blockPaint: false,
  webglOwners: new Set<object>(), exit: undefined as (() => void) | undefined,
  channelMismatch: false,
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
        super.onRender(event => { if (!mocks.blockPaint || !mocks.webglOwners.has(this)) listener(event); });
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
import XTermWrapper from "../../src/components/terminal/XTermWrapper";
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
  const bytes = new TextEncoder().encode(data), start = mocks.offset + new TextEncoder().encode(mocks.raw).length;
  mocks.raw += data;
  const frame = new ArrayBuffer(40 + bytes.length), view = new DataView(frame);
  new Uint8Array(frame).set([0x4d, 0x43, 0x58, 0x31]);
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
  mocks.seq = 0; mocks.backendAt = 0; mocks.blockPaint = false;
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
  vi.spyOn(Date, "now").mockImplementation(() => now);
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
  vi.setSystemTime(Date.now() + 11_000);
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
    ["is_session_alive", "get_session_scrollback", "resize_session", "write_to_session"].includes(cmd))).toBe(false);
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
