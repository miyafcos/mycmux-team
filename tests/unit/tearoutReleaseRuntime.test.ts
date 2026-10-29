// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ listeners: new Map<string, Set<(event: { payload: any }) => void>>(),
  invoke: vi.fn(), emitTo: vi.fn(), frames: new Map<string, any>(), decisions: [] as any[],
  raf: new Map<number, FrameRequestCallback>(), nextFrame: 0, beginReply: null as Promise<any> | null }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async (name: string, callback: (event: { payload: any }) => void) => {
  const callbacks = mocks.listeners.get(name) ?? new Set(); callbacks.add(callback); mocks.listeners.set(name, callbacks);
  return () => callbacks.delete(callback);
}, emit: vi.fn(), emitTo: mocks.emitTo }));
vi.mock("../../src/lib/windowContext", () => ({ windowLabel: () => "main", isMainWindow: () => true }));
vi.mock("@tauri-apps/api/window", async original => ({ ...await original<typeof import("@tauri-apps/api/window")>(),
  getAllWindows: async () => [{ label: "main" }, { label: "child" }] }));
vi.mock("../../src/lib/tearout/sessionAttachment", () => ({ expectTearoutAttachments: () => ({ ready: Promise.resolve(), dispose() {} }), rememberTearoutDormantSessions: vi.fn() }));
import { installTearoutRuntime, regrabTearoutWindow, tearoutTab } from "../../src/lib/tearout/runtime";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useDetachedDockStore } from "../../src/stores/detachedDockStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useToastStore } from "../../src/stores/toastStore";
import { endTearoutOperation, tearoutOperationBusy, tearoutDisplayBusy, tearoutDisplayReasons } from "../../src/lib/tearout/operation";
import { toTransferConfig } from "../../src/components/layout/SocketListener";
import type { Workspace } from "../../src/types";
function workspace(id = "w"): Workspace {
  return { id, name: id, createdAt: 1, status: "running", gridTemplateId: "1x1", splitColumns: [["p"]],
    columnWidths: [1], rowHeightsPerCol: [[1]], panes: [{ id: "p", sessionId: "pty-live", agentId: "shell", activeTabId: "t",
      tabs: [{ id: "t", sessionId: "pty-live", agentId: "shell", type: "terminal" }] }] };
}
const delivered: { token: string; source: string }[] = [];
function dispatch(name: string, payload: unknown) {
  if (name === "mycmux://tearout-delivery") delivered.push(payload as { token: string; source: string });
  for (const callback of [...(mocks.listeners.get(name) ?? [])]) callback({ payload }); }
function frame(id = "release", x = 150, y = 150, epoch = 1) {
  return { id, mode: "dock" as const, label: "child", source: "child", receiver: "main", receiver_epoch: epoch, region_count: 1,
    client_x: x, client_y: y, token: `token-${id}`, point: { x: -1200, y: 150, at: 1000, method: "native_up" } };
}
async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
async function paint() {
  const callbacks = [...mocks.raf.values()]; mocks.raf.clear(); callbacks.forEach(cb => cb(performance.now())); await flush();
}
let stop: () => void;
let pane: HTMLElement;
let strip: HTMLElement;
beforeEach(async () => {
  vi.clearAllMocks(); mocks.listeners.clear(); mocks.frames.clear(); mocks.decisions = []; mocks.raf.clear(); mocks.beginReply = null;
  endTearoutOperation();
  Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
  window.__MYCMUX_TEAROUT_PERF__ = false;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { const id = ++mocks.nextFrame; mocks.raf.set(id, callback); return id; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { mocks.raf.delete(id); });
  useSettingsStore.setState({ nativePaneTearoutEnabled: true });
  useWorkspaceListStore.setState({ workspaces: [workspace()], activeWorkspaceId: "w" });
  useUiStore.setState({ activePaneId: "pty-live", zoomedPaneId: null });
  useDetachedDockStore.getState().clear(); useToastStore.setState({ toasts: [] });
  pane = document.createElement("div"); Object.assign(pane.dataset, { dndPaneId: "p", dndWorkspaceId: "w" });
  pane.getBoundingClientRect = () => new DOMRect(0, 30, 300, 240);
  strip = document.createElement("div"); strip.className = "pane-tabbar"; pane.append(strip); document.body.append(pane);
  strip.getBoundingClientRect = () => new DOMRect(0, 30, 300, 36);
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: (x: number, y: number) =>
    x >= 0 && x < 300 && y >= 30 && y < 270 ? y < 66 ? strip : pane : null });
  mocks.invoke.mockImplementation(async (command: string, args: any) => {
    if (command === "is_session_alive") return true;
    if (command === "tearout_release_begin") return mocks.beginReply ?? mocks.frames.get(args.id);
    if (command === "tearout_release_decision") { mocks.decisions.push(args); return true; }
    if (command === "tearout_release_consume") return true;
  });
  mocks.emitTo.mockImplementation(async () => {});
  stop = installTearoutRuntime({ serialize: toTransferConfig, publish: async () => {} }); await flush();
});
afterEach(async () => {
  for (const delivery of delivered.splice(0)) dispatch("mycmux://tearout-revoke", { ...delivery, ack: `cleanup-${delivery.token}` });
  await flush(); stop(); await flush(); endTearoutOperation(); document.body.replaceChildren(); vi.restoreAllMocks(); delete window.__MYCMUX_TEAROUT_PERF__; });
