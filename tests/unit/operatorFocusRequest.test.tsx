// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import WebPaneController from "../../src/components/workspace/WebPaneController";
import WebPaneStatusBar from "../../src/components/workspace/WebPaneStatusBar";
import { focusWindow, getWindowFragments, type WindowFragment } from "../../src/lib/ipc";
import { jumpToPaneTab } from "../../src/lib/jumpToPaneTab";
import { isPreparingLayoutQuit, resetLayoutQuitForTests, stopNewLayoutOperations } from "../../src/lib/layoutQuit";
import { connectOperatorFocusWindowNavigation } from "../../src/lib/operatorFocusRequest";
import { windowLabel } from "../../src/lib/windowContext";
import { usePaneDragStore } from "../../src/stores/paneDragStore";
import { isPaneTabClosing } from "../../src/lib/paneCloseOperation";
import { useDashboardViewStore } from "../../src/stores/dashboardViewStore";
import { useGroupingRuntimeStore } from "../../src/stores/groupingRuntimeStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import type { PaneTab, Workspace } from "../../src/types";

const { listen, eventListen, emit, emitTo } = vi.hoisted(() => ({
  listen: vi.fn(),
  eventListen: vi.fn(async (_event: string, _handler: (event: { payload: unknown }) => void, _options?: unknown) => () => {}),
  emit: vi.fn(async (_event: string, _payload: unknown) => {}),
  emitTo: vi.fn(async (_label: string, _event: string, _payload: unknown) => {}),
}));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ listen }) }));
vi.mock("@tauri-apps/api/event", () => ({ emit, emitTo, listen: eventListen }));
vi.mock("../../src/lib/ipc", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/lib/ipc")>(),
  getWindowFragments: vi.fn(async () => []),
  focusWindow: vi.fn(async () => {}),
}));
vi.mock("../../src/lib/jumpToPaneTab", () => ({ jumpToPaneTab: vi.fn() }));
vi.mock("../../src/lib/paneCloseOperation", () => ({ isPaneTabClosing: vi.fn() }));
vi.mock("../../src/components/workspace/webPaneApi", () => ({
  createWebPane: vi.fn(async () => "web-pane-source"),
  destroyWebPane: vi.fn(async () => {}),
  updateWebPane: vi.fn(async () => {}),
  reloadPreviewWebPane: vi.fn(async () => {}),
  loadWebPanePresets: vi.fn(async () => []),
  startWebPaneSignin: vi.fn(),
  WEB_PANE_SIGNIN_EVENT: "mycmux:web-pane-signin",
  WEB_PANE_URL_EVENT: "mycmux:web-pane-url",
}));

const eventName = "mycmux:web-pane-operator-focus";
const peerEventName = "mycmux:web-pane-operator-focus-window";
const ackEventName = "mycmux:web-pane-operator-focus-accepted";
const requestId = "a".repeat(32);
const source: PaneTab = { id: "source", type: "web", presetId: "browser", sessionId: "source-session", agentId: "web" };
const secondSource: PaneTab = { ...source, id: "other-source", sessionId: "other-source-session" };
const target: PaneTab = { id: "target", type: "terminal", sessionId: "target-session", agentId: "terminal" };
const request = { tabId: source.id, targetTabId: target.id, requestId };
let container: HTMLDivElement;
let reactRoot: Root;
let stopPeer: (() => void) | undefined;

function workspace(id: string, paneId: string, ...tabs: PaneTab[]): Workspace {
  return {
    id, name: id, gridTemplateId: "1x1", status: "running", createdAt: 1,
    panes: [{ id: paneId, agentId: tabs[0]!.agentId, sessionId: tabs[0]!.sessionId, activeTabId: tabs[0]!.id, tabs }],
    splitColumns: [[paneId]],
  };
}

function peerFragment(windowLabel: string, pending = false): WindowFragment {
  return {
    window_label: windowLabel, pending,
    workspaces: [{
      id: "remote", name: "remote", grid_template_id: "1x1", created_at: 1,
      panes: [{
        pane_id: "remote-pane", label: null, agent_id: "terminal",
        tabs: [{ tab_id: target.id, session_id: target.sessionId, agent_id: "terminal" }],
      }],
    }],
  };
}

