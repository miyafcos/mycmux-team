import { describe, expect, it } from "vitest";
import { createPaneHoverState, decidePaneHoverFocus, PANE_HOVER_FOCUS_DWELL_MS,
  type PaneHoverSnapshot, type PaneHoverState } from "../../src/lib/paneHoverFocus";

const surface = {}, otherSurface = {};
export function snapshot(patch: Partial<PaneHoverSnapshot> = {}): PaneHoverSnapshot {
  return { mode: "hover", target: { workspaceId: "w", paneId: "b", tabId: "t", sessionId: "b", surface, kind: "terminal" },
    activePaneId: "a", focusRevision: 2, layoutRevision: 4, zoomedPaneId: null, blockerRevision: 0,
    windowFocused: true, documentVisible: true, connected: true, visible: true, samePane: false,
    dragging: false, captured: false, blocked: false, editorFocused: false, selected: false, ...patch };
}
function move(state = createPaneHoverState(), s = snapshot(), patch = {}) {
  return decidePaneHoverFocus(state, { type: "move", now: 0, snapshot: s, pointerId: 1,
    x: 10, y: 10, movementX: 1, pointerType: "mouse", buttons: 0, modified: false, ...patch });
}
function dwell(state: PaneHoverState, now = 100, s = snapshot()) {
  return decidePaneHoverFocus(state, { type: "dwell", now, snapshot: s });
}