async function request(release = frame()) {
  mocks.frames.set(release.id, release);
  dispatch("mycmux://tearout-release", { id: release.id, epoch: release.receiver_epoch }); await flush();
}
async function finishPaint() { await paint(); await paint(); await flush(); }
describe("authoritative receiver resolution (R1/R2/R3/R6/R7/R8/R11)", () => {
  it("review ignores unrelated geometry, sessionId and type at the post-paint validation", async () => {
    const heading = document.createElement("span"); heading.dataset.tabId = "t"; strip.append(heading);
    let width = 70; heading.getBoundingClientRect = () => new DOMRect(0, 30, width, 36);
    await request(frame("review-post-paint")); width = 210; heading.textContent = "changed status";
    useWorkspaceListStore.setState(state => ({ workspaces: state.workspaces.map(ws => ({ ...ws, panes: ws.panes.map(p => ({ ...p,
      tabs: p.tabs.map(tab => ({ ...tab, sessionId: "changed-session", type: "web" as const })) })) })) }));
    await finishPaint();
    expect(mocks.decisions[0]).toMatchObject({ error: null, target: { kind: "pane-zone", zone: "center" } });
    const decision = mocks.decisions[0];
    const cfg = toTransferConfig(workspace("review-post-paint-incoming"));
    cfg.panes[0].tabs![0].tab_id = "post-paint-new"; cfg.panes[0].tabs![0].session_id = "pty-post-paint-new";
    dispatch("mycmux://tearout-delivery", { token: "review-post-paint-adopt", source: "child", configs: [cfg], placement: decision.target,
      approval: { receiver: "main", token: "token-review-post-paint", target: decision.target,
        release_id: "review-post-paint", layout_revision: decision.layoutRevision } });
    await vi.waitFor(() => expect(mocks.emitTo).toHaveBeenCalledWith("child", "mycmux://tearout-receipt", { token: "review-post-paint-adopt", ok: true }));
  });
  it.each([false, true])("review tab-index accepts heading changes and rejects resized strips: resized=%s", async resized => {
    const heading = document.createElement("span"); heading.dataset.tabId = "t"; strip.append(heading);
    let width = 70; heading.getBoundingClientRect = () => new DOMRect(0, 30, width, 36);
    const release = frame(`review-strip-${resized}`, 150, 45); await request(release); await finishPaint();
    width = 210; heading.textContent = "changed status";
    if (resized) strip.getBoundingClientRect = () => new DOMRect(0, 30, 450, 36);
    const cfg = toTransferConfig(workspace("review-strip-incoming")); cfg.panes[0].tabs![0].tab_id = "strip-new";
    cfg.panes[0].tabs![0].session_id = "pty-strip-new";
    const decision = mocks.decisions[0]; const token = `review-strip-delivery-${resized}`;
    dispatch("mycmux://tearout-delivery", { token, source: "child", configs: [cfg], placement: { ...decision.target, kind: "pane" },
      approval: { receiver: "main", token: release.token, target: decision.target, release_id: release.id, layout_revision: decision.layoutRevision } });
    await vi.waitFor(() => expect(mocks.emitTo.mock.calls.find(([, event, value]) => event.endsWith("tearout-receipt") && value.token === token)?.[2].ok).toBe(!resized));
  });
  it.each([false, true])("review workspace approval ignores other panes but rejects sidebar geometry: resized=%s", async resized => {
    const sidebar = document.createElement("div"); sidebar.dataset.dndWorkspaceSidebar = "true"; document.body.append(sidebar);
    let width = 150; sidebar.getBoundingClientRect = () => new DOMRect(0, 0, width, 600);
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => sidebar });
    const release = frame(`review-sidebar-${resized}`); await request(release);
    pane.getBoundingClientRect = () => new DOMRect(0, 30, 900, 400); await finishPaint();
    expect(mocks.decisions[0].target).toEqual({ kind: "workspace" });
    if (resized) width = 180;
    const cfg = toTransferConfig(workspace("review-sidebar-incoming")); cfg.panes[0].tabs![0].tab_id = "sidebar-new";
    cfg.panes[0].tabs![0].session_id = "pty-sidebar-new";
    const decision = mocks.decisions[0]; const token = `review-sidebar-delivery-${resized}`;
    dispatch("mycmux://tearout-delivery", { token, source: "child", configs: [cfg], placement: decision.target,
      approval: { receiver: "main", token: release.token, target: decision.target, release_id: release.id, layout_revision: decision.layoutRevision } });
    await vi.waitFor(() => expect(mocks.emitTo.mock.calls.find(([, event, value]) => event.endsWith("tearout-receipt") && value.token === token)?.[2].ok).toBe(!resized));
  });
  it.each([false, true])("review holds the receiver clock across native end until resolve or expiry: resolves=%s", async resolves => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args: any) => command === "tearout_preview" ? Promise.resolve(true) : original(command, args));
    const release = frame(`review-gap-${resolves}`);
    const clearing: boolean[] = [];
    const unsubscribe = useDetachedDockStore.subscribe((state, before) => {
      if (before.target && !state.target) clearing.push(tearoutDisplayBusy());
    });
    try {
      dispatch("mycmux://tearout-native", { ...release, phase: "move", at: 0, escaped: false }); await paint();
      dispatch("mycmux://tearout-native", { ...release, phase: "move", at: 121, escaped: false }); await paint();
      expect(useDetachedDockStore.getState().target).not.toBeNull();
      dispatch("mycmux://tearout-native", { ...release, phase: "end", at: 130, escaped: false, release: release.point, approval: null });
      expect(clearing).toEqual([true]);
      expect(tearoutDisplayReasons().displayActivity).toContain(`release-await:${release.id}`);
      if (resolves) { await request(release); await finishPaint(); }
      else await vi.advanceTimersByTimeAsync(500);
      expect(tearoutDisplayReasons().displayActivity).not.toContain(`release-await:${release.id}`);
    } finally { unsubscribe(); vi.useRealTimers(); }
  });
  it.each(["Win32", "MacIntel"])("2a ignores status header widths and session metadata during %s adoption", async platform => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
    const heading = document.createElement("span"); heading.dataset.tabId = "t"; strip.append(heading);
    let width = 80;
    const measure = vi.fn(() => new DOMRect(0, 30, width, 36)); heading.getBoundingClientRect = measure;
    const release = frame(); await request(release); await finishPaint();
    width = 180;
    useWorkspaceListStore.setState(state => ({ workspaces: state.workspaces.map(ws => ({ ...ws,
      panes: ws.panes.map(p => ({ ...p, tabs: p.tabs.map(t => ({ ...t, agentId: "updated-agent" })) })) })) }));
    const cfg = toTransferConfig(workspace("incoming-status"));
    cfg.panes[0].tabs![0].tab_id = "status-new"; cfg.panes[0].tabs![0].session_id = "pty-status-new";
    const decision = mocks.decisions[0];
    const token = `status-delivery-${platform}`;
    dispatch("mycmux://tearout-delivery", { token, source: "child", configs: [cfg], placement: decision.target, dock: { requester: "child" },
      approval: { receiver: "main", token: release.token, target: decision.target, release_id: release.id, layout_revision: decision.layoutRevision } });
    await flush();
    await vi.waitFor(() => expect(mocks.emitTo).toHaveBeenCalledWith("child", "mycmux://tearout-receipt", expect.objectContaining({ token, ok: true })));
    const receipt = mocks.emitTo.mock.calls.find(([, event, value]) => event.endsWith("tearout-receipt") && value.token === token)![2];
    expect(receipt.dock_stages.map((stage: any) => stage.stage)).toEqual(expect.arrayContaining([
      "attachment_prepared_wait", "attachment_prepared", "consume_wait", "consumed", "session_alive_wait", "session_alive", "layout",
      "attachment_wait", "attached", "publish_wait", "published", "receipt"]));
    expect(measure).not.toHaveBeenCalled();
  });
  it.each(["Win32", "MacIntel"])("2a rejects a target resize after token consumption on %s", async platform => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
    const release = frame(); await request(release); await finishPaint();
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: any) => {
      if (command === "tearout_release_consume") pane.getBoundingClientRect = () => new DOMRect(0, 30, 450, 240);
      return original(command, args);
    });
    const cfg = toTransferConfig(workspace("incoming-resize"));
    cfg.panes[0].tabs![0].tab_id = "resize-new"; cfg.panes[0].tabs![0].session_id = "pty-resize-new";
    const decision = mocks.decisions[0];
    const token = `resize-delivery-${platform}`;
    dispatch("mycmux://tearout-delivery", { token, source: "child", configs: [cfg], placement: decision.target,
      approval: { receiver: "main", token: release.token, target: decision.target, release_id: release.id, layout_revision: decision.layoutRevision } });
    await flush();
    await vi.waitFor(() => expect(mocks.emitTo.mock.calls.find(([, name, receipt]) => name.endsWith("tearout-receipt") && receipt.token === token)?.[2].ok).toBe(false));
    expect(useWorkspaceListStore.getState().workspaces[0].panes[0].tabs.map(tab => tab.id)).toEqual(["t"]);
  });
  it.each(["model", "dom"])("2a rejects reordered tab-strip IDs in the %s after acknowledgement", async change => {
    useWorkspaceListStore.setState(state => ({ workspaces: state.workspaces.map(ws => ({ ...ws, panes: ws.panes.map(p => ({ ...p,
      tabs: [...p.tabs, { ...p.tabs[0], id: "second", sessionId: "pty-second" }] })) })) }));
    for (const id of ["t", "second"]) { const tab = document.createElement("span"); tab.dataset.tabId = id; strip.append(tab); }
    const release = frame("strip-order", 150, 45); await request(release); await finishPaint();
    if (change === "dom") strip.prepend(strip.lastElementChild!);
    else useWorkspaceListStore.setState(state => ({ workspaces: state.workspaces.map(ws => ({ ...ws,
      panes: ws.panes.map(p => ({ ...p, tabs: [...p.tabs].reverse() })) })) }));
    const cfg = toTransferConfig(workspace("incoming-order"));
    cfg.panes[0].tabs![0].tab_id = "order-new"; cfg.panes[0].tabs![0].session_id = "pty-order-new";
    const decision = mocks.decisions[0];
    const token = `order-delivery-${change}`;
    dispatch("mycmux://tearout-delivery", { token, source: "child", configs: [cfg], placement: { ...decision.target, kind: "pane" },
      approval: { receiver: "main", token: release.token, target: decision.target, release_id: release.id, layout_revision: decision.layoutRevision } });
    await flush();
    await vi.waitFor(() => expect(mocks.emitTo.mock.calls.find(([, name, receipt]) => name.endsWith("tearout-receipt") && receipt.token === token)?.[2].ok).toBe(false));
  });
  it.each(["expiry", "dispose"])("2a releases the display clock reservation on approval %s", async ending => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      await request(frame(`clock-${ending}`)); await finishPaint();
      expect(tearoutDisplayBusy()).toBe(true);
      if (ending === "dispose") { stop(); await flush(); }
      else await vi.advanceTimersByTimeAsync(6000);
      expect(tearoutDisplayBusy()).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it("2a releases display holds when disposing during a stalled consume IPC", async () => {
    const release = frame("stalled-consume"); await request(release); await finishPaint();
    const original = mocks.invoke.getMockImplementation()!;
    let consumed = (_accepted: boolean) => {};
    mocks.invoke.mockImplementation((command: string, args: any) => command === "tearout_release_consume"
      ? new Promise<boolean>(resolve => { consumed = resolve; }) : original(command, args));
    const cfg = toTransferConfig(workspace("stalled-incoming"));
    cfg.panes[0].tabs![0].tab_id = "stalled-tab"; cfg.panes[0].tabs![0].session_id = "pty-stalled";
    const decision = mocks.decisions[0];
    dispatch("mycmux://tearout-delivery", { token: "stalled-consume", source: "child", configs: [cfg], placement: decision.target,
      approval: { receiver: "main", token: release.token, target: decision.target, release_id: release.id, layout_revision: decision.layoutRevision } });
    await flush(); expect(tearoutDisplayBusy()).toBe(true);
    stop(); await flush(); expect(tearoutDisplayBusy()).toBe(false);
    consumed(true); await flush();
    expect(useWorkspaceListStore.getState().workspaces[0].panes[0].tabs.map(tab => tab.id)).toEqual(["t"]);
  });
  it.each([0, 16, 119])("paints and acknowledges a valid release after %i ms without hover approval", async dwell => {
    const release = frame();
    dispatch("mycmux://tearout-native", { ...release, phase: "end", at: 1000 + dwell, escaped: false, approval: null });
    await request(release);
    expect(useDetachedDockStore.getState().target).toMatchObject({ kind: "pane-zone", zone: "center", paneId: "p" });
    expect(mocks.decisions).toEqual([]);
    await finishPaint();
    expect(mocks.decisions).toEqual([expect.objectContaining({ id: release.id, token: release.token,
      target: { kind: "pane-zone", workspaceId: "w", paneId: "p", zone: "center" }, layoutRevision: expect.any(String) })]);
  });
  it.each([[150, 75, "up"], [20, 150, "left"], [280, 150, "right"], [150, 45, "tab-index"], [150, 240, "down"]])(
    "resolves the final point %i,%i independently of old hover and stale samples", async (x, y, zone) => {
      await request(frame("changed", x as number, y as number, 4));
      dispatch("mycmux://tearout-native", { ...frame("changed", 150, 150, 3), phase: "move", at: 900, escaped: false });
      await finishPaint();
      expect(mocks.decisions).toHaveLength(1);
      expect(mocks.decisions[0].target).toMatchObject(zone === "tab-index" ? { kind: zone } : { kind: "pane-zone", zone });
    });
  it("revalidates the layout after paint and cancels instead of adopting a vanished target", async () => {
    await request(); useWorkspaceListStore.setState({ workspaces: [] }); await finishPaint();
    expect(mocks.decisions[0]).toMatchObject({ target: null, error: "tearout_drop_target_changed" });
    expect(useDetachedDockStore.getState().target).toBeNull();
  });
  it("treats multi-region pane targets and empty client space as invalid, without choosing another pane", async () => {
    await request({ ...frame(), region_count: 2 }); await flush();
    expect(mocks.decisions[0]).toMatchObject({ target: null, error: null });
  });
  it("ignores duplicate resolve requests and consumes an acknowledged token only once", async () => {
    const release = frame(); await request(release); await request(release); await finishPaint();
    expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "tearout_release_begin")).toHaveLength(1);
    expect(mocks.decisions).toHaveLength(1);
    const target = mocks.decisions[0].target;
    const cfg = toTransferConfig(workspace("incoming")); cfg.panes[0].tabs![0].tab_id = "new"; cfg.panes[0].tabs![0].session_id = "pty-new";
    const approval = { receiver: "main", token: release.token, target, release_id: release.id, layout_revision: mocks.decisions[0].layoutRevision };
    dispatch("mycmux://tearout-delivery", { token: "delivery-one", source: "child", configs: [cfg], placement: target, approval, liveSessions: ["pty-new"] });
    await flush();
    expect(mocks.emitTo).toHaveBeenCalledWith("child", "mycmux://tearout-receipt", { token: "delivery-one", ok: true });
    expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "tearout_release_consume")).toHaveLength(1);
    dispatch("mycmux://tearout-delivery", { token: "delivery-two", source: "child", configs: [cfg], placement: target, approval, liveSessions: ["pty-new"] }); await flush();
    expect(mocks.emitTo.mock.calls.find(([, name, receipt]) => name.endsWith("tearout-receipt") && receipt.token === "delivery-two")?.[2].ok).toBe(false);
  });
  it("rejects a layout change after acknowledgement and a forged placement before adoption (R6/R8)", async () => {
    const release = frame(); await request(release); await finishPaint();
    const cfg = toTransferConfig(workspace("incoming-layout")); cfg.panes[0].tabs![0].tab_id = "layout-new"; cfg.panes[0].tabs![0].session_id = "pty-layout-new";
    const target = mocks.decisions[0].target;
    const approval = { receiver: "main", token: release.token, target, release_id: release.id, layout_revision: mocks.decisions[0].layoutRevision };
    dispatch("mycmux://tearout-delivery", { token: "forged-placement", source: "child", configs: [cfg], placement: { ...target, zone: "left" }, approval }); await flush();
    expect(mocks.emitTo.mock.calls.find(([, name, receipt]) => name.endsWith("tearout-receipt") && receipt.token === "forged-placement")?.[2].ok).toBe(false);
    pane.getBoundingClientRect = () => new DOMRect(0, 30, 600, 240);
    dispatch("mycmux://tearout-delivery", { token: "changed-layout", source: "child", configs: [cfg], placement: target, approval }); await flush();
    expect(mocks.emitTo.mock.calls.find(([, name, receipt]) => name.endsWith("tearout-receipt") && receipt.token === "changed-layout")?.[2].ok).toBe(false);
    expect(useWorkspaceListStore.getState().workspaces).toHaveLength(1);
  });
  it("waits for the decision reply when delivery arrives before acknowledgement (R8)", async () => {
    let reply = (_accepted: boolean) => {};
    const invoke = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: any) => {
      if (command === "tearout_release_decision" && args.target) {
        mocks.decisions.push(args); return new Promise<boolean>(resolve => { reply = resolve; });
      }
      return invoke(command, args);
    });
    const release = frame(); await request(release); await finishPaint();
    const cfg = toTransferConfig(workspace("incoming-race")); cfg.panes[0].tabs![0].tab_id = "race-new"; cfg.panes[0].tabs![0].session_id = "pty-race-new";
    const target = mocks.decisions[0].target;
    const approval = { receiver: "main", token: release.token, target, release_id: release.id, layout_revision: mocks.decisions[0].layoutRevision };
    dispatch("mycmux://tearout-delivery", { token: "early-delivery", source: "child", configs: [cfg], placement: target, approval }); await flush();
    expect(mocks.emitTo).not.toHaveBeenCalled();
    reply(true);
    await vi.waitFor(() => expect(mocks.emitTo).toHaveBeenCalledWith("child", "mycmux://tearout-receipt", { token: "early-delivery", ok: true }));
  });
  it.each([1, 1.25, 1.5, 2])("uses receiver CSS points once at scale %s with negative native origins (R5)", async scale => {
    const release = { ...frame(), scale, point: { x: -2560 + 20 * scale, y: -1440 + 150 * scale, at: 1000, method: "native_up" } };
    release.client_x = 20; await request(release); await finishPaint();
    expect(mocks.decisions[0].target).toMatchObject({ zone: "left" });
  });
  it("keeps external strip insertion including whitespace and controls (R7)", async () => {
    const destination = workspace();
    destination.panes[0].tabs.push({ id: "hidden", sessionId: "pty-hidden", agentId: "shell", type: "terminal" });
    useWorkspaceListStore.setState({ workspaces: [destination] });
    const heading = document.createElement("span"); heading.dataset.tabId = "t";
    heading.getBoundingClientRect = () => new DOMRect(0, 30, 100, 36); strip.append(heading);
    const control = document.createElement("button"); strip.append(control);
    // A right-side control must not change U3's append position.
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => control });
    expect(strip.querySelectorAll("[data-tab-id]")).toHaveLength(1);
    await request(frame("strip", 150, 45)); await finishPaint();
    expect(mocks.decisions[0].target).toEqual({ kind: "tab-index", workspaceId: "w", paneId: "p", index: 2 });
  });
  it("allows a complete group only on the sidebar (R7)", async () => {
    const sidebar = document.createElement("div"); sidebar.dataset.dndWorkspaceSidebar = "true"; document.body.append(sidebar);
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => sidebar });
    await request({ ...frame("group"), region_count: 2 }); await finishPaint();
    expect(mocks.decisions[0].target).toEqual({ kind: "workspace" });
  });
  it("does not acknowledge missing, forged or renderer-deferred identities (R3/R11)", async () => {
    const release = frame(); release.receiver = "forged";
    await request(release); await finishPaint(); expect(mocks.decisions).toEqual([]);
  });
  it("does not accept a timeout timer as proof of paint, including Mac's occluded renderer", async () => {
    vi.useFakeTimers(); Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
    try {
      await request(); await vi.advanceTimersByTimeAsync(251); await flush();
      expect(mocks.decisions).toEqual([expect.objectContaining({ target: null, error: "tearout_release_paint_timeout" })]);
      expect(useDetachedDockStore.getState().target).toBeNull();
    } finally { vi.useRealTimers(); }
  });
});
it.each(["no_receiver", "no_hit", "layout_changed", "expired", "receipt_timeout", "approved",
  "no_release_point", "esc_cancelled", "receiver_timeout", "cancelled", "identity_changed"] as const)(
  "2a records the actual release decision %s and accepted target kind", async decision => {
    const original = mocks.invoke.getMockImplementation()!;
    const approval = { receiver: "peer", token: "final-decision", target: { kind: "workspace" }, release_id: "decision-release", layout_revision: "view" };
    mocks.invoke.mockImplementation(async (command: string, args: any) => {
      if (command === "tearout_start_move") dispatch("mycmux://tearout-native", { ...frame(args.id), label: "main", source: "main",
        receiver: decision === "no_receiver" ? null : "peer", phase: "end", at: 1000, escaped: decision === "esc_cancelled", approval: null,
        release: decision === "no_release_point" ? null : frame().point, original: { x: 0, y: 0, width: 300, height: 200 } });
      if (command === "tearout_resolve_release") {
        if (decision === "layout_changed") throw new Error("tearout_drop_target_changed");
        if (decision === "expired") throw new Error("tearout_release_expired");
        if (decision === "receiver_timeout") throw new Error("tearout_release_timeout");
        if (decision === "cancelled") throw new Error("tearout_release_cancelled");
        if (decision === "identity_changed") throw new Error("tearout_release_identity_changed");
        return decision === "no_hit" ? null : approval;
      }
      return original(command, args);
    });
    mocks.emitTo.mockImplementation(async (_label: string, event: string, payload: any) => {
      if (event.endsWith("tearout-outgoing")) dispatch("mycmux://tearout-receipt", { token: payload.token,
        ok: decision !== "receipt_timeout", reason: "tearout_receipt_timeout", failure_checkpoint: "receipt_timeout" });
      if (event.endsWith("tearout-revoke")) dispatch("mycmux://tearout-receipt", { token: payload.ack, ok: true });
    });
    await regrabTearoutWindow(); await flush();
    const record = decision === "approved" ? mocks.emitTo.mock.calls.find(([, event]) => event.endsWith("tearout-outgoing"))![2].record
      : mocks.invoke.mock.calls.filter(([command]) => command === "tearout_log_record").at(-1)![1].record;
    expect(record.release_decision).toBe(decision === "receipt_timeout" ? "approved" : decision);
    expect(record.release_receiver_window).toBe(decision === "no_receiver" ? null : "peer");
    if (decision === "approved" || decision === "receipt_timeout") expect(record).toMatchObject({ receiver_window: "peer",
      attempted_destination: { kind: "sidebar" }, release_target_kind: "sidebar" });
    else expect(record.receiver_window).toBeNull();
  });