function setLayout(sourceWorkspace: Workspace, targetWorkspace?: Workspace) {
  useWorkspaceListStore.setState({
    workspaces: targetWorkspace ? [sourceWorkspace, targetWorkspace] : [sourceWorkspace],
    activeWorkspaceId: sourceWorkspace.id,
  });
}

async function mount(withSecondSource = false, secondPreset = "browser") {
  await act(async () => {
    reactRoot.render(
      <>
        <WebPaneController />
        <WebPaneStatusBar tabId={source.id} presetId="browser" />
        <div data-web-pane-host-tab-id={source.id} />
        {withSecondSource && <>
          <WebPaneStatusBar tabId={secondSource.id} presetId={secondPreset} />
          <div data-web-pane-host-tab-id={secondSource.id} />
        </>}
      </>,
    );
  });
}

async function send(payload: unknown = request) {
  const handler = listen.mock.calls.find(([event]) => event === eventName)?.[1];
  await act(async () => handler?.({ payload }));
}

function startPeer() {
  stopPeer = connectOperatorFocusWindowNavigation();
}

async function sendPeer(payload: unknown = { targetTabId: target.id, sourceWindow: "mycmux-w-source", requestId,
  expiresAt: Date.now() + 3_000 }) {
  const handler = eventListen.mock.calls.find(([event]) => event === peerEventName)?.[1];
  await act(async () => handler?.({ payload }));
}

function expectStatus(text: string) {
  expect(emit).not.toHaveBeenCalled();
  const status = container.querySelector('[role="status"]');
  expect(status?.textContent).toBe(text);
  expect(status?.nextElementSibling?.getAttribute("data-web-pane-host-tab-id")).toBe(source.id);
  expect(status?.hasAttribute("data-cmux-native-webview-occluder")).toBe(false);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  listen.mockResolvedValue(() => {});
  vi.mocked(getWindowFragments).mockResolvedValue([]);
  vi.mocked(isPaneTabClosing).mockImplementation(() => false);
  useDashboardViewStore.setState({ open: false });
  useUiStore.setState({ isKeybindingsOpen: false, zoomedPaneId: null });
  useGroupingRuntimeStore.setState({ operation: null, transitionDepth: 0 });
  usePaneDragStore.setState({ item: null });
  container = document.body.appendChild(document.createElement("div"));
  reactRoot = createRoot(container);
  setLayout(workspace("from", "source-pane", source), workspace("to", "target-pane", target));
});