describe("pure pane hover decisions", () => {
  it("U01 enter, stationary/unknown moves and enable/layout/focus never arm", () => {
    let state = decidePaneHoverFocus(createPaneHoverState(), { type: "enter", surface }).state;
    expect(state.candidate).toBeNull();
    state = move(state, snapshot(), { movementX: 0 }).state;
    expect(state.candidate).toBeNull();
    for (const type of ["invalidate", "focus", "visibility", "up"] as const) {
      state = decidePaneHoverFocus(state, { type }).state;
      expect(move(state, snapshot(), { movementX: 0 }).effect.type).toBe("none");
    }
    expect(move(state, snapshot(), { x: 11 }).effect.type).toBe("arm");
  });
  it.each([99, 100, 101])("U02 dwell %i ms", (now) => {
    expect(PANE_HOVER_FOCUS_DWELL_MS).toBe(100);
    const state = move().state;
    expect(dwell(state, now).effect.type).toBe(now < 100 ? "none" : "activate");
    expect(state.candidate).not.toBeNull(); // immutable
  });
  it("U03 passage/new surface cancels; nested children keep the surface", () => {
    const state = move().state;
    expect(decidePaneHoverFocus(state, { type: "enter", surface }).state.candidate).toBe(state.candidate);
    const left = decidePaneHoverFocus(state, { type: "leave", surface }).state;
    expect(dwell(left).effect.type).toBe("none");
    const next = move(state, snapshot({ target: { ...snapshot().target!, surface: otherSurface } }), { now: 75, x: 20 });
    expect(next.state.candidate?.startedAt).toBe(75);
    expect(dwell(next.state, 100, next.state.candidate!.snapshot).effect.type).toBe("none");
  });
  it("U04 continuous moves preserve start and same-pane includes any sibling", () => {
    const first = move().state;
    const next = move(first, snapshot(), { now: 90, x: 12 });
    expect(next.state.candidate).toBe(first.candidate);
    expect(dwell(next.state).effect.type).toBe("activate");
    expect(move(next.state, snapshot({ samePane: true })).state.candidate).toBeNull();
  });
  it.each(["input", "textarea", "select", "contenteditable=true", "contenteditable=", "plaintext-only", "inherited", "search", "iframe", "embed", "object"])(
    "U05 supplied protected focus %s blocks", () => { expect(move(undefined, snapshot({ editorFocused: true })).effect.type).toBe("cancel"); });
  it("U05 normal xterm permits activation", () => { expect(dwell(move().state).effect.type).toBe("activate"); });
  it.each(["composer", "composer-padding", "composer-badge"])("U06 supplied composer gate %s blocks", () => {
    expect(move(undefined, snapshot({ editorFocused: true })).state.candidate).toBeNull();
  });
  it.each(["modal", "seeThrough", "palette", "popover", "menu", "rename", "closing"])("U07 %s blocks and epochs prevent resurrection", () => {
    const state = move().state;
    expect(dwell(state, 100, snapshot({ blocked: true })).effect.type).toBe("cancel");
    expect(dwell(state, 100, snapshot({ blockerRevision: 2 })).effect.type).toBe("cancel");
  });
  it("U08 composition and key fallback cancel without automatic resume", () => {
    for (const event of [{ type: "compositionstart" }, { type: "key", composing: true }] as const) {
      const state = decidePaneHoverFocus(move().state, event).state;
      expect(dwell(state, 10_000).effect.type).toBe("none");
      const ended = decidePaneHoverFocus(state, { type: "compositionend" }).state;
      expect(ended.candidate).toBeNull();
      expect(move(ended, snapshot(), { x: 11 }).effect.type).toBe("arm");
    }
  });
  it.each(["compositionend", "focuschange", "key"] as const)("U08 unknown resolves only by %s", (type) => {
    const unknown = move(createPaneHoverState("unknown")).state;
    expect(dwell(unknown, 1_000_000).effect.type).toBe("none");
    const resolved = decidePaneHoverFocus(unknown, type === "key" ? { type, composing: false } : { type }).state;
    expect(resolved.ime).toBe("known"); expect(resolved.candidate).toBeNull();
    expect(move(resolved, snapshot(), { x: 11 }).effect.type).toBe("arm");
  });
  it.each([1, 2, 4])("U09 buttons %i block", (buttons) => { expect(move(undefined, snapshot(), { buttons }).state.candidate).toBeNull(); });
  it("U09 down/capture/modifiers/drag and release/cancel require new motion", () => {
    for (const s of [snapshot({ captured: true }), snapshot({ dragging: true })]) expect(move(undefined, s).effect.type).toBe("cancel");
    expect(move(undefined, snapshot(), { modified: true }).effect.type).toBe("cancel");
    const down = decidePaneHoverFocus(move().state, { type: "down" }).state;
    expect(move(down, snapshot(), { x: 11 }).state.candidate).toBeNull();
    for (const type of ["up", "cancel"] as const) expect(decidePaneHoverFocus(down, { type }).state.candidate).toBeNull();
  });
  it.each(["touch", "pen", "", "unknown"])("U10 pointer type %s blocks", (pointerType) => {
    expect(move(undefined, snapshot(), { pointerType }).state.candidate).toBeNull();
  });
  it("U10 inactive/hidden and blur/focus require movement", () => {
    for (const patch of [{ windowFocused: false }, { documentVisible: false }]) expect(move(undefined, snapshot(patch)).effect.type).toBe("cancel");
    const blurred = decidePaneHoverFocus(move().state, { type: "blur" }).state;
    const focused = decidePaneHoverFocus(blurred, { type: "focus" }).state;
    expect(move(focused, snapshot()).effect.type).toBe("none");
    expect(move(focused, snapshot(), { x: 11 }).effect.type).toBe("arm");
  });
  it.each([
    { mode: "click" }, { connected: false }, { visible: false }, { target: null },
    { activePaneId: "new" }, { focusRevision: 3 }, { layoutRevision: 5 }, { zoomedPaneId: "b" }, { blockerRevision: 1 },
    ...["workspaceId", "paneId", "tabId", "sessionId", "surface", "kind"].map((key) => ({
      target: { ...snapshot().target!, [key]: key === "surface" ? otherSurface : "new" },
    })),
  ])("U11 rejects stale identity/revisions %j", (patch) => {
    expect(dwell(move().state, 100, snapshot(patch as any)).effect.type).toBe("cancel");
  });
  it.each(["browser", "web", "online", "declared", "dormant", "hidden-retained", "detached"])("U12 unsupported %s has no target", () => {
    expect(move(undefined, snapshot({ target: null })).state.candidate).toBeNull();
  });
  it("U12 noncollapsed selection blocks", () => { expect(move(undefined, snapshot({ selected: true })).effect.type).toBe("cancel"); });
  it.each([
    ["U05/U06", { editorFocused: true }], ["U07", { blocked: true }],
    ["U09", { dragging: true }], ["U09", { captured: true }],
    ["U10", { windowFocused: false }], ["U10", { documentVisible: false }],
    ["U11", { mode: "click" }], ["U11", { visible: false }], ["U11", { connected: false }],
    ["U12", { target: null }], ["U12", { selected: true }], ["U04", { samePane: true }],
  ])("%s gate %j rejects before arm and at dwell", (_id, patch) => {
    const blocked = snapshot(patch as Partial<PaneHoverSnapshot>);
    expect(move(undefined, blocked).state.candidate).toBeNull();
    expect(dwell(move().state, 100, blocked).effect.type).toBe("cancel");
  });
  it("U08 ordinary key does not end an observed composition; unknown still has three resolutions", () => {
    const composing = decidePaneHoverFocus(move().state, { type: "compositionstart" }).state;
    const typed = decidePaneHoverFocus(composing, { type: "key", composing: false }).state;
    expect(typed.ime).toBe("composing"); expect(move(typed, snapshot(), { x: 11 }).state.candidate).toBeNull();
  });
});