it.each(["settle", "native"])("review2 leaves failure checkpoint unset without a docking attempt: %s", async path => {
  const original = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation(async (command: string, args: any) => {
    if (command === "tearout_start_move") {
      dispatch("mycmux://tearout-native", { ...frame(args.id), label: "main", source: "main", receiver: null,
        phase: "end", at: 1000, escaped: false, approval: null, release: null, error: path === "native" ? "native_failed" : null,
        original: { x: 0, y: 0, width: 300, height: 200 } }); return;
    }
    if (command === "tearout_settle") throw new Error("settle_failed");
    return original(command, args);
  });
  await regrabTearoutWindow(); await flush();
  const record = mocks.invoke.mock.calls.filter(([command]) => command === "tearout_log_record").at(-1)![1].record;
  expect(record).toMatchObject({ attempted_destination: null, failure_checkpoint: null });
});
it("review2 records an expired consume token distinctly after the six second approval deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    const release = frame("expired-consume"); await request(release); await finishPaint();
    const decision = mocks.decisions[0]; await vi.advanceTimersByTimeAsync(6000);
    const cfg = toTransferConfig(workspace("expired-incoming")); cfg.panes[0].tabs![0].tab_id = "expired-tab"; cfg.panes[0].tabs![0].session_id = "pty-expired";
    dispatch("mycmux://tearout-delivery", { token: "expired-delivery", source: "child", configs: [cfg], placement: decision.target,
      approval: { receiver: "main", token: release.token, target: decision.target, release_id: release.id, layout_revision: decision.layoutRevision } });
    await flush();
    expect(mocks.emitTo).toHaveBeenCalledWith("child", "mycmux://tearout-receipt", expect.objectContaining({ token: "expired-delivery", ok: false,
      reason: "tearout_consume_expired", failure_checkpoint: "consume", consume_failure_reason: "expired" }));
    expect(useWorkspaceListStore.getState().workspaces[0].panes[0].tabs.map(tab => tab.id)).toEqual(["t"]);
  } finally { vi.useRealTimers(); }
});
it("uses final release resolution at the actual regrab entry, and recovers visibly on timeout (R8/R9)", async () => {
  const invoke = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation(async (command: string, args: any) => {
    if (command === "tearout_start_move") dispatch("mycmux://tearout-native", { ...frame(args.id), label: "main", source: "main", receiver: "peer",
      phase: "end", at: 1000, escaped: false, approval: null, release: frame().point, original: { x: 0, y: 0, width: 300, height: 200 } });
    if (command === "tearout_resolve_release") throw new Error("tearout_release_timeout");
    return invoke(command, args);
  });
  await regrabTearoutWindow(); await flush();
  expect(mocks.invoke).toHaveBeenCalledWith("tearout_resolve_release", expect.anything());
  expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "tearout_restore_geometry")).toBe(true);
  expect(useToastStore.getState().toasts.some(toast => toast.kind === "error")).toBe(true);
  expect(tearoutOperationBusy()).toBe(false);
});