afterEach(async () => {
  stopPeer?.();
  stopPeer = undefined;
  await act(async () => reactRoot.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("listens in the owning webview and navigates to the terminal tab in another workspace of that window", async () => {
  await mount();
  expect(listen).toHaveBeenCalledWith(eventName, expect.any(Function));
  await send();
  expect(jumpToPaneTab).toHaveBeenCalledExactlyOnceWith({ workspaceId: "to", paneId: "target-pane", tab: target });
  expect(emitTo).not.toHaveBeenCalled();
  expect(getWindowFragments).not.toHaveBeenCalled();
  expect(container.querySelector('[role="status"]')).toBeNull();
});

it("acknowledges a successful operator focus request once and after jumping to the tab", async () => {
  await mount();
  await send();
  expect(emit).toHaveBeenCalledExactlyOnceWith(ackEventName, { requestId });
  expect(vi.mocked(jumpToPaneTab).mock.invocationCallOrder[0]).toBeLessThan(emit.mock.invocationCallOrder[0]!);
});

it("allows a declared terminal and a legacy tab with no type", async () => {
  const declared: PaneTab = { ...target, type: undefined, lifecycle: "declared" };
  setLayout(workspace("from", "source-pane", source, declared));
  await mount();
  await send();
  expect(jumpToPaneTab).toHaveBeenCalledExactlyOnceWith({ workspaceId: "from", paneId: "source-pane", tab: declared });
});

it("forwards exactly once to a live other window without acknowledging or displaying a refusal", async () => {
  vi.mocked(getWindowFragments).mockResolvedValue([
    peerFragment("mycmux-w-pending", true), peerFragment("mycmux-w-live"),
  ]);
  setLayout(workspace("from", "source-pane", source));
  await mount();
  await send();
  expect(emitTo).toHaveBeenCalledExactlyOnceWith("mycmux-w-live", peerEventName, {
    targetTabId: target.id, sourceWindow: windowLabel(), requestId, expiresAt: expect.any(Number),
  });
  expect(emit).not.toHaveBeenCalled();
  expect(jumpToPaneTab).not.toHaveBeenCalled();
  expect(focusWindow).not.toHaveBeenCalled();
  expect(container.querySelector('[role="status"]')).toBeNull();
});

it("reports missing when only a pending fragment has the target tab", async () => {
  vi.mocked(getWindowFragments).mockResolvedValue([peerFragment("mycmux-w-pending", true)]);
  setLayout(workspace("from", "source-pane", source));
  await mount();
  await send();
  expect(emitTo).not.toHaveBeenCalled();
  expectStatus("そのタブは見つかりませんでした。閉じたか、別の窓にあります。");
});

it("reports a tab missing from all windows", async () => {
  const otherWindow = workspace("other-window", "target-pane", target);
  setLayout(workspace("from", "source-pane", source));
  await mount();
  await send({ ...request, targetTabId: otherWindow.panes[0]!.tabs[0]!.id });
  expect(jumpToPaneTab).not.toHaveBeenCalled();
  expectStatus("そのタブは見つかりませんでした。閉じたか、別の窓にあります。");
  await send({ ...request, targetTabId: "absent" });
  expect(jumpToPaneTab).not.toHaveBeenCalled();
  expectStatus("そのタブは見つかりませんでした。閉じたか、別の窓にあります。");
});

it.each(["web", "browser", "online", "launcher"] as const)("does not activate a %s destination", async type => {
  setLayout(workspace("from", "source-pane", source, { ...target, type }));
  await mount();
  await send();
  expect(jumpToPaneTab).not.toHaveBeenCalled();
  expectStatus("端末のタブではないので、前に出しませんでした。");
});

it("refuses a terminal tab that is closing", async () => {
  vi.mocked(isPaneTabClosing).mockImplementation(tabId => tabId === target.id);
  await mount();
  await send();
  expect(jumpToPaneTab).not.toHaveBeenCalled();
  expectStatus("そのタブは閉じている途中なので、前に出しませんでした。");
});

it.each(["dashboard", "keybindings", "modal", "sweep", "grouping", "dragging", "transition"])("refuses while %s is open or active", async surface => {
  if (surface === "dashboard") useDashboardViewStore.setState({ open: true });
  if (surface === "keybindings") useUiStore.setState({ isKeybindingsOpen: true });
  if (surface === "grouping") useGroupingRuntimeStore.setState({ operation: { kind: "commit", token: Symbol() } });
  if (surface === "transition") useGroupingRuntimeStore.setState({ transitionDepth: 1 });
  if (surface === "dragging") usePaneDragStore.setState({ item: {
    kind: "tab", workspaceId: "to", paneId: "target-pane", tabId: target.id, label: "fixture",
  } });
  const overlay = document.createElement("div");
  if (surface === "modal") overlay.setAttribute("aria-modal", "true");
  if (surface === "sweep") overlay.id = "tab-sweep-panel";
  // The overlay is a sibling of the React root so rendering the fixture does not replace it.
  document.body.appendChild(overlay);
  try {
    await mount();
    await send();
    expect(jumpToPaneTab).not.toHaveBeenCalled();
    expectStatus("いまは前に出せません。開いている画面を閉じてから、もう一度押してください。");
  } finally {
    overlay.remove();
  }
});

it.each(["inactive", "zoomed elsewhere", "preview", "other preset"])("silently drops a request from a %s source", async kind => {
  const modified: PaneTab = kind === "preview"
    ? { ...source, type: "browser", sourceKind: "html", previewPath: "/synthetic/preview.html" }
    : kind === "other preset" ? { ...source, presetId: "chatgpt" } : source;
  setLayout(kind === "inactive"
    ? workspace("from", "source-pane", target, modified)
    : workspace("from", "source-pane", modified, target));
  if (kind === "zoomed elsewhere") useUiStore.setState({ zoomedPaneId: "elsewhere" });
  await mount();
  await send();
  expect(jumpToPaneTab).not.toHaveBeenCalled();
  expect(container.querySelector('[role="status"]')).toBeNull();
});

it("renders the automation refusal in the web pane status strip", async () => {
  await mount();
  await send({ tabId: source.id, refused: "automation" });
  expect(jumpToPaneTab).not.toHaveBeenCalled();
  expectStatus("AI の道具がこの Web タブを操作したので、このタブのボタンでは前に出しません。タブを閉じて開き直すと、また使えます。");
});

it.each([null, {}, { ...request, targetTabId: "wrong\n" }, { ...request, tabId: "unknown" },
  { ...request, refused: "automation" }, { tabId: "source", refused: "other" },
  { ...request, requestId: undefined }, { ...request, requestId: "A".repeat(32) },
  { ...request, requestId: "a".repeat(31) + "\n" }, { ...request, extra: true }])(
  "ignores malformed or unknown event payload %o", async payload => {
    await mount();
    await send(payload);
    expect(jumpToPaneTab).not.toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')).toBeNull();
  },
);


it("receives in the primary webview and requests both window and input focus after selecting the terminal", async () => {
  startPeer();
  expect(eventListen).toHaveBeenCalledWith(peerEventName, expect.any(Function), { target: { kind: "Webview", label: windowLabel() } });
  await sendPeer();
  expect(jumpToPaneTab).toHaveBeenCalledExactlyOnceWith({ workspaceId: "to", paneId: "target-pane", tab: target });
  expect(focusWindow).toHaveBeenCalledExactlyOnceWith(windowLabel(), { focusPrimary: true, expiresAt: expect.any(Number) });
  expect(vi.mocked(jumpToPaneTab).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(focusWindow).mock.invocationCallOrder[0]!);
  expect(emit).not.toHaveBeenCalled();
});

it.each(["missing", "not-terminal", "closing", "dragging", "regrouping", "blocked"] as const)(
  "refuses focus in the destination and reports the result to the source when %s", async state => {
    if (state === "missing") setLayout(workspace("from", "source-pane", source));
    if (state === "not-terminal") setLayout(workspace("from", "source-pane", source, { ...target, type: "launcher" }));
    if (state === "closing") vi.mocked(isPaneTabClosing).mockReturnValue(true);
    if (state === "dragging") usePaneDragStore.setState({ item: {
      kind: "tab", workspaceId: "to", paneId: "target-pane", tabId: target.id, label: "fixture",
    } });
    if (state === "regrouping") useGroupingRuntimeStore.setState({ transitionDepth: 1 });
    if (state === "blocked") useUiStore.setState({ isKeybindingsOpen: true });
    startPeer();
    await sendPeer();
    expect(jumpToPaneTab).not.toHaveBeenCalled();
    expect(focusWindow).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(emitTo).toHaveBeenCalledWith("mycmux-w-source", "mycmux:web-pane-operator-focus-result",
      { requestId, fromWindow: windowLabel(), reason: state === "not-terminal" ? "notTerminal"
        : state === "missing" || state === "closing" ? state : "blocked" });
    expect(container.querySelector('[role="status"]')).toBeNull();
  },
);

it.each([
  { state: "before quit preparation", reason: null, preparing: false, expired: false, dashboard: false },
  { state: "under the dashboard", reason: "blocked", preparing: false, expired: false, dashboard: true },
  { state: "after quit preparation", reason: "blocked", preparing: true, expired: false, dashboard: false },
  { state: "after quit preparation with an expired request", reason: "timeout", preparing: true, expired: true, dashboard: false },
])("preserves the peer focus result $state with real layout selection", async ({ reason, preparing, expired, dashboard }) => {
  const realFocus = await vi.importActual<typeof import("../../src/lib/jumpToPaneTab")>("../../src/lib/jumpToPaneTab");
  vi.mocked(jumpToPaneTab).mockImplementation(realFocus.jumpToPaneTab);
  const currentTab = { ...target, id: "current", sessionId: "current-session" };
  const destination = workspace("to", "target-pane", currentTab, target);
  setLayout(workspace("from", "source-pane", source), destination);
  useUiStore.getState().setActivePaneId(source.sessionId);
  try {
    startPeer();
    if (preparing) {
      await stopNewLayoutOperations();
      document.body.setAttribute("inert", "");
    }
    expect(isPreparingLayoutQuit()).toBe(preparing);
    useDashboardViewStore.setState({ open: dashboard });
    const expiresAt = Date.now() + (expired ? -1 : 1_000);
    await sendPeer({ targetTabId: target.id, sourceWindow: "mycmux-w-source", requestId, expiresAt });
    const layout = useWorkspaceListStore.getState();
    expect(layout.activeWorkspaceId).toBe(reason === null ? "to" : "from");
    expect(layout.getWorkspace("to")?.panes[0].activeTabId).toBe(reason === null ? target.id : currentTab.id);
    if (reason === null) {
      expect(focusWindow).toHaveBeenCalledExactlyOnceWith(windowLabel(), { focusPrimary: true, expiresAt });
    } else {
      expect(focusWindow).not.toHaveBeenCalled();
    }
    expect(emitTo).toHaveBeenCalledExactlyOnceWith("mycmux-w-source", "mycmux:web-pane-operator-focus-result",
      { requestId, fromWindow: windowLabel(), reason });
  } finally {
    document.body.removeAttribute("inert");
    resetLayoutQuitForTests();
    vi.mocked(jumpToPaneTab).mockReset();
  }
});

it.each([null, {}, { targetTabId: "bad\n" }, { targetTabId: target.id, extra: true }])(
  "drops a malformed request to focus this window %o", async payload => {
    startPeer();
    await sendPeer(payload);
    expect(jumpToPaneTab).not.toHaveBeenCalled();
    expect(focusWindow).not.toHaveBeenCalled();
  },
);


it("keeps notices and their eight-second timers independent for each Web pane", async () => {
  const both = workspace("from", "source-pane", source);
  both.panes.push(workspace("second", "second-pane", secondSource).panes[0]!);
  setLayout(both, workspace("to", "target-pane", target));
  const automation = { tabId: source.id, refused: "automation" };
  const otherAutomation = { ...automation, tabId: secondSource.id };
  const shownFor = () => Array.from(container.querySelectorAll('[role="status"]'), node =>
    node.nextElementSibling?.getAttribute("data-web-pane-host-tab-id"));
  const advance = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });
  vi.useFakeTimers();
  try {
    await mount(true);
    await send(automation);
    await advance(1_000);
    await send(otherAutomation);
    expect(shownFor()).toEqual([source.id, secondSource.id]);
    await send({ ...request, tabId: secondSource.id });
    expect(shownFor()).toEqual([source.id]);
    await advance(1_000);
    await send(otherAutomation);
    await advance(6_000);
    expect(shownFor()).toEqual([secondSource.id]);
    await advance(2_000);
    expect(shownFor()).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

it("shows the reply-wait message for eight seconds per pane and refreshes that pane's clock", async () => {
  const both = workspace("from", "source-pane", source);
  const service = { ...secondSource, presetId: "chatgpt" };
  both.panes.push(workspace("second", "second-pane", service).panes[0]!);
  setLayout(both, workspace("to", "target-pane", target));
  const status = () => Array.from(container.querySelectorAll('[data-web-pane-notice="shortcut-waiting"]'));
  const shownFor = () => status().map(node => node.nextElementSibling?.getAttribute("data-web-pane-host-tab-id"));
  const advance = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });
  vi.useFakeTimers();
  try {
    await mount(true, service.presetId);
    const handler = listen.mock.calls.find(([event]) => event === "mycmux:web-pane-shortcut-waiting")?.[1];
    expect(handler).toBeTypeOf("function");
    const sendWaiting = (payload: unknown) => act(async () => handler?.({ payload }));
    await sendWaiting("unknown-tab");
    await sendWaiting({ tabId: source.id });
    expect(status()).toHaveLength(0);
    await sendWaiting(source.id);
    expect(status()[0]?.textContent).toBe("AI の操作の返事を待っているので、mycmux のキーを止めています。");
    await advance(1_000);
    await sendWaiting(service.id);
    expect(shownFor()).toEqual([source.id, service.id]);
    await advance(1_000);
    await sendWaiting(source.id);
    await advance(7_000);
    expect(shownFor()).toEqual([source.id]);
    await advance(1_000);
    expect(status()).toHaveLength(0);
  } finally {
    vi.useRealTimers();
  }
});

it("also places the blocked refusal in the pane strip above the native webview host", async () => {
  useUiStore.setState({ isKeybindingsOpen: true });
  await mount();
  await send();
  const strip = container.querySelector('[data-web-pane-notice="blocked"]');
  const overlay = document.querySelector("[data-operator-focus-blocked-notice]");
  expect(strip?.getAttribute("role")).toBe("status");
  expect(strip?.textContent).toBe(overlay?.textContent);
  expect(strip?.nextElementSibling?.getAttribute("data-web-pane-host-tab-id")).toBe(source.id);
  expect(overlay?.getAttribute("aria-hidden")).toBe("true");
});

it("renders the blocked refusal above the overlay while it is still open", async () => {
  const overlay = document.createElement("div");
  overlay.setAttribute("aria-modal", "true");
  document.body.append(overlay);
  try {
    await mount();
    await send();
    const notice = document.querySelector<HTMLElement>("[data-operator-focus-blocked-notice]");
    expect(overlay.isConnected).toBe(true);
    expect(notice?.parentElement).toBe(document.body);
    expect(notice?.style.pointerEvents).toBe("none");
    expect(notice?.textContent).toBe("いまは前に出せません。開いている画面を閉じてから、もう一度押してください。");
  } finally {
    overlay.remove();
  }
});


it("L6 reports the refusal to the source window if the destination has a dialog open", async () => {
  useUiStore.setState({ isKeybindingsOpen: true });
  startPeer();
  await sendPeer();
  expect(focusWindow).not.toHaveBeenCalled();
  expect(emitTo).toHaveBeenCalledWith("mycmux-w-source", "mycmux:web-pane-operator-focus-result",
    { requestId, fromWindow: windowLabel(), reason: "blocked" });
});


it("L6 shows a correlated peer refusal in the initiating browser pane", async () => {
  vi.mocked(getWindowFragments).mockResolvedValue([peerFragment("mycmux-w-live")]);
  setLayout(workspace("from", "source-pane", source));
  await mount();
  await send();
  const result = eventListen.mock.calls.find(([name]) => name === "mycmux:web-pane-operator-focus-result")?.[1];
  expect(result).toBeDefined();
  await act(async () => result?.({ payload: { requestId, fromWindow: "other", reason: "missing" } }));
  expect(container.querySelector('[role="status"]')).toBeNull();
  await act(async () => result?.({ payload: { requestId, fromWindow: "mycmux-w-live", reason: "missing" } }));
  expectStatus("そのタブは見つかりませんでした。閉じたか、別の窓にあります。");
});

it("L6 fix2 rejects a focus request delivered after the originating window timed out", async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(getWindowFragments).mockResolvedValue([peerFragment("mycmux-w-live")]);
    setLayout(workspace("from", "source-pane", source));
    await mount();
    await send();
    const forwarded = emitTo.mock.calls.find(([, event]) => event === peerEventName)?.[2] as object;
    expect(forwarded).toBeDefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(3_001); });
    setLayout(workspace("from", "source-pane", source), workspace("to", "target-pane", target));
    startPeer();
    await sendPeer({ ...forwarded, sourceWindow: "mycmux-w-source" });
    expect(jumpToPaneTab).not.toHaveBeenCalled();
    expect(focusWindow).not.toHaveBeenCalled();
    expectStatus("移動先の窓から応答がありませんでした。もう一度押してください。");
  } finally {
    vi.useRealTimers();
  }
});

