// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setup, cleanup, mount, workspace, pane, content, textarea, pointer, advance, frame, field,
  root, host, resizes, frames, mocks } from "./paneHoverFocusHarness";
import { act } from "react";
import { focusController } from "../../src/lib/focusController";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { usePaneDragStore } from "../../src/stores/paneDragStore";
import { useSavepointDragStore } from "../../src/stores/savepointDragStore";
import { useDetachedDockStore } from "../../src/stores/detachedDockStore";
import { applyExternalStoreUpdate } from "../../src/stores/syncedPersist";
import { rememberTearoutDormantSessions } from "../../src/lib/tearout/sessionAttachment";
import { prepareStartupSessionGate } from "../../src/lib/startupSessionGate";

beforeEach(() => setup()); afterEach(cleanup);
const active = () => useUiStore.getState().activePaneId;
async function aim(el = content(), patch = {}) { await act(async () => { pointer(el, "pointermove", patch); }); }

describe("real TerminalPane hover integration", () => {
  it("I01 focuses B once, preserves layout/tab, clears sibling notifications and accepts B's first input", async () => {
    const b = pane("b"); b.tabs.push({ id: "t-sibling", sessionId: "sibling", agentId: "shell" });
    const ws = await mount(workspace([pane("a"), b]));
    await act(async () => { usePaneMetadataStore.setState({ metadata: { b: { notificationCount: 2 }, sibling: { notificationCount: 1 } } }); });
    const revision = useWorkspaceListStore.getState().layoutRevision;
    await aim(); await advance(99); expect(active()).toBe("a"); await advance(1); await advance(0);
    expect(active()).toBe("b"); expect(useUiStore.getState().focusRevision).toBe(1);
    expect(document.activeElement).toBe(textarea()); expect(mocks.focus.get("b")).toHaveBeenCalledOnce();
    expect(host.querySelector("[data-dnd-pane-id='p-b']")?.getAttribute("data-active-pane")).toBe("true");
    expect(useWorkspaceListStore.getState().layoutRevision).toBe(revision);
    expect(ws.panes[1].activeTabId).toBe("t-b");
    expect(usePaneMetadataStore.getState().metadata.b.notificationCount).toBe(0);
    expect(usePaneMetadataStore.getState().metadata.sibling.notificationCount).toBe(0);
    await act(async () => { textarea().value = "first"; textarea().dispatchEvent(new Event("input", { bubbles: true })); });
    expect(mocks.accepted).toEqual([["b", "first"]]); expect(focusController.shouldAcceptTerminalInput("a")).toBe(false);
  });
  it("I02 enter/baseline/passages/nested children and continuous movement keep one dwell", async () => {
    await mount(); await act(async () => { pointer(content(), "pointerenter"); pointer(content(), "pointermove", { movementX: 0 }); });
    await advance(200); expect(active()).toBe("a");
    await aim(content(), { clientX: 21 }); await advance(40);
    await aim(content("a"), { clientX: 10 }); await advance(40);
    await aim(content(), { clientX: 22 }); await advance(40);
    const child = content().querySelector("[data-line]")!;
    await act(async () => { pointer(child, "pointerenter"); pointer(child, "pointerleave", { relatedTarget: content().querySelector("[data-screen]") }); });
    await aim(child, { clientX: 23 }); await advance(60); await advance(0);
    expect(active()).toBe("b"); expect(mocks.focus.get("b")).toHaveBeenCalledOnce();
  });
  it.each(["frame", "tabbar", "button", "link", "input", "textarea", "select", "editable", "divider", "composer", "history", "search"])(
    "I03 excludes %s", async (kind) => {
      await mount(); let el: Element;
      if (kind === "frame") el = content().parentElement!;
      else if (kind === "tabbar") el = host.querySelector("[data-dnd-pane-id='p-b'] .pane-tabbar")!;
      else {
        const tag = ({ button: "button", link: "a", input: "input", textarea: "textarea", select: "select" } as any)[kind] ?? "div";
        el = document.createElement(tag); content().append(el);
        if (kind === "editable") el.setAttribute("contenteditable", "plaintext-only");
        if (kind === "divider") el.setAttribute("role", "separator");
        if (kind === "composer") el.setAttribute("data-composer-session", "b");
        if (kind === "history") el.setAttribute("data-terminal-transcript-panel", "true");
        if (kind === "search") el.setAttribute("data-terminal-search", "true");
      }
      await aim(el); await advance(200); expect(active()).toBe("a"); expect(mocks.focus.get("b")).not.toHaveBeenCalled();
    });
  it("I03 normal helper textarea is an eligible terminal surface", async () => {
    await mount(); await aim(textarea()); await advance(); await advance(0); expect(document.activeElement).toBe(textarea());
  });
  it("I04 click allocates no hover resources; StrictMode, 12 roots, toggles and last unmount clean up", async () => {
    useSettingsStore.setState({ paneFocusMode: "click" });
    const add = vi.spyOn(EventTarget.prototype, "addEventListener"), remove = vi.spyOn(EventTarget.prototype, "removeEventListener");
    const timeout = vi.spyOn(window, "setTimeout"), clear = vi.spyOn(window, "clearTimeout");
    const subscriptions = [useSettingsStore, useUiStore, useWorkspaceListStore, usePaneDragStore, useSavepointDragStore, useDetachedDockStore]
      .map((store) => vi.spyOn(store, "subscribe"));
    const ownSubscriptionCalls = () => subscriptions.flatMap((spy) => spy.mock.calls).filter(([fn]) => fn.name.startsWith("paneHoverFocus"));
    const NativeMutation = window.MutationObserver;
    const mutation = vi.fn((callback: MutationCallback) => new NativeMutation(callback));
    vi.stubGlobal("MutationObserver", class { constructor(callback: MutationCallback) { return mutation(callback); } });
    const owned = (calls: any[][]) => calls.filter((c) => c[1]?.name === "paneHoverFocusListener");
    const panes = Array.from({ length: 12 }, (_, i) => pane(i === 0 ? "a" : `s${i}`));
    await mount(workspace(panes), true); await advance(1); const timers = vi.getTimerCount();
    expect(owned(add.mock.calls)).toHaveLength(0); expect(mutation).not.toHaveBeenCalled();
    expect(ownSubscriptionCalls()).toHaveLength(0);
    await aim(content("s1")); await advance(); expect(active()).toBe("a"); expect(vi.getTimerCount()).toBe(timers);
    await act(async () => { useSettingsStore.getState().setPaneFocusMode("hover"); });
    const listeners = owned(add.mock.calls); expect(listeners.filter((c) => c[0] === "pointermove")).toHaveLength(1);
    expect(mutation).toHaveBeenCalledOnce();
    expect(ownSubscriptionCalls()).toHaveLength(6);
    await aim(content("s1"), { clientX: 21 });
    const dwellIndex = timeout.mock.calls.findIndex(([fn]) => typeof fn === "function" && fn.name === "paneHoverFocusDwell");
    expect(dwellIndex).toBeGreaterThanOrEqual(0);
    expect(timeout.mock.calls.filter(([fn]) => typeof fn === "function" && fn.name === "paneHoverFocusDwell")).toHaveLength(1);
    await act(async () => { useSettingsStore.getState().setPaneFocusMode("click"); });
    expect(owned(remove.mock.calls)).toHaveLength(listeners.length);
    expect(clear).toHaveBeenCalledWith(timeout.mock.results[dwellIndex].value);
    expect(resizes.every((r) => [...r.targets].every((e) => !e.hasAttribute("data-pane-hover-focus-surface")))).toBe(true);
    await act(async () => { useSettingsStore.getState().setPaneFocusMode("hover"); });
    await aim(content("s1"), { clientX: 22 });
    await act(async () => { root.render(null); }); await advance(500);
    expect(active()).toBe("a"); expect(owned(remove.mock.calls)).toHaveLength(owned(add.mock.calls).length);
  });
  it.each([
    ["input", {}], ["textarea", {}], ["select", {}], ["div", { contenteditable: "true" }],
    ["div", { contenteditable: "" }], ["div", { contenteditable: "plaintext-only" }],
    ["iframe", {}], ["embed", {}], ["object", {}], ["textarea", { "data-composer-session": "a" }],
  ] as const)("I05/U05/U06 protects focused %s %j before arm and during dwell", async (tag, attrs) => {
    await mount(); const editor = field(tag, attrs);
    await aim(); await advance(150); expect(active()).toBe("a"); expect(document.activeElement).toBe(editor);
    editor.blur(); await aim(content(), { clientX: 21 }); await advance(50, false); editor.focus();
    await advance(150); expect(active()).toBe("a"); expect(document.activeElement).toBe(editor);
  });
  it("I05 inherited contenteditable and noncollapsed selection protect the source", async () => {
    await mount(); const editor = field("div", { contenteditable: "plaintext-only" });
    const child = document.createElement("span"); child.tabIndex = 0; editor.append(child); child.focus();
    await aim(); await advance(); expect(active()).toBe("a");
    child.blur(); const range = document.createRange(); range.selectNodeContents(content("a"));
    document.getSelection()!.addRange(range); await aim(content(), { clientX: 21 }); await advance(); expect(active()).toBe("a");
    document.getSelection()!.removeAllRanges();
  });
  it.each(["dialog", "menu", "popover", "palette", "seeThrough", "rename", "closing"])("I05/U07 global %s protects even with button focus and open/close cancels", async (kind) => {
    await mount(); await aim(); await advance(50, false);
    const blocker = document.createElement("div");
    if (["dialog", "menu", "rename"].includes(kind)) blocker.setAttribute("role", kind === "menu" ? "menu" : "dialog");
    else if (kind === "popover") blocker.dataset.paneHoverFocusBlocker = "true";
    else { blocker.className = "cmux-overlay-backdrop"; if (kind === "closing") { blocker.inert = true; blocker.setAttribute("aria-hidden", "true"); } }
    const button = document.createElement("button"); blocker.append(button); document.body.append(blocker); button.focus();
    await aim(content(), { clientX: 21 }); await advance(150); expect(active()).toBe("a"); expect(document.activeElement).toBe(button);
    blocker.remove(); await advance(150); expect(active()).toBe("a");
    await aim(content(), { clientX: 22 }); await advance(); await advance(0); expect(active()).toBe("b");
  });
  it("I05 blocker that opens and closes without focus invalidates the old generation", async () => {
    await mount(); await aim(); await advance(50, false);
    const blocker = document.createElement("div"); blocker.setAttribute("role", "menu"); document.body.append(blocker); blocker.remove();
    await act(async () => { await Promise.resolve(); }); await advance(200); expect(active()).toBe("a");
  });
  it.each(["down", "capture", "pane-drag", "savepoint", "detached", "buttons1", "buttons2", "buttons4", "modifier"])("I05/U09 %s blocks and release never resumes", async (kind) => {
    await mount(); await aim();
    await act(async () => {
      if (kind === "down") pointer(document.body, "pointerdown", { buttons: 1 });
      if (kind === "capture") pointer(document.body, "gotpointercapture");
      if (kind === "pane-drag") usePaneDragStore.setState({ item: { kind: "tab", workspaceId: "w", paneId: "p-a", tabId: "t-a" } as any });
      if (kind === "savepoint") useSavepointDragStore.setState({ item: { id: "save" } as any });
      if (kind === "detached") useDetachedDockStore.setState({ active: { label: "other", workspaceId: "w" } });
    });
    await aim(content(), { clientX: 21, buttons: kind.startsWith("buttons") ? Number(kind.slice(-1)) : 0, shiftKey: kind === "modifier" });
    await advance(200); expect(active()).toBe("a");
    await act(async () => {
      usePaneDragStore.setState({ item: null }); useSavepointDragStore.setState({ item: null }); useDetachedDockStore.setState({ active: null });
      pointer(document.body, "pointerup"); pointer(document.body, "lostpointercapture");
    });
    await advance(200); expect(active()).toBe("a");
    await aim(content(), { clientX: 22 }); await advance(); await advance(0); expect(active()).toBe("b");
  });
  it.each(["compositionend", "focuschange", "keydown"])("I06/U08 receipt-time unknown stays blocked until %s", async (resolution) => {
    useSettingsStore.setState({ paneFocusMode: "click" }); await mount(); textarea("a").focus();
    await act(async () => { applyExternalStoreUpdate(useSettingsStore, { paneFocusMode: "hover" }); });
    await aim(); await advance(1000); expect(active()).toBe("a");
    await act(async () => {
      if (resolution === "compositionend") textarea("a").dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      else if (resolution === "focuschange") { const button = field("button"); button.blur(); }
      else textarea("a").dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    });
    await advance(200); expect(active()).toBe("a");
    await aim(content(), { clientX: 21 }); await advance(); await advance(0); expect(active()).toBe("b");
  });
  it.each(["compositionstart", "isComposing", "Process", "229"])("I06 IME %s blocks until explicit end", async (kind) => {
    await mount(); await aim();
    const event = kind === "compositionstart" ? new CompositionEvent(kind, { bubbles: true }) : new KeyboardEvent("keydown", {
      bubbles: true, key: kind === "Process" ? "Process" : "a", isComposing: kind === "isComposing", keyCode: kind === "229" ? 229 : 0,
    });
    textarea("a").dispatchEvent(event); await advance(200); expect(active()).toBe("a");
    await act(async () => { textarea("a").dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })); });
    await advance(200); expect(active()).toBe("a"); await aim(content(), { clientX: 21 }); await advance(); expect(active()).toBe("b");
  });
  it.each(["touch", "pen", "", "blur", "hidden", "native"])("I06/U10 inactive or non-mouse %s never activates", async (kind) => {
    await mount(); await aim();
    if (kind === "blur") { pointer(document.body, "pointerdown", { buttons: 1 }); window.dispatchEvent(new Event("blur")); }
    if (kind === "hidden") { vi.mocked(Object.getOwnPropertyDescriptor(document, "visibilityState")!.get!).mockReturnValue("hidden"); document.dispatchEvent(new Event("visibilitychange")); }
    if (kind === "native") vi.mocked(document.hasFocus).mockReturnValue(false);
    await aim(content(), { clientX: 21, pointerType: ["touch", "pen", ""].includes(kind) ? kind : "mouse" });
    await advance(200); expect(active()).toBe("a");
    vi.mocked(document.hasFocus).mockReturnValue(true);
    if (kind === "hidden") { vi.mocked(Object.getOwnPropertyDescriptor(document, "visibilityState")!.get!).mockReturnValue("visible"); document.dispatchEvent(new Event("visibilitychange")); }
    window.dispatchEvent(new Event("focus")); await advance(200); expect(active()).toBe("a");
    await aim(content(), { clientX: 22 }); await advance(); expect(active()).toBe("b");
  });
  it.each(["mode", "workspace", "zoom", "resize", "tab", "close", "undo", "tearout", "layout", "new-root"])("I07 invalidates %s before dwell without stationary rearming", async (kind) => {
    const ws = await mount(); await aim(); await advance(50, false);
    await act(async () => {
      if (kind === "mode") { useSettingsStore.getState().setPaneFocusMode("click"); useSettingsStore.getState().setPaneFocusMode("hover"); }
      if (kind === "workspace") { useWorkspaceListStore.setState({ activeWorkspaceId: "other" }); useWorkspaceListStore.setState({ activeWorkspaceId: "w" }); }
      if (kind === "zoom") { useUiStore.setState({ zoomedPaneId: "p-a" }); useUiStore.setState({ zoomedPaneId: null }); }
      if (kind === "resize") resizes.find((r) => r.targets.has(content()))!.fire();
      if (kind === "tab") useWorkspaceListStore.setState({ workspaces: [{ ...ws, panes: [ws.panes[0], { ...ws.panes[1], activeTabId: "other", tabs: [ { id: "other", sessionId: "new", agentId: "shell" } ] }] }] });
      if (kind === "close") useWorkspaceListStore.setState({ workspaces: [{ ...ws, panes: [ws.panes[0]] }] });
      if (["undo", "tearout"].includes(kind)) { useUiStore.setState({ activePaneId: "other" }); useUiStore.setState({ activePaneId: "a" }); }
      if (kind === "layout") window.dispatchEvent(new Event("mycmux:terminal-layout-change"));
      if (kind === "new-root") root.render(null);
    });
    await advance(200); expect(active()).toBe("a");
    if (kind !== "new-root") { await aim(content(), { movementX: 0 }); await advance(); expect(active()).toBe("a"); }
  });
  it.each(["browser", "web", "online", "declared", "dormant", "startup", "unknown-lifecycle"])("I08 %s never registers or starts a session", async (kind) => {
    const patch: any = kind === "declared" ? { lifecycle: "declared" } : kind === "unknown-lifecycle" ? { lifecycle: "unknown" }
      : ["browser", "web", "online"].includes(kind) ? { type: kind, htmlPath: "preview.html" } : {};
    if (kind === "dormant") rememberTearoutDormantSessions(["b"], []);
    if (kind === "startup") prepareStartupSessionGate(["b"]);
    await mount(workspace([pane("a"), pane("b", patch)]));
    const b = host.querySelector<HTMLElement>("[data-dnd-pane-id='p-b']")!;
    expect(b.querySelector("[data-pane-hover-focus-surface]")).toBeNull();
    mocks.invoke.mockClear(); await aim(b); await advance(200); expect(active()).toBe("a");
    expect(mocks.invoke).not.toHaveBeenCalled();
    if (kind === "dormant") rememberTearoutDormantSessions(["b"], ["b"]);
    prepareStartupSessionGate([]);
  });
  it("I08 hidden sibling active is a no-op, hidden retained content cannot become a target", async () => {
    const b = pane("b"); b.tabs.push({ id: "t-sibling", sessionId: "sibling", agentId: "shell" });
    await mount(workspace([pane("a"), b]));
    await act(async () => { useUiStore.getState().setActivePaneId("sibling"); });
    await aim(); await advance(200); expect(active()).toBe("sibling"); expect(b.activeTabId).toBe("t-b");
  });
  it("I08 hidden retained child / hidden workspace and detached-style roots are excluded", async () => {
    const ws = await mount();
    const hidden = document.createElement("div"); hidden.dataset.retainedTerminal = "old"; hidden.setAttribute("aria-hidden", "true");
    const child = document.createElement("textarea"); child.className = "xterm-helper-textarea"; hidden.append(child); content().append(hidden);
    await aim(child); await advance(200); expect(active()).toBe("a");
    await act(async () => { useWorkspaceListStore.setState({ activeWorkspaceId: "hidden" }); });
    await aim(content(), { clientX: 21 }); await advance(200); expect(active()).toBe("a");
    await act(async () => { useWorkspaceListStore.setState({ activeWorkspaceId: "w" }); });
    const detachedContent = content();
    detachedContent.parentElement!.removeAttribute("data-dnd-pane-id"); await aim(detachedContent, { clientX: 22 }); await advance(200);
    expect(active()).toBe("a"); expect(ws.panes[1].activeTabId).toBe("t-b");
  });
  it("I01/C05 R4 unregistered rejection ends ownership so same-B movement starts a fresh dwell", async () => {
    await mount(); await act(async () => { usePaneMetadataStore.setState({ metadata: { b: { notificationCount: 2 } } }); });
    await act(async () => { textarea("a").focus(); });
    const ui = useUiStore.getState(), layout = useWorkspaceListStore.getState();
    focusController.clearSession("b"); await aim(); await advance(); expect(active()).toBe("a");
    expect(usePaneMetadataStore.getState().metadata.b.notificationCount).toBe(2);
    expect(document.activeElement).toBe(textarea("a")); expect(mocks.focus.get("b")).not.toHaveBeenCalled();
    expect(useUiStore.getState()).toBe(ui); expect(useWorkspaceListStore.getState()).toBe(layout);
    const unregister = focusController.registerTerminal("b", {
      focus: mocks.focus.get("b")!, containsActiveElement: () => document.activeElement === textarea(),
    });
    try {
      await advance(500); // Registration alone must not acquire a stationary pointer.
      expect(active()).toBe("a"); expect(document.activeElement).toBe(textarea("a"));
      expect(useUiStore.getState()).toBe(ui); expect(useWorkspaceListStore.getState()).toBe(layout);
      expect(mocks.focus.get("b")).not.toHaveBeenCalled();
      await aim(content(), { clientX: 21 }); // No leave/enter, store receipt, layout change or new focus event.
      await advance(99); expect(active()).toBe("a"); expect(document.activeElement).toBe(textarea("a"));
      await advance(1); expect(active()).toBe("b"); expect(document.activeElement).toBe(textarea());
      expect(mocks.focus.get("b")).toHaveBeenCalledOnce(); expect(useUiStore.getState().focusRevision).toBe(ui.focusRevision + 1);
      expect(useWorkspaceListStore.getState()).toBe(layout);
      expect(usePaneMetadataStore.getState().metadata.b.notificationCount).toBe(0);
    } finally { unregister(); }
  });
  it.each(["role", "aria-modal", "class", "data-cmux-overlay-root", "data-cmux-native-webview-occluder", "data-pane-hover-focus-blocker"])(
    "I09/U07 unfocused blocker %s stops first rAF", async (attr) => {
      await mount(); await aim(); await advance(100, false); expect(active()).toBe("a");
      const blocker = document.createElement("div"); blocker.setAttribute(attr, attr === "role" ? "dialog" : attr === "class" ? "cmux-popover-panel" : "true"); document.body.append(blocker);
      await advance(0); expect(mocks.focus.get("b")).not.toHaveBeenCalled(); expect(active()).toBe("a");
    });
  it("I04 hover StrictMode mount leaves one live listener group and unsubscribes every runtime subscription", async () => {
    const add = vi.spyOn(EventTarget.prototype, "addEventListener"), remove = vi.spyOn(EventTarget.prototype, "removeEventListener");
    const unsubscribers: ReturnType<typeof vi.fn>[] = [];
    for (const store of [useSettingsStore, useUiStore, useWorkspaceListStore, usePaneDragStore, useSavepointDragStore, useDetachedDockStore]) {
      const subscribe = store.subscribe;
      vi.spyOn(store, "subscribe").mockImplementation((fn: any) => {
        const unsub = subscribe(fn);
        if (!fn.name.startsWith("paneHoverFocus")) return unsub;
        const tracked = vi.fn(unsub); unsubscribers.push(tracked); return tracked;
      });
    }
    await mount(workspace(), true);
    const moves = (calls: any[][]) => calls.filter(([name, fn]) => name === "pointermove" && fn.name === "paneHoverFocusListener");
    expect(moves(add.mock.calls).length - moves(remove.mock.calls).length).toBe(1);
    await aim(); await act(async () => { root.render(null); }); await advance(200);
    expect(moves(remove.mock.calls)).toHaveLength(moves(add.mock.calls).length);
    expect(unsubscribers.length).toBeGreaterThanOrEqual(6); expect(unsubscribers.every((fn) => fn.mock.calls.length === 1)).toBe(true);
    expect(active()).toBe("a");
  });
  it.each(["input", "modal", "popover"])("I09 protects %s opened during pending focus and rAF, including retry", async (kind) => {
    await mount(); mocks.refused.add("b"); await aim(); await advance(100, false);
    expect(active()).toBe("a");
    await act(async () => { vi.advanceTimersByTime(1); frame(); });
    expect(mocks.focus.get("b")).toHaveBeenCalledOnce();
    const editor = field();
    if (kind !== "input") editor.setAttribute(kind === "modal" ? "role" : "data-pane-hover-focus-blocker", kind === "modal" ? "dialog" : "true");
    await advance(500); expect(document.activeElement).toBe(editor); expect(active()).toBe("a");
    expect(mocks.focus.get("b")).toHaveBeenCalledOnce(); expect(frames).toHaveLength(0);
  });
  it("I09 input opened before first rAF prevents any hover focus and does not roll back", async () => {
    await mount(); await aim(); await advance(100, false); const editor = field();
    await advance(0); expect(document.activeElement).toBe(editor); expect(mocks.focus.get("b")).not.toHaveBeenCalled(); expect(active()).toBe("a");
  });
  it.each(["click", "hover"] as const)("I10 unchanged left/right/cancel/modifier/5px/selection/input behavior in %s", async (mode) => {
    useSettingsStore.setState({ paneFocusMode: mode }); await mount();
    const request = vi.spyOn(focusController, "request");
    const reset = async () => { await act(async () => { useUiStore.setState({ activePaneId: "a", focusRevision: 0 }); }); request.mockClear(); };
    for (const [distance, result] of [[5, "commit"], [6, "abort"]] as const) {
      await reset(); await act(async () => { pointer(content(), "pointerdown", { buttons: 1, clientX: 0 }); pointer(content(), "pointerup", { clientX: distance }); });
      expect(request.mock.calls.map(([source, intent]) => [source, intent.action])).toEqual([["pointer", "pending"], ["pointer", result]]);
      expect(active()).toBe(result === "commit" ? "b" : "a");
    }
    await reset(); await act(async () => { pointer(content(), "pointerdown", { buttons: 2, button: 2 }); }); expect(active()).toBe("b");
    await reset(); await act(async () => { pointer(content(), "pointerdown", { buttons: 1 }); pointer(content(), "pointercancel"); }); expect(request.mock.calls[1][1].action).toBe("abort");
    for (const modifier of ["shiftKey", "ctrlKey", "metaKey", "altKey"]) {
      await reset(); await act(async () => { pointer(content(), "pointerdown", { buttons: 1, [modifier]: true }); pointer(content(), "pointerup"); }); expect(request).not.toHaveBeenCalled();
    }
    await reset(); document.getSelection()!.removeAllRanges(); await act(async () => {
      pointer(content(), "pointerdown", { buttons: 1 }); const selection = document.getSelection()!;
      const range = document.createRange(); range.selectNodeContents(content().querySelector("[data-line]")!); selection.addRange(range);
      pointer(content(), "pointerup"); selection.removeAllRanges();
    }); expect(active()).toBe("a"); expect(request.mock.calls[1][1].action).toBe("abort");
    await reset(); await act(async () => { pointer(content(), "pointerdown", { buttons: 1 }); textarea().value = "first"; textarea().dispatchEvent(new Event("input", { bubbles: true })); });
    expect(active()).toBe("b"); expect(mocks.accepted).toEqual([["b", "first"]]);
  });
  it("I10 hover clears prior wheel/pointer suppression without dropping ordinary or IME text", async () => {
    await mount(); focusController.request("wheel", { sessionId: "b", previousSessionId: "a" });
    focusController.request("pointer", { sessionId: "c", action: "pending", focus: false });
    await aim(); await advance(); await advance(0);
    expect(focusController.shouldSuppressWheelFocusInput("b")).toBe(false);
    for (const text of ["x", "確定"]) { await act(async () => { textarea().value = text; textarea().dispatchEvent(new Event("input", { bubbles: true })); }); }
    expect(mocks.accepted).toEqual([["b", "x"], ["b", "確定"]]); expect(focusController.shouldAcceptTerminalInput("c")).toBe(false);
    focusController.clearSession("c");
  });
  it("I11 uses registered focus without scroll/fit/tab manipulation", async () => {
    await mount(); const scroll = vi.spyOn(window, "scrollTo");
    const scrollIntoView = vi.fn(); Object.defineProperty(content(), "scrollIntoView", { configurable: true, value: scrollIntoView });
    content().scrollTop = 42; const request = vi.spyOn(focusController, "focusPaneSoon");
    await aim(); await advance(); await advance(0); expect(mocks.focus.get("b")).toHaveBeenCalledOnce();
    expect(scroll).not.toHaveBeenCalled(); expect(scrollIntoView).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled(); expect(content().scrollTop).toBe(42);
  });
  it("I07 review: zero-area content invalidates a pending dwell", async () => {
    await mount(); await aim();
    vi.spyOn(content(), "getClientRects").mockReturnValue([{ width: 0, height: 0 }] as any);
    await advance(200); expect(active()).toBe("a");
  });
  it("I05 review: capture already held when the runtime starts cannot arm", async () => {
    await mount(); Object.defineProperty(content(), "hasPointerCapture", { configurable: true, value: () => true });
    await aim(); await advance(200); expect(active()).toBe("a");
  });
  it.each(["pending", "committed"])("I09 review: pointer leaving after dwell distinguishes %s ownership", async (phase) => {
    await mount(); await act(async () => { textarea("a").focus(); }); await aim();
    await advance(100, phase === "committed");
    expect(active()).toBe(phase === "pending" ? "a" : "b");
    await act(async () => { pointer(content(), "pointerleave", { relatedTarget: document.body }); });
    await advance(0); await advance(200);
    expect(active()).toBe(phase === "pending" ? "a" : "b");
    expect(document.activeElement).toBe(textarea(phase === "pending" ? "a" : "b"));
  });
  it("I09 review: a transient editor in the pending pane permanently cancels old hover focus", async () => {
    await mount(); await aim(); await advance(100, false); expect(active()).toBe("a");
    const editor = document.createElement("input"); content().append(editor); editor.focus(); editor.blur();
    await advance(0); expect(mocks.focus.get("b")).not.toHaveBeenCalled(); expect(active()).toBe("a");
  });
  it("I07 review: ordinary xterm output and decoration do not cancel a dwell", async () => {
    await mount(); await aim(); const screen = content().querySelector<HTMLElement>("[data-screen]")!;
    await act(async () => { screen.append(document.createElement("span")); screen.className = "xterm-output-decoration"; });
    await advance(); expect(active()).toBe("b"); expect(document.activeElement).toBe(textarea());
  });
  it.each([false, true])("S05 setting receipt=%s stops pending dwell and retry and cleans runtime", async (receipt) => {
    await mount(); await aim();
    const off = () => receipt ? applyExternalStoreUpdate(useSettingsStore, { paneFocusMode: "click" }) : useSettingsStore.getState().setPaneFocusMode("click");
    await act(async () => { off(); }); await advance(200); expect(active()).toBe("a");
    await act(async () => { useSettingsStore.getState().setPaneFocusMode("hover"); });
    await aim(content(), { clientX: 21 }); await advance(100, false); expect(active()).toBe("a");
    await act(async () => { off(); }); await advance(500); expect(mocks.focus.get("b")).not.toHaveBeenCalled();
  });
});