it("keeps without final resolution on Esc or an outside release (R4/R9)", async () => {
  const invoke = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation(async (command: string, args: any) => {
    if (command === "tearout_start_move") dispatch("mycmux://tearout-native", { ...frame(args.id), label: "main", source: "main", receiver: null,
      phase: "end", at: 1000, escaped: false, approval: { receiver: "stale", token: "stale", target: { kind: "workspace" } },
      release: frame().point, original: { x: 0, y: 0, width: 300, height: 200 } });
    return invoke(command, args);
  });
  await regrabTearoutWindow(); await flush();
  expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "tearout_resolve_release")).toBe(false);
  expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "tearout_settle")).toBe(true);
  expect(mocks.emitTo.mock.calls.some(([, name]) => name.endsWith("tearout-outgoing"))).toBe(false);
});

it("docks the freshly resolved target instead of historical approval at regrab (R1/R2)", async () => {
  const invoke = mocks.invoke.getMockImplementation()!;
  const target = { kind: "pane-zone", workspaceId: "peer-w", paneId: "peer-p", zone: "right" };
  mocks.invoke.mockImplementation(async (command: string, args: any) => {
    if (command === "tearout_start_move") dispatch("mycmux://tearout-native", { ...frame(args.id), label: "main", source: "main", receiver: "peer",
      phase: "end", at: 1000, escaped: false, approval: { receiver: "old", token: "hover", target: { kind: "workspace" } },
      release: frame().point, original: { x: 0, y: 0, width: 300, height: 200 } });
    if (command === "tearout_resolve_release") return { receiver: "peer", token: "final-token", target, release_id: args.id, layout_revision: "final-layout" };
    return invoke(command, args);
  });
  mocks.emitTo.mockImplementation(async (_label: string, name: string, request: any) => {
    if (name.endsWith("tearout-outgoing")) dispatch("mycmux://tearout-receipt", { token: request.token, ok: true });
  });
  await regrabTearoutWindow(); await flush();
  expect(mocks.emitTo.mock.calls.find(([, name]) => name.endsWith("tearout-outgoing"))?.[2].approval).toMatchObject({ token: "final-token", target });
  expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "tearout_settle")).toBe(false);
  expect(tearoutOperationBusy()).toBe(false);
});
it("still revokes a failed docking delivery if release cleanup also fails (R8/R9)", async () => {
  const invoke = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation(async (command: string, args: any) => {
    if (command === "tearout_start_move") dispatch("mycmux://tearout-native", { ...frame(args.id), label: "main", source: "main", receiver: "peer",
      phase: "end", at: 1000, escaped: false, approval: null, release: frame().point, original: { x: 0, y: 0, width: 300, height: 200 } });
    if (command === "tearout_resolve_release") return { receiver: "peer", token: "final-token", target: { kind: "workspace" }, release_id: args.id, layout_revision: "layout" };
    if (command === "tearout_release_cancel") throw new Error("release cleanup failed");
    return invoke(command, args);
  });
  mocks.emitTo.mockImplementation(async (_label: string, name: string, request: any) => {
    if (name.endsWith("tearout-outgoing")) dispatch("mycmux://tearout-receipt", { token: request.token, ok: false, error: "delivery failed" });
    if (name.endsWith("tearout-revoke")) dispatch("mycmux://tearout-receipt", { token: request.ack, ok: true });
  });
  await regrabTearoutWindow(); await flush();
  await vi.waitFor(() => expect(tearoutOperationBusy()).toBe(false));
  expect(mocks.emitTo.mock.calls.some(([, name]) => name.endsWith("tearout-revoke"))).toBe(true);
  expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "tearout_restore_geometry")).toBe(true);
  expect(useToastStore.getState().toasts.some(toast => toast.kind === "error")).toBe(true);
});