it("L6 fix3 passes the origin deadline into a queued native focus operation", async () => {
  setLayout(workspace("from", "source-pane", source), workspace("to", "target-pane", target));
  startPeer();
  const expiresAt = Date.now() + 5;
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const foreground = vi.fn();
  vi.spyOn(Date, "now").mockReturnValue(expiresAt - 1);
  vi.mocked(focusWindow).mockImplementationOnce(async (_label, options) => {
    await waiting;
    const deadline = (options as { expiresAt?: number } | undefined)?.expiresAt;
    if (deadline !== undefined && Date.now() >= deadline) throw "focus_request_expired";
    foreground();
  });
  try {
    const handler = eventListen.mock.calls.find(([event]) => event === peerEventName)![1];
    const result = handler({ payload: { targetTabId: target.id, sourceWindow: "mycmux-w-source", requestId, expiresAt } });
    expect(jumpToPaneTab).toHaveBeenCalledOnce();
    vi.mocked(Date.now).mockReturnValue(expiresAt + 1);
    release();
    await result;
    expect(foreground).not.toHaveBeenCalled();
    expect(emitTo).toHaveBeenCalledWith("mycmux-w-source", "mycmux:web-pane-operator-focus-result",
      { requestId, fromWindow: windowLabel(), reason: "timeout" });
  } finally {
    release();
    vi.mocked(Date.now).mockRestore();
  }
});
