// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mappings: vi.fn(), release: vi.fn(), hold: vi.fn(() => mocks.release),
  mounted: vi.fn(), unmounted: vi.fn(), invoke: vi.fn(),
}));
vi.mock("../../src/lib/ipc", async (original) => ({
  ...await original<typeof import("../../src/lib/ipc")>(), readAgentSessionMappings: mocks.mappings,
}));
vi.mock("../../src/stores/liveBriefStore", async (original) => ({
  ...await original<typeof import("../../src/stores/liveBriefStore")>(), holdDetailSession: mocks.hold,
}));
vi.mock("@tauri-apps/api/core",async original=>({...await original<typeof import("@tauri-apps/api/core")>(),invoke:mocks.invoke}));
import { TerminalHistoryEntry, HISTORY_MAPPING_POLL_MS, TERMINAL_HISTORY_EVENT } from "../../src/components/terminal/TerminalHistoryEntry";
import { useTerminalHistoryPanel } from "../../src/components/terminal/useTerminalHistoryPanel";
import { TerminalTranscriptPanel } from "../../src/components/terminal/TerminalTranscriptPanel";
import { NotificationsLayoutTab } from "../../src/components/settings/tabs/NotificationsLayoutTab";
import { notificationSettingsStrings } from "../../src/components/settings/settingsStrings";
import { terminalTurnStrings } from "../../src/components/terminal/terminalTurnStrings";
import { focusController } from "../../src/lib/focusController";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useLiveBriefStore } from "../../src/stores/liveBriefStore";
import { useDashboardViewStore } from "../../src/stores/dashboardViewStore";
import { useUiStore } from "../../src/stores/uiStore";

