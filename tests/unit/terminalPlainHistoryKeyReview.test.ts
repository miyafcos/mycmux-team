// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isPlainTerminalInputEvent } from "../../src/components/terminal/terminalFocusHelpers";
import { ConversationHistoryArbiter, isExplicitHistoryKey, isHistoryBoundaryKey, type HistorySafety } from "../../src/components/terminal/conversationHistoryAdmission";
import type { ConversationHistoryMode } from "../../src/lib/conversationHistory";
import type { LiveSessionBrief } from "../../src/lib/livebrief";
import { useKeybindingStore } from "../../src/stores/keybindingStore";
import { useSettingsStore } from "../../src/stores/settingsStore";

// Execute the entire production registration function without rewriting its
// branches. Only its surrounding component state and terminal attachment are
// supplied here; plain-input detection, shortcut lookup and arbitration are real.
const source = readFileSync("src/components/terminal/XTermWrapper.tsx", "utf8");
const start = source.indexOf("const attachTerminalKeyHandler = ");
const end = source.indexOf("const publishScreenScanEvidence = ", start);
if (start < 0 || end <= start) throw new Error("Production key handler registration not found");
const compiled = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true });
if (compiled.diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error)) throw new Error("Production key handler did not compile");
const originalMode = useSettingsStore.getState().conversationHistoryMode;
const originalOverrides = useKeybindingStore.getState().overrides;
afterEach(() => { vi.restoreAllMocks(); useSettingsStore.setState({ conversationHistoryMode: originalMode }); useKeybindingStore.getState().hydrateOverrides(originalOverrides); });
function fixture(mode: ConversationHistoryMode, facts: { viewportY?: number; composing?: boolean; dragging?: boolean; search?: boolean; turns?: boolean } = {}) {
  useSettingsStore.setState({ conversationHistoryMode: mode });
  useKeybindingStore.getState().resetAll();
  const arbiter = new ConversationHistoryArbiter(), open = vi.fn(() => true), zoom = vi.fn(), search = vi.fn(), write = vi.fn();
  const active = { type: "normal" as const, baseY: 5000, viewportY: facts.viewportY ?? 0 };
  let handler!: (event: KeyboardEvent) => boolean;
  const term = { buffer: { active }, attachCustomKeyEventHandler: (callback: typeof handler) => { handler = callback; } };
  const now = 10000;
  const safety: HistorySafety = {
    active: true, visible: true, disposed: false, composing: false, selecting: false, dragging: false, overlay: false,
    liveAgentKind: "claude", ptyAlive: true, ready: true, now,
    descriptor: { ptySessionId: "key-pty", tabId: "key-tab", expectedAgentKind: "claude", expectedAgentSessionId: "exact" },
    attention: { sessionId: "key-pty", sessionEpoch: 7, attentionId: null, kind: "none", detail: null, sessionRevision: 1, uiState: "working", stateSince: now, occurrenceOrder: 1 },
    signals: { activity: "streaming", health: "fresh", lastOutputAt: now, lastMonitorAt: now, lastEvidenceAt: now, processStartedAt: 1 },
    brief: { ptySessionId: "key-pty", ptyGeneration: 7, agentKind: "claude", agentSessionId: "exact", telemetryHealth: "live", pendingInputKind: null, pendingPrompt: null, lastSuccessfulReadAt: now, operationalState: "running" } as LiveSessionBrief,
  };
  const boundary = vi.fn((_term: typeof term, interaction: { composing: boolean; dragging: boolean }, overlay: boolean) =>
    arbiter.boundary(useSettingsStore.getState().conversationHistoryMode, active, { ...safety, ...interaction, overlay }, open));
  const context = {
    sessionId: "key-pty", IS_MAC: false, recordPerf: vi.fn(), shouldAcceptTerminalInput: () => true,
    usePaneMetadataStore: { getState: () => ({ volatileMetadata: {} }) }, enqueueSessionWrite: write,
    getShiftEnterSequence: () => "\n", launchParamsRef: { current: { command: "claude" } },
    isPlainTerminalInputEvent, useSettingsStore, useKeybindingStore, openSearch: search, onZoomToggle: zoom,
    isImeComposing: facts.composing ?? false, historyDragging: facts.dragging ?? false,
    searchOpenRef: { current: facts.search ?? false }, turnListOpenRef: { current: facts.turns ?? false },
    disposed: false, termDisposed: false, isExplicitHistoryKey, isHistoryBoundaryKey,
    archiveEntryRef: { current: { boundary, explicit: vi.fn(() => false) } },
  };
  const register = new Function(...Object.keys(context), compiled.outputText + "\nreturn attachTerminalKeyHandler;")(...Object.values(context));
  register(term);
  return { handler, open, zoom, search, write, boundary };
}
function key(patch: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: "PageUp", shiftKey: true, bubbles: true, cancelable: true, ...patch });
  const stop = vi.spyOn(event, "stopPropagation"); return { event, stop };
}
describe("production terminal plain-key history boundary review", () => {
  for (const mode of ["agent-wheel", "legacy"] as const) {
    it.each([0, 3])(`keeps a user-assigned Shift+PageUp out of shortcuts in ${mode}, viewport=%s`, viewportY => {
      const f = fixture(mode, { viewportY });
      useKeybindingStore.getState().setOverride("pane.zoom.toggle", "shift+pageup");
      const { event, stop } = key();
      expect(useKeybindingStore.getState().getActionsForEvent(event)).toContain("pane.zoom.toggle");
      const lookup = vi.spyOn(useKeybindingStore.getState(), "getActionsForEvent");
      const result = f.handler(event);
      expect(f.zoom).not.toHaveBeenCalled(); expect(f.search).not.toHaveBeenCalled(); expect(lookup).not.toHaveBeenCalled();
      expect(result).toBe(mode === "agent-wheel" && viewportY === 0 ? false : true);
      expect(f.open).toHaveBeenCalledTimes(mode === "agent-wheel" && viewportY === 0 ? 1 : 0);
      expect(event.defaultPrevented).toBe(mode === "agent-wheel" && viewportY === 0); expect(stop).toHaveBeenCalledOnce(); expect(f.write).not.toHaveBeenCalled();
    });
  }
  it.each([0, 3])("unassigned agent-wheel Shift+PageUp transfers only the top boundary, viewport=%s", viewportY => {
    const f = fixture("agent-wheel", { viewportY }), { event, stop } = key();
    expect(f.handler(event)).toBe(viewportY === 0 ? false : true); expect(f.open).toHaveBeenCalledTimes(viewportY === 0 ? 1 : 0);
    expect(event.defaultPrevented).toBe(viewportY === 0); expect(stop).toHaveBeenCalledOnce(); expect(f.write).not.toHaveBeenCalled();
  });
  it.each([{ composing: true }, { dragging: true }, { search: true }, { turns: true }])("keeps interaction %j in xterm", facts => {
    const f = fixture("agent-wheel", facts), { event, stop } = key();
    expect(f.handler(event)).toBe(true); expect(f.open).not.toHaveBeenCalled(); expect(event.defaultPrevented).toBe(false); expect(stop).toHaveBeenCalledOnce();
  });
  it("leaves an IME composition key on its existing early return", () => {
    const f = fixture("agent-wheel"), { event } = key({ isComposing: true });
    expect(f.handler(event)).toBe(true); expect(f.boundary).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled();
  });
  it("retains user shortcut precedence for the dedicated modified history chord", () => {
    const f = fixture("agent-wheel"); useKeybindingStore.getState().setOverride("pane.zoom.toggle", "ctrl+alt+pageup");
    const { event, stop } = key({ shiftKey: false, ctrlKey: true, altKey: true });
    expect(f.handler(event)).toBe(false); expect(f.zoom).toHaveBeenCalledOnce(); expect(f.boundary).not.toHaveBeenCalled(); expect(stop).toHaveBeenCalledOnce(); expect(event.defaultPrevented).toBe(true);
  });
});