it.each([false, true])("O2 keeps materialization independent of dock resolution, resolver timeout=%s (R9)", async failed => {
  const before = useWorkspaceListStore.getState().workspaces;
  const invoke = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation(async (command: string, args: any) => {
    if (command === "tearout_take_spare") return "mycmux-w42";
    if (command === "tearout_start_move") dispatch("mycmux://tearout-native", { ...frame(args.id), mode: args.mode, label: "mycmux-w42", source: "main", receiver: "peer",
      phase: "end", at: 1000, escaped: false, approval: null, release: frame().point, original: { x: 0, y: 0, width: 300, height: 200 } });
    if (command === "tearout_resolve_release") {
      if (failed) throw new Error("tearout_release_timeout");
      return { receiver: "peer", token: "fresh-final", target: { kind: "workspace" }, release_id: args.id, layout_revision: "layout" };
    }
    return invoke(command, args);
  });
  mocks.emitTo.mockImplementation(async (_label: string, name: string, request: any) => {
    if (name.endsWith("tearout-delivery") || name.endsWith("tearout-outgoing")) dispatch("mycmux://tearout-receipt", { token: request.token, ok: true });
    if (name.endsWith("tearout-revoke")) dispatch("mycmux://tearout-receipt", { token: request.ack, ok: true });
  });
  await tearoutTab({ kind: "tab", workspaceId: "w", paneId: "p", tabId: "t", label: "Terminal" }, { x: 0, y: 30, width: 90, height: 36 }, { x: 10, y: 10 });
  expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "tearout_resolve_release")).toBe(false);
  expect(useWorkspaceListStore.getState().workspaces).toEqual([]);
  expect(mocks.emitTo.mock.calls.some(([, name]) => name.endsWith("tearout-outgoing"))).toBe(false);
  expect(mocks.invoke).toHaveBeenCalledWith("tearout_settle", { label: "mycmux-w42" });
  expect(tearoutOperationBusy()).toBe(false);
});