let root: Root;
let container: HTMLDivElement;
let terminalHost: HTMLDivElement;
let unregisterTerminals: (() => void)[];
function LiveTerminal({ tick }: { tick: number }) {
  useEffect(() => { mocks.mounted(); return () => { mocks.unmounted(); }; }, []);
  return <div data-live-terminal="true">live output {tick}</div>;
}
function Harness({ sessionId = "pty-a", tick = 0, variant = "header" }: { sessionId?: string; tick?: number; variant?: "header" | "menu" }) {
  const { transcriptPanelOpen, closeTranscriptPanel } = useTerminalHistoryPanel(sessionId);
  return <>
    <TerminalHistoryEntry sessionId={sessionId} variant={variant} />
    <LiveTerminal tick={tick} />
    {transcriptPanelOpen && <TerminalTranscriptPanel sessionId={sessionId} tabId="tab-a" onClose={closeTranscriptPanel} />}
  </>;
}
async function render(node = <Harness />): Promise<void> {
  await act(async () => { root.render(node); });
}
async function clickEntry(): Promise<void> {
  await act(async () => {
    container.querySelector<HTMLButtonElement>("[data-terminal-magnifier]")?.click();
  });
}
function requestHistory(sessionId: string): void {
  window.dispatchEvent(new CustomEvent(TERMINAL_HISTORY_EVENT, { detail: { sessionId } }));
}
beforeEach(() => {
  // Preserve the existing 200-event characterization through the explicit legacy mode.
  useSettingsStore.setState({ conversationHistoryMode: "legacy" });
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  mocks.invoke.mockImplementation(async(cmd:string)=>cmd==="open_transcript_history"?{readerId:"empty-reader",sourceGeneration:"g",snapshotEnd:"0",items:[],olderCursor:null,newerCursor:"tail",latestCursor:"latest",scanContinuation:null,reachedStart:true,reachedFence:true,diagnostics:[]}:[]);
  mocks.mappings.mockResolvedValue({ "pty-a": { agent_kind: "claude", session_id: "exact-conversation-a" } });
  vi.spyOn(focusController, "request").mockImplementation((_source, intent) => {
    useUiStore.getState().setActivePaneId(intent.sessionId ?? null);
  });
  useSettingsStore.setState({ showTerminalHistoryButton: true });
  useUiStore.setState({ activePaneId: "pty-a" });
  useDashboardViewStore.setState({ open: false, userTurnRequests: {} });
  useLiveBriefStore.getState().reset();
  useLiveBriefStore.setState({ eventsBySession: { "pty-a": [] }, eventsFetchedAtBySession: { "pty-a": 1 } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  terminalHost = document.createElement("div");
  document.body.append(terminalHost);
  unregisterTerminals = ["pty-a", "pty-b"].map(sessionId => {
    const input = document.createElement("textarea");
    terminalHost.append(input);
    return focusController.registerTerminal(sessionId, {
      focus: () => input.focus(), containsActiveElement: () => document.activeElement === input,
      isEligible: () => input.isConnected,
    });
  });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  for (const unregister of unregisterTerminals) unregister();
  terminalHost.remove();
  vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe("persistent exact-session history entry (P1)", () => {
  it.each((["header", "menu"] as const).flatMap(variant => [1, 2].flatMap(stage =>
    (["selection", "outside"] as const).map(decision => ({ variant, stage, decision })))))
  ("N1 $variant rejects late mapping step $stage after $decision while A stays displayed", async ({ variant, stage, decision }) => {
    await render(<Harness variant={variant} />);
    const entry = container.querySelector<HTMLButtonElement>("[data-terminal-magnifier]")!;
    await act(async () => entry.focus());
    const mapping = { "pty-a": { agent_kind: "claude", session_id: "exact-conversation-a" } };
    let release: ((value: typeof mapping) => void) | undefined;
    if (stage === 2) mocks.mappings.mockResolvedValueOnce(mapping);
    mocks.mappings.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await clickEntry();
    expect(release).toBeTypeOf("function");
    expect(container.querySelector("[data-terminal-transcript-panel]")).toBeNull();
    const newer = decision === "selection" ? terminalHost.querySelectorAll<HTMLTextAreaElement>("textarea")[1]
      : document.createElement("button");
    if (decision === "outside") container.append(newer);
    await act(async () => {
      if (decision === "selection") useUiStore.getState().setActivePaneId("pty-b");
      newer.focus();
    });
    const owner = useUiStore.getState().activePaneId;
    const revision = useUiStore.getState().focusRevision;
    await act(async () => { release!(mapping); await vi.advanceTimersByTimeAsync(20); });
    expect(container.querySelector("[data-live-terminal]")).not.toBeNull(); // A stays displayed.
    expect(container.querySelector("[data-terminal-transcript-panel]")).toBeNull();
    expect(document.activeElement).toBe(newer);
    expect(useUiStore.getState().activePaneId).toBe(owner);
    expect(useUiStore.getState().focusRevision).toBe(revision);
    if (decision === "outside") newer.remove();
  });

  it.each(["header", "menu"] as const)("N1 %s requires a new click after outside focus moves away and returns", async variant => {
    await render(<Harness variant={variant} />);
    const entry = container.querySelector<HTMLButtonElement>("[data-terminal-magnifier]")!;
    await act(async () => entry.focus());
    const mapping = { "pty-a": { agent_kind: "claude", session_id: "exact-conversation-a" } };
    let release!: (value: typeof mapping) => void;
    mocks.mappings.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await clickEntry();
    const outside = document.createElement("button"); container.append(outside);
    await act(async () => { outside.focus(); entry.focus(); release(mapping); });
    expect(container.querySelector("[data-terminal-transcript-panel]")).toBeNull();
    expect(document.activeElement).toBe(entry);
    await clickEntry();
    expect(container.querySelector("[data-terminal-transcript-panel]")).not.toBeNull();
    outside.remove();
  });

  it.each(["missing", "failed"])("L5 keeps focused history stable and unavailable through a %s mapping poll", async result => {
    await render(<Harness variant="menu" />); const button = container.querySelector<HTMLButtonElement>("[data-terminal-magnifier]")!;
    await act(async () => button.focus()); const revision = useUiStore.getState().focusRevision;
    if (result === "failed") mocks.mappings.mockRejectedValue(new Error("Transient mapping read"));
    else mocks.mappings.mockResolvedValue({});
    await act(async () => vi.advanceTimersByTimeAsync(HISTORY_MAPPING_POLL_MS));
    expect.soft(button.isConnected).toBe(true); expect.soft(document.activeElement).toBe(button);
    expect.soft(button.getAttribute("aria-disabled")).toBe("true");
    const requested = vi.fn(); window.addEventListener(TERMINAL_HISTORY_EVENT, requested);
    try { await act(async () => button.click()); expect(requested).not.toHaveBeenCalled(); }
    finally { window.removeEventListener(TERMINAL_HISTORY_EVENT, requested); }
    expect(useUiStore.getState().focusRevision).toBe(revision);
    mocks.mappings.mockResolvedValue({ "pty-a": { agent_kind: "claude", session_id: "exact-a" } });
    await act(async () => vi.advanceTimersByTimeAsync(HISTORY_MAPPING_POLL_MS));
    expect(container.querySelector("[data-terminal-magnifier]")).toBe(button); expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-disabled")).toBe("false");
  });
  it("L5 does not reclaim outside focus when a mapping disappears", async () => {
    await render(<Harness variant="menu" />); const entry = container.querySelector<HTMLButtonElement>("[data-terminal-magnifier]")!;
    await act(async () => entry.focus()); const outside = document.createElement("button"); container.append(outside);
    await act(async () => outside.focus()); mocks.mappings.mockResolvedValue({});
    await act(async () => vi.advanceTimersByTimeAsync(HISTORY_MAPPING_POLL_MS));
    expect(entry.isConnected).toBe(true); expect(entry.getAttribute("aria-disabled")).toBe("true"); expect(document.activeElement).toBe(outside);
  });
  it("L5 leaves an inert history menu item after focus leaves without moving the new focus", async () => {
    await render(<Harness variant="menu" />); const entry = container.querySelector<HTMLButtonElement>("[data-terminal-magnifier]")!;
    await act(async () => entry.focus()); mocks.mappings.mockResolvedValue({});
    await act(async () => vi.advanceTimersByTimeAsync(HISTORY_MAPPING_POLL_MS));
    expect(document.activeElement).toBe(entry);
    const outside = document.createElement("button"); container.append(outside);
    await act(async () => outside.focus());
    expect(entry.isConnected).toBe(true); expect(entry.getAttribute("aria-disabled")).toBe("true"); expect(document.activeElement).toBe(outside);
    expect(container.querySelector("[data-terminal-magnifier-destination=history]")).toBe(entry);
    const requested = vi.fn(); window.addEventListener(TERMINAL_HISTORY_EVENT, requested);
    try { await act(async () => entry.click()); expect(requested).not.toHaveBeenCalled(); }
    finally { window.removeEventListener(TERMINAL_HISTORY_EVENT, requested); }
  });
  it("defaults on and preserves the explicit off choice through persistence", async () => {
    expect(useSettingsStore.getInitialState().showTerminalHistoryButton).toBe(true);
    useSettingsStore.getState().setShowTerminalHistoryButton(false);
    expect(JSON.parse(localStorage.getItem("mycmux-settings")!).state.showTerminalHistoryButton).toBe(false);
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().showTerminalHistoryButton).toBe(false);
  });

  it.each(["claude", "codex"])("offers %s history without requiring turn marks or scrolling", async (kind) => {
    mocks.mappings.mockResolvedValue({ "pty-a": { agent_kind: kind, session_id: "exact-a" } });
    await render();
    expect(container.querySelector("[data-terminal-magnifier-destination=history]")?.getAttribute("aria-label")).toBe(terminalTurnStrings.openPanel);
    expect(mocks.mappings).toHaveBeenCalledWith(["pty-a"]);
  });

  it.each([{}, { "pty-a": { agent_kind: "claude", session_id: "" } },
    { "pty-a": { agent_kind: "shell", session_id: "foreign-a" } }])("routes the magnifier to terminal search without an exact mapping: %j", async (mappings) => {
    mocks.mappings.mockResolvedValue(mappings);
    await render();
    expect(container.querySelector("button[data-terminal-magnifier-destination=history]")).toBeNull();
    expect(container.querySelector("[data-terminal-magnifier]")?.getAttribute("data-terminal-magnifier-destination")).toBe("terminal");
  });

  it.each(["agent-wheel","legacy"] as const)("opens and closes the empty history while live output keeps the same mounted terminal (%s)", async mode => {
    useSettingsStore.setState({conversationHistoryMode:mode});
    await render();
    const live = container.querySelector("[data-live-terminal]");
    await clickEntry();
    expect(container.querySelector("[data-terminal-transcript-panel]")).not.toBeNull();
    expect(mocks.hold).toHaveBeenCalledWith("pty-a");
    expect(container.querySelector("[data-dashboard-chat-empty]")).not.toBeNull();
    await render(<Harness tick={2} />);
    expect(container.querySelector("[data-live-terminal]")).toBe(live);
    expect(live?.textContent).toContain("live output 2");
    await act(async () => { container.querySelector<HTMLButtonElement>(".terminal-transcript-panel__close")!.click(); });
    expect(container.querySelector("[data-terminal-transcript-panel]")).toBeNull();
    expect(mocks.mounted).toHaveBeenCalledTimes(1);
    expect(mocks.unmounted).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(focusController.request).toHaveBeenLastCalledWith("programmatic", { sessionId: "pty-a", focus: false });
  });

  it("focuses the reader and consumes Escape before terminal/global handlers", async () => {
    await render(); await clickEntry();
    expect(document.activeElement).toBe(container.querySelector("[data-transcript-search-input]"));
    const terminalKey = vi.fn();
    container.addEventListener("keydown", terminalKey);
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => { document.activeElement!.dispatchEvent(escape); });
    expect(escape.defaultPrevented).toBe(true);
    expect(terminalKey).not.toHaveBeenCalled();
    expect(container.querySelector("[data-terminal-transcript-panel]")).toBeNull();
    expect(mocks.unmounted).not.toHaveBeenCalled();
  });

  it("reads an inactive pane without changing the active terminal or triggering its activation", async () => {
    useUiStore.setState({ activePaneId: "pty-b" });
    await render(); await clickEntry();
    expect(useUiStore.getState().activePaneId).toBe("pty-b");
    expect(focusController.request).not.toHaveBeenCalled();
    await act(async () => { container.querySelector<HTMLButtonElement>(".terminal-transcript-panel__close")!.click(); });
    expect(focusController.request).toHaveBeenLastCalledWith("programmatic", { sessionId: "pty-b", focus: false });
  });

  it("returns to the last active terminal when toolbar focus has already cleared the active ID", async () => {
    await render();
    useUiStore.setState({ activePaneId: null, lastActivePaneId: "pty-a" });
    await clickEntry();
    await act(async () => container.querySelector<HTMLButtonElement>(".terminal-transcript-panel__close")!.click());
    expect(focusController.request).toHaveBeenLastCalledWith("programmatic", { sessionId: "pty-a", focus: false });
  });

  it("flag off routes the magnifier to terminal search and performs no mapping reads or history holds", async () => {
    useSettingsStore.setState({ showTerminalHistoryButton: false });
    await render();
    await act(async () => { requestHistory("pty-a"); await vi.advanceTimersByTimeAsync(10_000); });
    expect(container.querySelector("[data-terminal-magnifier-destination=history]")).toBeNull();
    expect(container.querySelector("[data-terminal-history-unavailable]")).toBeNull();
    expect(container.querySelector("[data-terminal-transcript-panel]")).toBeNull();
    expect(mocks.mappings).not.toHaveBeenCalled();
    expect(mocks.hold).not.toHaveBeenCalled();
  });

  it("setting UI routes the magnifier immediately and cancels its polling", async () => {
    await render(<><Harness /><NotificationsLayoutTab /></>);
    const label = [...container.querySelectorAll("label")].find((node) => node.textContent?.includes(notificationSettingsStrings.terminalHistoryLabel))!;
    await act(async () => { label.querySelector<HTMLInputElement>("input")!.click(); });
    expect(useSettingsStore.getState().showTerminalHistoryButton).toBe(false);
    expect(container.querySelector("[data-terminal-magnifier-destination=history]")).toBeNull();
    const reads = mocks.mappings.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(HISTORY_MAPPING_POLL_MS * 2); });
    expect(mocks.mappings).toHaveBeenCalledTimes(reads);
  });

  it("revalidates a removed mapping at the click and never opens another conversation", async () => {
    await render(); mocks.mappings.mockResolvedValue({});
    await clickEntry();
    expect(container.querySelector("[data-terminal-transcript-panel]")).toBeNull();
    expect(mocks.hold).not.toHaveBeenCalled();
  });

  it("updates availability after a fresh conversation gets its mapping", async () => {
    mocks.mappings.mockResolvedValueOnce({});
    await render();
    expect(container.querySelector("[data-terminal-magnifier-destination=history]")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(HISTORY_MAPPING_POLL_MS); });
    expect(container.querySelector("[data-terminal-magnifier-destination=history]")).not.toBeNull();
  });

  it("ignores other sessions and an old session's delayed mapping response", async () => {
    await render();
    const reads = mocks.mappings.mock.calls.length;
    await act(async () => { requestHistory("pty-b"); });
    expect(mocks.mappings).toHaveBeenCalledTimes(reads);
    let resolve!: (value: object) => void;
    mocks.mappings.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await act(async () => { requestHistory("pty-a"); });
    await render(<Harness sessionId="pty-b" />);
    await act(async () => { resolve({ "pty-a": { agent_kind: "claude", session_id: "exact-a" } }); });
    expect(container.querySelector("[data-terminal-transcript-panel]")).toBeNull();
  });

  it("does not poll hidden or non-terminal entries and releases timers on unmount", async () => {
    await render(<TerminalHistoryEntry sessionId="pty-a" visible={false} />);
    await render(<TerminalHistoryEntry sessionId={null} />);
    expect(mocks.mappings).not.toHaveBeenCalled();
    await render(<TerminalHistoryEntry sessionId="pty-a" />);
    expect(vi.getTimerCount()).toBe(1);
    await render(<div />);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the existing wrapper panel with a sibling terminal container", () => {
    const source = readFileSync("src/components/terminal/XTermWrapper.tsx", "utf8");
    expect(source).toContain("useTerminalHistoryPanel(sessionId, historyVisible)");
    const panel = source.indexOf("{transcriptPanelOpen && (");
    expect(panel).toBeGreaterThan(0);
    expect(source.slice(panel)).toContain("ref={containerRef}");
    expect(source.slice(panel, source.indexOf("{isSearchOpen && (", panel))).not.toContain("createSession");
  });
});
it.each(["revision", "focus"])("does not refocus an older terminal after a newer %s decision", async decision => {
  await render(); await clickEntry(); const button = container.querySelector<HTMLButtonElement>(".terminal-transcript-panel__close")!;
  vi.mocked(focusController.request).mockClear();
  const outside = document.createElement("button"); container.append(outside);
  if (decision === "revision") useUiStore.getState().bumpFocusRevision(); else outside.focus();
  await act(async () => button.click()); expect(focusController.request).not.toHaveBeenCalled();
  if (decision === "focus") expect(document.activeElement).toBe(outside);
});