async function imeEvent(type: "compositionstart" | "compositionend" | "keyup" | "normal" | "Process" | "229" | "isComposing") {
  await act(async () => {
    const target = document.activeElement!;
    target.dispatchEvent(type.startsWith("composition") ? new CompositionEvent(type, { bubbles: true })
      : new KeyboardEvent(type === "keyup" ? "keyup" : "keydown", { bubbles: true,
        key: type === "Process" ? "Process" : "a", keyCode: type === "229" ? 229 : 0, isComposing: type === "isComposing" }));
  });
}

describe("F4 runtime IME ordering", () => {
  it.each(["Process", "229", "isComposing"] as const)("F4 %s before compositionend resumes after definite completion", async (signal) => {
    await mount(); await act(async () => { textarea("a").focus(); }); await aim();
    await imeEvent("compositionstart"); await imeEvent(signal); await imeEvent("keyup");
    await aim(content(), { clientX: 21 }); await advance(1_000); expect(active()).toBe("a");
    await imeEvent("compositionend"); await imeEvent("normal"); await advance(200); expect(active()).toBe("a");
    await aim(content(), { clientX: 22 }); await advance(); expect(active()).toBe("b");
  });
  it.each(["Process", "229", "isComposing"] as const)("F4 %s after compositionend resolves on ordinary key without a click", async (signal) => {
    await mount(); await act(async () => { textarea("a").focus(); }); await aim();
    await imeEvent("compositionstart"); await imeEvent("compositionend"); await imeEvent(signal); await imeEvent("keyup");
    await aim(content(), { clientX: 21 }); await advance(1_000); expect(active()).toBe("a");
    await imeEvent("normal"); await advance(200); expect(active()).toBe("a");
    await aim(content(), { clientX: 22 }); await advance(); expect(active()).toBe("b");
    expect(document.activeElement).toBe(textarea("b"));
  });
  it.each(["compositionend", "focuschange", "normal"] as const)("F4 fallback with no composition needs %s and fresh movement", async (resolution) => {
    await mount(); await act(async () => { textarea("a").focus(); }); await aim();
    await imeEvent("Process"); await imeEvent("keyup"); await aim(content(), { clientX: 21 });
    await advance(1_000); expect(active()).toBe("a");
    if (resolution === "focuschange") await act(async () => { field("button"); textarea("a").focus(); });
    else await imeEvent(resolution);
    await advance(200); expect(active()).toBe("a");
    await aim(content(), { movementX: 0, clientX: 21 }); await advance(200); expect(active()).toBe("a");
    await aim(content(), { clientX: 22 }); await advance(); expect(active()).toBe("b");
  });
  it("F4 fallback followed by real composition cannot be ended by ordinary keys", async () => {
    await mount(); await act(async () => { textarea("a").focus(); });
    await imeEvent("Process"); await imeEvent("compositionstart"); await imeEvent("normal");
    await aim(); await advance(1_000); expect(active()).toBe("a");
    await imeEvent("compositionend"); await advance(200); expect(active()).toBe("a");
    await aim(content(), { clientX: 21 }); await advance(); expect(active()).toBe("b");
  });
  it.each(["observed", "inferred"] as const)("F4 window return with missing end preserves %s evidence until definite resolution", async (evidence) => {
    await mount(); await act(async () => { textarea("a").focus(); });
    await imeEvent(evidence === "observed" ? "compositionstart" : "Process");
    await act(async () => { window.dispatchEvent(new Event("blur")); window.dispatchEvent(new Event("focus")); });
    await aim(); await advance(1_000); expect(active()).toBe("a");
    await imeEvent("normal"); await aim(content(), { clientX: 21 }); await advance();
    expect(active()).toBe(evidence === "observed" ? "a" : "b");
    if (evidence === "observed") {
      await act(async () => { field("button"); textarea("a").focus(); });
      await advance(200); expect(active()).toBe("a");
      await aim(content(), { clientX: 22 }); await advance(); expect(active()).toBe("b");
    }
  });
});