it("reports an unconfirmed native geometry restore after final timeout, with a working retry (R8/R9)", async () => {
  const before = useWorkspaceListStore.getState().workspaces;
  let restoreWorking = false;
  const originalInvoke = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation(async (command: string, args: any) => {
    if (command === "tearout_start_move") {
      dispatch("mycmux://tearout-native", { id: args.id, mode: args.mode, label: "main", source: "main", phase: "end", at: 1000,
        escaped: false, error: null, receiver: "peer", approval: null, release: frame().point,
        original: { x: 0, y: 0, width: 300, height: 200 } });
      return;
    }
    if (command === "tearout_resolve_release") throw new Error("tearout_release_timeout");
    if (command === "tearout_restore_geometry" && !restoreWorking) throw new Error("native_geometry_unavailable");
    return originalInvoke(command, args);
  });
  await regrabTearoutWindow(); await flush();
  await vi.waitFor(() => expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "tearout_log_record").at(-1)?.[1].record)
    .toMatchObject({ result: "restore_failed", failure_reason: "tearout_release_timeout", failure_phase: "restoring", failure_phase_before_restore: "resolving_release",
      recovery_reason: "native_geometry_unavailable" }));
  const notice = useToastStore.getState().toasts.find(toast => toast.kind === "error" && toast.actions?.length);
  expect(notice).toBeDefined(); expect(tearoutOperationBusy()).toBe(false);
  expect(useWorkspaceListStore.getState().workspaces).toEqual(before);
  restoreWorking = true; notice!.actions![0].run(); await flush();
  await vi.waitFor(() => expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "tearout_restore_geometry")).toHaveLength(2));
  expect(tearoutOperationBusy()).toBe(false);
  expect(useToastStore.getState().toasts.some(toast => toast.kind === "info")).toBe(true);
});


