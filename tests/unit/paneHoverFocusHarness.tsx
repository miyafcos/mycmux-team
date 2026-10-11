import { act, StrictMode, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";
import type { Pane, PaneTab, Workspace } from "../../src/types";

const harnessMocks = vi.hoisted(() => ({
  invoke: vi.fn(), renders: 0, accepted: [] as Array<[string, string]>, refused: new Set<string>(),
  focus: new Map<string, ReturnType<typeof vi.fn>>(), props: new Map<string, any>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: harnessMocks.invoke, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}), emit: vi.fn(), emitTo: vi.fn() }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
vi.mock("../../src/components/workspace/PaneTabBar", () => ({ default: () => <div className="pane-tabbar"><button>toolbar</button></div> }));
vi.mock("../../src/components/workspace/BrowserPane", () => ({ default: () => <div data-browser><textarea /><iframe /><embed /><object /></div> }));
vi.mock("../../src/components/workspace/WebPaneStatusBar", () => ({ default: () => <div data-web-toolbar /> }));
vi.mock("../../src/components/online/OnlinePanel", () => ({ default: () => <div data-online /> }));
vi.mock("../../src/components/composer/PaneComposer", () => ({ PaneComposer: ({ sessionId }: any) => <div data-composer-session={sessionId}><textarea /><span>badge</span></div> }));
vi.mock("../../src/components/terminal/XTermWrapper", async () => {
  const React = await import("react");
  const { focusController } = await import("../../src/lib/focusController");
  const { registerTerminalFocusSync } = await import("../../src/components/terminal/terminalFocusHelpers");
  return { hasTerminalBuffer: () => false, evictTerminalCache: vi.fn(), default: (props: any) => {
    harnessMocks.renders++; harnessMocks.props.set(props.sessionId, props);
    const ref = React.useRef<HTMLTextAreaElement>(null);
    const terminalRef = React.useRef<HTMLDivElement>(null);
    React.useEffect(() => {
      const focus = vi.fn(() => { if (!harnessMocks.refused.has(props.sessionId)) ref.current?.focus(); });
      harnessMocks.focus.set(props.sessionId, focus);
      return registerTerminalFocusSync({ element: terminalRef.current, focus } as any, props.sessionId);
    }, [props.sessionId]);
    return <div className="xterm" data-xterm={props.sessionId} ref={terminalRef}>
      <div data-screen><span data-line>output</span></div>
      <textarea className="xterm-helper-textarea" ref={ref} onInput={(e) => {
        if (!focusController.shouldSuppressWheelFocusInput(props.sessionId) && focusController.shouldAcceptTerminalInput(props.sessionId)) {
          harnessMocks.accepted.push([props.sessionId, e.currentTarget.value]);
        }
      }} />
    </div>;
  } };
});

import TerminalPane from "../../src/components/workspace/TerminalPane";
import { usePaneHoverFocus } from "../../src/hooks/usePaneHoverFocus";
import { focusController } from "../../src/lib/focusController";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { usePaneDragStore } from "../../src/stores/paneDragStore";
import { useSavepointDragStore } from "../../src/stores/savepointDragStore";
import { useDetachedDockStore } from "../../src/stores/detachedDockStore";
import { prepareStartupSessionGate } from "../../src/lib/startupSessionGate";
import { rememberTearoutDormantSessions } from "../../src/lib/tearout/sessionAttachment";

export const mocks = harnessMocks;
let hoverRequests = 0;
export let root: Root, host: HTMLDivElement;
export let frames: FrameRequestCallback[];
export let hit: Element | null;
export const resizes: TestResize[] = [];
class TestResize {
  targets = new Set<Element>();
  constructor(public callback: ResizeObserverCallback) { resizes.push(this); }
  observe(el: Element) { this.targets.add(el); }
  unobserve(el: Element) { this.targets.delete(el); }
  disconnect() { this.targets.clear(); }
  fire() { this.callback([], this as unknown as ResizeObserver); }
}
export function pane(id: string, patch: Partial<PaneTab> = {}): Pane {
  const tab: PaneTab = { id: `t-${id}`, sessionId: id, agentId: "shell", ...patch };
  return { id: `p-${id}`, sessionId: id, agentId: "shell", activeTabId: tab.id, tabs: [tab] };
}
export function workspace(panes = [pane("a"), pane("b")], id = "w"): Workspace {
  return { id, name: id, status: "running", gridTemplateId: "1x1", createdAt: 1, panes,
    splitColumns: [panes.map((p) => p.id)] };
}
export function setup(mode: "hover" | "click" = "hover") {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.useFakeTimers();
  frames = []; hit = null; resizes.length = 0; hoverRequests = 0;
  const request = focusController.request;
  vi.spyOn(focusController, "request").mockImplementation((source, intent) => {
    if (source === "hover") hoverRequests++;
    request(source, intent);
  });
  harnessMocks.invoke.mockReset(); harnessMocks.invoke.mockImplementation((name: string) => Promise.resolve(name === "get_test_profile" ? null : []));
  harnessMocks.accepted.length = 0; harnessMocks.focus.clear(); harnessMocks.props.clear(); harnessMocks.refused.clear(); harnessMocks.renders = 0;
  vi.stubGlobal("ResizeObserver", TestResize);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => hit) });
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(() => [{ width: 400, height: 300 }] as any);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ x: 0, y: 0, top: 0, left: 0, right: 400, bottom: 300, width: 400, height: 300, toJSON() {} }));
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((fn) => { frames.push(fn); return frames.length; });
  prepareStartupSessionGate([]);
  rememberTearoutDormantSessions(["a", "b"], ["a", "b"]);
  useSettingsStore.setState({ paneFocusMode: mode, paneComposerEnabled: false });
  useUiStore.setState({ activePaneId: "a", focusRevision: 0, zoomedPaneId: null });
  useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: "w", layoutRevision: 0 });
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} });
  usePaneDragStore.setState({ item: null, target: null }); useSavepointDragStore.setState({ item: null, target: null });
  useDetachedDockStore.setState({ active: null, target: null });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
}
export async function mount(ws = workspace(), strict = false) {
  useWorkspaceListStore.setState({ workspaces: [ws], activeWorkspaceId: ws.id });
  const contents = ws.panes.map((p) => <TerminalPane key={p.id} pane={p} workspaceId={ws.id} />);
  await act(async () => { root.render(strict ? <StrictMode>{contents}</StrictMode> : <>{contents}</>); });
  return ws;
}
export async function cleanup() {
  await act(async () => { root.unmount(); });
  for (const id of harnessMocks.focus.keys()) focusController.clearSession(id);
  vi.clearAllTimers(); frames.length = 0; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  document.body.replaceChildren(); localStorage.clear();
}
export function content(id = "b"): HTMLElement {
  return host.querySelector<HTMLElement>(`[data-dnd-pane-id='p-${id}'] [data-dnd-handoff-surface]`)!;
}
export function textarea(id = "b"): HTMLTextAreaElement { return host.querySelector(`[data-xterm='${id}'] textarea`)!; }
export function pointer(el: Element, type = "pointermove", patch: Record<string, unknown> = {}) {
  hit = el;
  const event = new MouseEvent(type, { bubbles: type !== "pointerenter" && type !== "pointerleave", cancelable: true,
    clientX: 20, clientY: 20, button: 0, buttons: 0, ...patch });
  for (const [key, value] of Object.entries({ pointerType: "mouse", pointerId: 1, movementX: 1, movementY: 0, ...patch })) {
    Object.defineProperty(event, key, { value });
  }
  el.dispatchEvent(event); return event;
}
export function frame() { for (const fn of frames.splice(0)) fn(0); }
export async function advance(ms = 100, focus = true) {
  await act(async () => {
    const before = useUiStore.getState().activePaneId;
    const beforeRequests = hoverRequests;
    vi.advanceTimersByTime(ms);
    if (focus) {
      // Fake timers defer a nested zero-delay timeout to the following tick.
      vi.advanceTimersByTime(before !== useUiStore.getState().activePaneId || beforeRequests !== hoverRequests || ms === 0 ? 1 : 0);
      frame();
    }
  });
}
export function field(tag = "input", attributes: Record<string, string> = {}): HTMLElement {
  const el = document.createElement(tag); for (const [k, v] of Object.entries(attributes)) el.setAttribute(k, v);
  el.tabIndex = 0; document.body.append(el); el.focus(); return el;
}
/** 12 lightweight surfaces exercise the real runtime without terminal render noise. */
export function Surface({ p }: { p: Pane }) {
  const ref = useRef<HTMLDivElement>(null);
  harnessMocks.renders++;
  const enabled = usePaneHoverFocus(ref, { enabled: true, workspaceId: "w", paneId: p.id,
    tabId: p.activeTabId, sessionId: p.sessionId, kind: "terminal",
    onActivate: (focusGuard, commitHoverSelection, onHoverFocusAborted) => focusController.commit("hover", p.sessionId, { focusGuard, commitHoverSelection, onHoverFocusAborted }) });
  useEffect(() => focusController.registerTerminal(p.sessionId, { focus: () => {}, containsActiveElement: () => true }), [p.sessionId]);
  return <div data-dnd-pane-id={p.id}><div ref={ref} data-pane-hover-focus-surface={enabled ? "terminal" : undefined}><span /></div></div>;
}