describe("F4 inferred IME evidence", () => {
  it.each(["before-end", "after-end"] as const)("F4 fallback %s recovers on a definite ordinary key", (order) => {
    let state = decidePaneHoverFocus(move().state, { type: "compositionstart" }).state;
    if (order === "before-end") {
      state = decidePaneHoverFocus(state, { type: "key", composing: true }).state;
      expect(state.ime).toBe("composing");
    }
    state = decidePaneHoverFocus(state, { type: "compositionend" }).state;
    if (order === "after-end") {
      state = decidePaneHoverFocus(state, { type: "key", composing: true }).state;
      expect(state.ime).toBe("unknown");
      expect(dwell(move(state, snapshot(), { x: 11 }).state, 10_000).effect.type).toBe("none");
    }
    state = decidePaneHoverFocus(state, { type: "key", composing: false }).state;
    expect(state.ime).toBe("known"); expect(state.candidate).toBeNull();
    expect(move(state).effect.type).toBe("none");
    expect(dwell(move(state, snapshot(), { x: 12 }).state).effect.type).toBe("activate");
  });
  it.each(["compositionend", "focuschange", "key"] as const)("F4 fallback without composition resolves only through %s", (type) => {
    let state = decidePaneHoverFocus(move().state, { type: "key", composing: true }).state;
    expect(state.ime).toBe("unknown");
    state = move(state, snapshot(), { x: 11 }).state;
    expect(dwell(state, 1_000_000).effect.type).toBe("none");
    state = decidePaneHoverFocus(state, { type: "focus" }).state;
    expect(state.ime).toBe("unknown");
    state = decidePaneHoverFocus(state, type === "key" ? { type, composing: false } : { type }).state;
    expect(state.ime).toBe("known"); expect(state.candidate).toBeNull();
    expect(move(state, snapshot(), { x: 11 }).effect.type).toBe("none");
    expect(move(state, snapshot(), { x: 12 }).effect.type).toBe("arm");
  });
  it("F4 observed composition after fallback stays live through ordinary keys", () => {
    let state = decidePaneHoverFocus(move().state, { type: "key", composing: true }).state;
    state = decidePaneHoverFocus(state, { type: "compositionstart" }).state;
    state = decidePaneHoverFocus(state, { type: "key", composing: false }).state;
    expect(state.ime).toBe("composing"); expect(move(state, snapshot(), { x: 11 }).effect.type).toBe("cancel");
    state = decidePaneHoverFocus(state, { type: "compositionend" }).state;
    expect(move(state, snapshot(), { x: 12 }).effect.type).toBe("arm");
  });
  it("F4 window return without compositionend does not end an observed composition", () => {
    let state = decidePaneHoverFocus(move().state, { type: "compositionstart" }).state;
    for (const type of ["blur", "focus", "visibility"] as const) state = decidePaneHoverFocus(state, { type }).state;
    state = decidePaneHoverFocus(state, { type: "key", composing: false }).state;
    expect(state.ime).toBe("composing"); expect(dwell(move(state, snapshot(), { x: 11 }).state, 10_000).effect.type).toBe("none");
    state = decidePaneHoverFocus(state, { type: "focuschange" }).state;
    expect(state.ime).toBe("known"); expect(move(state, snapshot(), { x: 12 }).effect.type).toBe("arm");
  });
});