it("shows a genuine native release escrow failure instead of silently recording recovery (R8/R9)", async () => {
  const originalInvoke = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation(async (command: string, args: any) => {
    if (command === "tearout_start_move") {
      dispatch("mycmux://tearout-native", { id: args.id, mode: args.mode, label: "main", source: "main", phase: "end", at: 1000,
        escaped: false, error: "tearout_release_escrow_failed", receiver: "peer", approval: null, release: null,
        original: { x: 0, y: 0, width: 300, height: 200 } });
      return;
    }
    return originalInvoke(command, args);
  });
  await regrabTearoutWindow(); await flush();
  expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "tearout_log_record").at(-1)?.[1].record)
    .toMatchObject({ result: "failed_restored", failure_reason: "tearout_release_escrow_failed" });
  expect(useToastStore.getState().toasts.some(toast => toast.kind === "error")).toBe(true);
  expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "tearout_resolve_release")).toBe(false);
  expect(tearoutOperationBusy()).toBe(false);
});


it("keeps the final frame through another drag's hover samples (R3/R11)", async () => {
  const hover = { ...frame("another-move", 280, 150), phase: "move", escaped: false };
  dispatch("mycmux://tearout-native", { ...hover, at: 900 }); await paint();
  dispatch("mycmux://tearout-native", { ...hover, at: 1100 }); await paint();
  expect(useDetachedDockStore.getState().target).toMatchObject({ zone: "right" });
  await request(frame("final-frame"));
  dispatch("mycmux://tearout-native", { ...hover, receiver: null, at: 1120 });
  await paint();
  expect(useDetachedDockStore.getState().target).toMatchObject({ zone: "center" });
  await paint();
  expect(mocks.decisions.find(decision => decision.id === "final-frame")).toMatchObject({ target: { zone: "center" }, error: null });
});

it("rejects a concurrent final request instead of acknowledging an overwritten frame (R8/R11)", async () => {
  await request(frame("first-final"));
  await request(frame("second-final", 20, 150));
  await finishPaint();
  expect(mocks.decisions.find(decision => decision.id === "second-final"))
    .toMatchObject({ target: null, error: "tearout_release_receiver_busy" });
  expect(mocks.decisions.find(decision => decision.id === "first-final"))
    .toMatchObject({ target: { zone: "center" }, error: null });
});

it("does not acknowledge when another local interaction replaced the displayed frame (R6/R11)", async () => {
  await request(frame("replaced-frame"));
  useDetachedDockStore.setState({ active: { label: "other-child", workspaceId: "w", nativeSingleTab: true },
    target: { kind: "pane-zone", workspaceId: "w", paneId: "p", zone: "right" } });
  await finishPaint();
  expect(mocks.decisions.find(decision => decision.id === "replaced-frame"))
    .toMatchObject({ target: null, error: "tearout_drop_target_changed" });
  expect(useDetachedDockStore.getState().target).toMatchObject({ zone: "right" });
});


it("O2 never paints or approves a detach hover, even over a valid receiver", async () => {
  for (const at of [0, 121, 242]) {
    dispatch("mycmux://tearout-native", { ...frame("detach-feedback"), mode: "detach", phase: "move", at, escaped: false, approval: null });
    await paint();
  }
  await finishPaint();
  expect(useDetachedDockStore.getState().target).toBeNull();
  expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "tearout_preview" || cmd === "tearout_alpha")).toBe(false);
  expect(mocks.emitTo.mock.calls.some(([, event]) => event.endsWith("tearout-highlight"))).toBe(false);
});
it("O2 rejects a detach release frame before exposing a dock promise", async () => {
  await request({ ...frame("detach-release"), mode: "detach" }); await finishPaint();
  expect(useDetachedDockStore.getState().target).toBeNull();
  expect(mocks.decisions.some(decision => decision.target !== null)).toBe(false);
});


