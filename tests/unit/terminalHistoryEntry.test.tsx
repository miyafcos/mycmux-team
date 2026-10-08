// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mappings: vi.fn(), release: vi.fn(), hold: vi.fn(() => mocks.release),
  mounted: vi.fn(), unmounted: vi.fn(),
}));
vi.mock("../../src/lib/ipc", async (original) => ({
  ...await original<typeof import("../../src/lib/ipc")>(), readAgentSessionMappings: mocks.mappings,
}));
vi.mock("../../src/stores/liveBriefStore", async (original) => ({
  ...await original<typeof import("../../src/stores/liveBriefStore")>(), holdDetailSession: mocks.hold,
}));
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
function LiveTerminal({ tick }: { tick: number }) {
  useEffect(() => { mocks.mounted(); return () => { mocks.unmounted(); }; }, []);
  return <div data-live-terminal="true">live output {tick}</div>;
}
function Harness({ sessionId = "pty-a", tick = 0 }: { sessionId?: string; tick?: number }) {
  const { transcriptPanelOpen, closeTranscriptPanel } = useTerminalHistoryPanel(sessionId);
  return <>
    <TerminalHistoryEntry sessionId={sessionId} />
    <LiveTerminal tick={tick} />
    {transcriptPanelOpen && <TerminalTranscriptPanel sessionId={sessionId} tabId="tab-a" onClose={closeTranscriptPanel} />}
  </>;
}
async function render(node = <Harness />): Promise<void> {
  await act(async () => { root.render(node); });
}
async function clickEntry(): Promise<void> {
  await act(async () => {
    container.querySelector<HTMLButtonElement>("[data-terminal-history-entry]")?.click();
  });
}
function requestHistory(sessionId: string): void {
  window.dispatchEvent(new CustomEvent(TERMINAL_HISTORY_EVENT, { detail: { sessionId } }));
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
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
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe("persistent exact-session history entry (P1)", () => {
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
    expect(container.querySelector("[data-terminal-history-entry]")?.textContent).toBe(terminalTurnStrings.openPanel);
    expect(mocks.mappings).toHaveBeenCalledWith(["pty-a"]);
  });

  it.each([{}, { "pty-a": { agent_kind: "claude", session_id: "" } },
    { "pty-a": { agent_kind: "shell", session_id: "foreign-a" } }])("hides the button and explains a missing exact mapping: %j", async (mappings) => {
    mocks.mappings.mockResolvedValue(mappings);
    await render();
    expect(container.querySelector("button[data-terminal-history-entry]")).toBeNull();
    expect(container.querySelector("[data-terminal-history-unavailable]")?.getAttribute("title")).toBe(terminalTurnStrings.historyUnlinked);
  });

  it("opens and closes the empty history while live output keeps the same mounted terminal", async () => {
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
    expect(focusController.request).toHaveBeenLastCalledWith("programmatic", { sessionId: "pty-a" });
  });

  it("focuses the reader and consumes Escape before terminal/global handlers", async () => {
    await render(); await clickEntry();
    expect(document.activeElement).toBe(container.querySelector(".terminal-transcript-panel__close"));
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
    expect(focusController.request).toHaveBeenLastCalledWith("programmatic", { sessionId: "pty-b" });
  });

  it("flag off hides the entry and performs no mapping reads or history holds", async () => {
    useSettingsStore.setState({ showTerminalHistoryButton: false });
    await render();
    await act(async () => { requestHistory("pty-a"); await vi.advanceTimersByTimeAsync(10_000); });
    expect(container.querySelector("[data-terminal-history-entry]")).toBeNull();
    expect(container.querySelector("[data-terminal-history-unavailable]")).toBeNull();
    expect(container.querySelector("[data-terminal-transcript-panel]")).toBeNull();
    expect(mocks.mappings).not.toHaveBeenCalled();
    expect(mocks.hold).not.toHaveBeenCalled();
  });

  it("setting UI hides the entry immediately and cancels its polling", async () => {
    await render(<><Harness /><NotificationsLayoutTab /></>);
    const label = [...container.querySelectorAll("label")].find((node) => node.textContent?.includes(notificationSettingsStrings.terminalHistoryLabel))!;
    await act(async () => { label.querySelector<HTMLInputElement>("input")!.click(); });
    expect(useSettingsStore.getState().showTerminalHistoryButton).toBe(false);
    expect(container.querySelector("[data-terminal-history-entry]")).toBeNull();
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
    expect(container.querySelector("[data-terminal-history-entry]")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(HISTORY_MAPPING_POLL_MS); });
    expect(container.querySelector("[data-terminal-history-entry]")).not.toBeNull();
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
    expect(source).toContain("useTerminalHistoryPanel(sessionId)");
    const panel = source.indexOf("{transcriptPanelOpen && (");
    expect(panel).toBeGreaterThan(0);
    expect(source.slice(panel)).toContain("ref={containerRef}");
    expect(source.slice(panel, source.indexOf("{isSearchOpen && (", panel))).not.toContain("createSession");
  });
});