it("O2 binds the receiver mode to its drag ID", async () => {
  const sample = { ...frame("bound-mode"), mode: "detach", phase: "move", escaped: false, approval: null };
  dispatch("mycmux://tearout-native", { ...sample, at: 0 }); await paint();
  dispatch("mycmux://tearout-native", { ...sample, mode: "dock", at: 121 }); await paint();
  dispatch("mycmux://tearout-native", { ...sample, mode: "dock", at: 242 }); await finishPaint();
  expect(useDetachedDockStore.getState().target).toBeNull();
  expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "tearout_preview")).toBe(false);
});
it.each([[150, 150, "center"], [20, 150, "left"], [280, 150, "right"], [150, 75, "up"], [150, 240, "down"]] as const)(
  "O2 consumes a dock release at %i,%i and really adopts the %s layout", async (x, y, zone) => {
    const release = frame(`adopt-${zone}`, x, y); await request(release); await finishPaint();
    const target = mocks.decisions[0].target;
    expect(target.zone).toBe(zone);
    const cfg = toTransferConfig(workspace("incoming"));
    cfg.panes[0].pane_id = "incoming-pane"; cfg.panes[0].tabs![0].tab_id = "new"; cfg.panes[0].tabs![0].session_id = "pty-new";
    cfg.panes[0].active_tab_id = "new"; cfg.panes[0].session_id = "pty-new";
    const approval = { receiver: "main", token: release.token, target, release_id: release.id, layout_revision: mocks.decisions[0].layoutRevision };
    dispatch("mycmux://tearout-delivery", { token: `delivery-${zone}`, source: "child", configs: [cfg], placement: target, approval, liveSessions: ["pty-new"] });
    await flush();
    expect(mocks.emitTo).toHaveBeenCalledWith("child", "mycmux://tearout-receipt", { token: `delivery-${zone}`, ok: true });
    const owned = useWorkspaceListStore.getState().workspaces;
    expect(owned).toHaveLength(1);
    expect(owned[0].panes).toHaveLength(zone === "center" ? 1 : 2);
    expect(owned[0].panes.flatMap(p => p.tabs).map(t => t.id).sort()).toEqual(["new", "t"]);
    if (zone === "center") expect(owned[0].panes[0].id).toBe("p");
    else {
      const added = owned[0].panes.find(p => p.tabs.some(t => t.id === "new"))!.id;
      expect(owned[0].splitColumns).toEqual(zone === "left" ? [[added], ["p"]] : zone === "right" ? [["p"], [added]]
        : zone === "up" ? [[added, "p"]] : [["p", added]]);
    }
  });


it("O2 retains a bound detach intent across a conflicting final dock frame", async () => {
  const release = frame("bound-final");
  dispatch("mycmux://tearout-native", { ...release, mode: "detach", phase: "end", escaped: false, approval: null, at: 1000 });
  await request(release); await finishPaint();
  expect(mocks.decisions.some(decision => decision.target !== null)).toBe(false);
  expect(useDetachedDockStore.getState().target).toBeNull();
});


describe("F1 authoritative handoff conversation before request delivery", () => {
  it.each([false, true])("review handoff accepts stable recipient geometry and rejects movement: moved=%s", async moved => {
    pane.dataset.dndHandoffSurface = "true";
    usePaneMetadataStore.setState({ metadata: { "pty-live": { agentKind: "codex", agentSessionId: "selected-conversation" } } });
    const id = `review-handoff-${moved}`;
    dispatch("mycmux://tearout-handoff-context", { id, mode: "dock", label: "child", sourceWindow: "child", endpoint: {
      workspaceId: "source", paneId: "source-pane", tab: { id: "source-tab", sessionId: "source-pty", agentId: "shell", type: "terminal" },
      metadata: { agentKind: "claude", agentSessionId: "source-conversation", cwd: "C:/demo/source" } } });
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args: any) => command === "publish_savepoint" ? Promise.resolve({ bundle_dir: "C:/demo/bundle" })
      : command === "join_savepoint_summary" ? Promise.resolve({ handoff_path: "C:/demo/bundle/handoff.md", cwd_missing: false }) : original(command, args));
    const release = frame(id); await request(release); await finishPaint();
    const decision = mocks.decisions[0]; expect(decision.target.kind).toBe("handoff");
    if (moved) pane.getBoundingClientRect = () => new DOMRect(20, 30, 300, 240);
    dispatch("mycmux://tearout-handoff-request", { id, token: id, requester: "child", approval: {
      receiver: "main", token: release.token, target: decision.target, release_id: id, layout_revision: decision.layoutRevision } });
    await vi.waitFor(() => expect(mocks.emitTo).toHaveBeenCalledWith("child", "mycmux://tearout-handoff-result", { token: id, ok: !moved }));
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "write_to_session")).toHaveLength(moved ? 0 : 1);
  });
  it.each(["changed", "unchanged", "unknown"] as const)("keeps the selected recipient for %s conversation", async identity => {
    pane.dataset.dndHandoffSurface = "true";
    usePaneMetadataStore.setState({ metadata: { "pty-live": { agentKind: "codex",
      ...(identity === "unknown" ? {} : { agentSessionId: "selected-conversation" }) } } });
    const endpoint = { workspaceId: "source", paneId: "source-pane", tab: { id: "source-tab", sessionId: "source-pty", agentId: "shell", type: "terminal" },
      metadata: { agentKind: "claude", agentSessionId: "source-conversation", cwd: "C:/demo/source" } };
    dispatch("mycmux://tearout-handoff-context", { id: "release", mode: "dock", label: "child", sourceWindow: "child", endpoint });
    const originalInvoke = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: any) => {
      if (command === "publish_savepoint") return { bundle_dir: "C:/demo/bundle" };
      if (command === "join_savepoint_summary") return { handoff_path: "C:/demo/bundle/handoff.md", cwd_missing: false };
      return originalInvoke(command, args);
    });
    const release = frame(); await request(release); await finishPaint();
    const target = mocks.decisions[0].target;
    expect(target.kind).toBe("handoff");
    if (identity === "changed") usePaneMetadataStore.setState({ metadata: { "pty-live": { agentKind: "codex", agentSessionId: "replacement-conversation" } } });
    dispatch("mycmux://tearout-handoff-request", { id: release.id, token: "handoff-request", requester: "child",
      approval: { receiver: "main", token: release.token, target, release_id: release.id, layout_revision: mocks.decisions[0].layoutRevision } });
    await vi.waitFor(() => expect(mocks.emitTo).toHaveBeenCalledWith("child", "mycmux://tearout-handoff-result",
      { token: "handoff-request", ok: identity !== "changed" }));
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "write_to_session")).toHaveLength(identity === "changed" ? 0 : 1);
    if (identity === "changed") expect(useToastStore.getState().toasts.some(toast => toast.kind === "warning")).toBe(true);
  });
});
