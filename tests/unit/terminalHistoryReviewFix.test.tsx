// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, writeFileSync } from "node:fs";

const core = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(), invoke: core.invoke, transformCallback: () => 1,
}));
import { TerminalHistoryEntry } from "../../src/components/terminal/TerminalHistoryEntry";
import { useTerminalHistoryPanel } from "../../src/components/terminal/useTerminalHistoryPanel";
import { TerminalTranscriptPanel } from "../../src/components/terminal/TerminalTranscriptPanel";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useLiveBriefStore } from "../../src/stores/liveBriefStore";
import { useDashboardViewStore } from "../../src/stores/dashboardViewStore";
import { archiveCacheStats, TranscriptHistoryReader } from "../../src/stores/transcriptHistoryStore";
import { focusController } from "../../src/lib/focusController";
import type { ArchiveItem, TranscriptDescriptor, TranscriptPage } from "../../src/lib/livebrief";

const pane = "review-A", tab = "review-tab";
let root: Root, host: HTMLDivElement, sequence = 0, conversation: string;
let records: ArchiveItem[], cursorEpoch: number, mappingReads: number, rejectMapping: number;
let delayMapping: number, releaseMapping: (() => void) | null;
const sources = new Set<string>();
let prepared: TranscriptHistoryReader | undefined;
let delayEnd: number | null, delayAll: boolean;
let delayed: { release: () => void; cursor: string }[];
let cleanupFocus: () => void;
let otherKind: "terminal" | "launcher" | "browser" | "online" | "no-target" | "invisible" | "disposed", hideTerminalA: boolean;
const extraFocusCleanups: (() => void)[] = [];
const readers: TranscriptHistoryReader[] = [], terminalFocus: string[] = [], terminalSearch: string[] = [], historyEvents: string[] = [];
let leakedKeys = 0, activeReads = 0, peakReads = 0;
const summaries: { name: string; steps: string[]; executed: number; noOps: number; wallMs: number }[] = [];

function descriptor(source = conversation): TranscriptDescriptor {
  return { ptySessionId: pane, tabId: tab, expectedAgentKind: "claude", expectedAgentSessionId: source };
}
function record(n: number, text = n === 1 || n === 201 || n === 220 ? `猫の発言 ${n}` : `説明 ${n}`, kind: ArchiveItem["kind"] = n === 220 ? "toolResult" : n === 201 ? "question" : n % 2 ? "assistant" : "user"): ArchiveItem {
  return { occurrenceId: `claude:${conversation}:g:${n * 100}:0`, sourceStart: String(n * 100), sourceEnd: String((n + 1) * 100), slot: 0,
    kind, timestamp: null, text, bodyRef: null, callId: null, tool: null, target: null, aliases: [] };
}
function seed(count: number) { records = Array.from({ length: count }, (_, n) => record(n)); }
function page(end: number, fence = records.length, epoch = cursorEpoch): TranscriptPage {
  const start = Math.max(0, end - 100);
  return { readerId: `review-reader:${conversation}`, sourceGeneration: "g", snapshotEnd: String(fence * 100),
    items: records.slice(start, end), olderCursor: start ? `older:${start}:${fence}:${epoch}` : null,
    newerCursor: `newer:${end}:${fence}:${epoch}`, latestCursor: `latest:${fence}:${fence}:${epoch}`,
    scanContinuation: null, reachedStart: start === 0, reachedFence: end === fence, diagnostics: [] };
}
function makeReader() { const reader = new TranscriptHistoryReader(descriptor()); readers.push(reader); return reader; }
function release() { delayAll = false; delayEnd = null; for (const job of delayed.splice(0)) job.release(); }
function fallback(event: Event) { terminalSearch.push((event as CustomEvent).detail.sessionId); }
function historyEvent(event: Event) { historyEvents.push((event as CustomEvent).detail.sessionId); }
function Harness({ sessionId = pane, visible = true, entryVisible = visible }: { sessionId?: string; visible?: boolean; entryVisible?: boolean }) {
  const panel = useTerminalHistoryPanel(sessionId, visible);
  return <div data-history-focus-request={panel.transcriptPanelFocusRequest} onKeyDown={() => leakedKeys++}>
    <TerminalHistoryEntry sessionId={sessionId} visible={entryVisible} />
    {!panel.transcriptPanelOpen && <button data-cancel-history-opening onClick={panel.closeTranscriptPanel}>Cancel pending opening</button>}
    <div data-session-id={pane} tabIndex={-1} style={{ display: hideTerminalA ? "none" : undefined }}>
      <textarea className="xterm-helper-textarea" data-terminal-a />
    </div>
    <div data-session-id="review-B" tabIndex={-1} data-other-kind={otherKind}>
      {otherKind === "terminal" || otherKind === "invisible" ? <textarea className="xterm-helper-textarea" data-terminal-b />
        : <input data-nonterminal-b onFocus={() => useUiStore.getState().setActivePaneId("review-B")} />}
    </div>
    {panel.transcriptPanelOpen && <TerminalTranscriptPanel sessionId={sessionId} tabId={tab} agentKind="claude" archiveReader={prepared} visible={visible} focusRequest={panel.transcriptPanelFocusRequest} onClose={panel.closeTranscriptPanel} />}
  </div>;
}
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function render(sessionId = pane, visible = true, entryVisible = visible) { await act(async () => root.render(<Harness sessionId={sessionId} visible={visible} entryVisible={entryVisible} />)); }
async function click(selector: string) {
  const element = host.querySelector<HTMLButtonElement>(selector);
  expect(element, selector).not.toBeNull(); expect(element!.disabled, selector).toBe(false);
  await act(async () => element!.click());
}
async function button(text: string) {
  const element = [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === text);
  expect(element, text).toBeDefined(); expect(element!.disabled, text).toBe(false);
  await act(async () => element!.click());
}
async function open() { await render(); await click("[data-terminal-magnifier]"); await advance(20); }
const input = () => host.querySelector<HTMLInputElement>("[data-transcript-search-input]")!;
const bar = () => host.querySelector<HTMLElement>("[data-transcript-search]")!;
const status = () => host.querySelector("[data-transcript-search-status]")?.textContent ?? "";
const generation = () => Number(bar().dataset.transcriptSearchGeneration);
async function type(query: string) {
  expect(input()).not.toBeNull(); const before = generation();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), query);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(generation()).toBeGreaterThan(before);
}
// The oracle reads only fixture records and scripted inputs, never production
// match/status helpers or a result returned by the search implementation.
function oracle(query: string, sourceRecords = records, fence = sourceRecords.length * 100) {
  const normalized = query.normalize("NFKC").toLowerCase().split(/\s+/u).filter(Boolean).join(" ");
  const matches = sourceRecords.filter(item => ["user", "assistant", "question"].includes(item.kind)
    && Number(item.sourceEnd) <= fence && item.text.normalize("NFKC").toLowerCase().split(/\s+/u).filter(Boolean).join(" ").includes(normalized))
    .sort((a, b) => Number(b.sourceStart) - Number(a.sourceStart) || b.slot - a.slot);
  return { query, conversation, sourceGeneration: "g", fence, records: sourceRecords.slice(), matches };
}
function assertResult(expected: ReturnType<typeof oracle>, selected = 0) {
  expect(input().value).toBe(expected.query);
  expect(JSON.parse(bar().dataset.transcriptSearchIdentity!)).toEqual([pane, tab, "claude", expected.conversation]);
  expect(bar().dataset.transcriptSearchSnapshotEnd).toBe(String(expected.fence));
  expect(bar().dataset.transcriptSearchSourceGeneration).toBe(expected.sourceGeneration);
  expect(bar().dataset.transcriptSearchState).toBe("complete");
  expect(status()).toContain(expected.matches.length ? `全 ${expected.matches.length.toLocaleString("ja-JP")} 件` : "表示本文に見つかりません");
  expect(status()).toContain("最初まで検索しました");
  const active = host.querySelector<HTMLElement>("[data-transcript-search-active]");
  expect(active?.dataset.archiveRow ?? null).toBe(expected.matches[selected]?.occurrenceId ?? null);
  if (expected.matches.length) expect(bar().textContent).toContain(`${selected + 1}/${expected.matches.length} 件目`);
  for (const row of host.querySelectorAll<HTMLElement>("[data-transcript-search-match]")) {
    const item = expected.matches.find(item => item.occurrenceId === row.dataset.archiveRow);
    expect(item, `snapshot result ${row.dataset.archiveRow}`).toBeDefined();
    expect(Number(item!.sourceEnd)).toBeLessThanOrEqual(expected.fence);
    expect(item!.occurrenceId.startsWith(`claude:${expected.conversation}:${expected.sourceGeneration}:`)).toBe(true);
  }
  const opens = core.invoke.mock.calls.filter(([command]) => command === "open_transcript_history");
  expect(opens.some(([, args]) => args.request.expectedAgentSessionId === expected.conversation)).toBe(true);
  for (const [, args] of opens) {
    expect(sources.has(args.request.expectedAgentSessionId)).toBe(true);
    expect(args.request).toEqual(expect.objectContaining({ ptySessionId: pane, tabId: tab }));
  }
}
function registerFixtureTerminal(sessionId: string, selector: string): () => void {
  const node = host.querySelector<HTMLTextAreaElement>(selector)!;
  expect(node).not.toBeNull();
  return focusController.registerTerminal(sessionId, {
    focus: () => { terminalFocus.push(sessionId); node.focus(); },
    containsActiveElement: () => document.activeElement === node,
    isEligible: () => {
      if (!node.isConnected || document.hidden) return false;
      for (let parent: HTMLElement | null = node; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
      }
      return true;
    },
  });
}
async function trace(name: string, steps: [string, () => Promise<void>][] ) {
  expect(steps.length).toBeGreaterThanOrEqual(5); expect(steps.length).toBeLessThanOrEqual(7);
  const started = process.hrtime.bigint(), summary = { name, steps: steps.map(([name]) => name), executed: 0, noOps: 0, wallMs: 0 };
  summaries.push(summary);
  try {
    for (const [, run] of steps) {
      summary.executed++; await run();
      expect(core.invoke.mock.calls.filter(([command]) => /^(create_session|resize_session|write_to_session|kill_session|.*owner.*)$/.test(command))).toHaveLength(0);
      expect(leakedKeys).toBe(0);
      expect(archiveCacheStats().bytes).toBeLessThanOrEqual(12 * 1024 * 1024);
      for (const reader of readers) expect(reader.snapshot.pages.length).toBeLessThanOrEqual(5);
      expect(peakReads).toBeLessThanOrEqual(1);
    }
  } finally { summary.wallMs = Number(process.hrtime.bigint() - started) / 1e6; }
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  conversation = `review-synthetic-${++sequence}`; seed(240); cursorEpoch = 0; mappingReads = 0; rejectMapping = -1;
  delayMapping = -1; releaseMapping = null; sources.clear(); sources.add(conversation);
  prepared = undefined; delayEnd = null; delayAll = false; delayed = []; readers.length = 0;
  otherKind = "terminal"; hideTerminalA = false; extraFocusCleanups.length = 0;
  terminalFocus.length = 0; terminalSearch.length = 0; historyEvents.length = 0; leakedKeys = 0; activeReads = 0; peakReads = 0;
  core.invoke.mockReset();
  core.invoke.mockImplementation(async (command: string, args: any) => {
    if (command === "read_agent_session_mappings") {
      const ticket = ++mappingReads;
      if (ticket === delayMapping) await new Promise<void>(resolve => { releaseMapping = resolve; });
      if (ticket === rejectMapping) throw new Error("mapping unavailable");
      return Object.fromEntries(args.sessionIds.map((id: string) => [id, { agent_kind: "claude", session_id: conversation }]));
    }
    if (command === "open_transcript_history") return page(records.length);
    if (command === "read_transcript_history_page") {
      activeReads++; peakReads = Math.max(peakReads, activeReads);
      try {
        const [direction, end, fence, epoch] = args.request.cursor.split(":");
        const reply = page(Number(end), Number(fence), Number(epoch));
        if (delayAll || direction === "older" && Number(end) === delayEnd) await new Promise<void>(resolve => delayed.push({ release: resolve, cursor: args.request.cursor }));
        return reply;
      } finally { activeReads--; }
    }
    if (command === "refresh_transcript_history_tail") {
      const after = Number(args.afterCursor.split(":")[1]);
      // Opaque cursors may be renewed on a tail sample. Renewing them also
      // makes a delayed navigation read observable independently of cache hits.
      const reply = page(Math.min(records.length, after + 100), records.length, ++cursorEpoch);
      return { ...reply, items: reply.items.filter(item => Number(item.sourceStart) >= after * 100) };
    }
    if (command === "heartbeat_transcript_history") return { hasNewBytes: true };
    if (command === "plugin:event|listen") return 1;
    if (["get_live_events", "get_live_briefs", "get_live_read_observations"].includes(command)) return [];
    return null;
  });
  useSettingsStore.setState({ showTerminalHistoryButton: true, conversationHistoryMode: "agent-wheel" });
  useUiStore.setState({ activePaneId: pane, lastActivePaneId: pane });
  useDashboardViewStore.setState({ open: false, userTurnRequests: {} });
  useLiveBriefStore.getState().reset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  cleanupFocus = focusController.registerTerminal("review-B", {
    focus: () => { terminalFocus.push("review-B"); host.querySelector<HTMLTextAreaElement>("[data-terminal-b]")?.focus(); },
    containsActiveElement: () => document.activeElement === host.querySelector("[data-terminal-b]"),
    isEligible: () => {
      const node = host.querySelector<HTMLTextAreaElement>("[data-terminal-b]");
      return Boolean(node?.isConnected && !document.hidden && host.querySelector<HTMLElement>('[data-session-id="review-B"]')?.style.display !== "none");
    },
  });
  window.addEventListener("mycmux:terminal-search", fallback);
  window.addEventListener("mycmux:terminal-history", historyEvent);
});
afterEach(async () => {
  release(); releaseMapping?.(); await act(async () => root.unmount());
  for (const reader of readers) reader.dispose();
  await advance(20); cleanupFocus(); window.removeEventListener("mycmux:terminal-search", fallback);
  for (const cleanup of extraFocusCleanups) cleanup();
  window.removeEventListener("mycmux:terminal-history", historyEvent);
  host.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
  expect(archiveCacheStats().connections).toBe(0);
});
describe("stage E eligible terminal fallback and focus-only magnifier", () => {
  it.each(["launcher", "browser", "online", "no-target", "invisible", "disposed"].flatMap(kind =>
    [true, false].map(openingEligible => ({ kind: kind as typeof otherKind, openingEligible }))))(
    "R3 active $kind with opening terminal eligible=$openingEligible closes to a terminal input or nowhere", async ({ kind, openingEligible }) => {
      let cleanupA: () => void;
      await trace(`R3-${kind}-opening-eligible-${openingEligible}`, [
        ["show registered A and other B", async () => {
          otherKind = kind; await render(); cleanupFocus();
          cleanupA = registerFixtureTerminal(pane, "[data-terminal-a]"); extraFocusCleanups.push(cleanupA);
          if (kind === "invisible") extraFocusCleanups.push(registerFixtureTerminal("review-B", "[data-terminal-b]"));
          if (kind === "disposed") {
            const unregister = focusController.registerTerminal("review-B", { focus: () => host.querySelector<HTMLInputElement>("[data-nonterminal-b]")!.focus(), containsActiveElement: () => false });
            unregister();
          }
        }],
        ["open and search A", async () => { await click("[data-terminal-magnifier]"); await advance(20); await type("猫"); await advance(1000); assertResult(oracle("猫")); }],
        ["activate and focus B", async () => {
          await act(async () => {
            useUiStore.getState().setActivePaneId("review-B");
            host.querySelector<HTMLElement>(kind === "invisible" ? "[data-terminal-b]" : "[data-nonterminal-b]")!.focus();
          });
          expect(document.activeElement).toBe(host.querySelector(kind === "invisible" ? "[data-terminal-b]" : "[data-nonterminal-b]"));
        }],
        ["directly refocus A with ineligible B", async () => {
          await act(async () => {
            if (kind === "invisible") host.querySelector<HTMLElement>('[data-session-id="review-B"]')!.style.display = "none";
            if (!openingEligible) {
              hideTerminalA = true;
              host.querySelector<HTMLElement>(`[data-session-id="${pane}"]`)!.style.display = "none";
            }
            input().focus();
          });
          await advance(1000); assertResult(oracle("猫")); expect(useUiStore.getState().activePaneId).toBe("review-B");
        }],
        ["Next in A keeps B active", async () => { await button("次へ"); await advance(100); assertResult(oracle("猫"), 1); expect(useUiStore.getState().activePaneId).toBe("review-B"); }],
        ["ordinary Escape resolves an eligible terminal", async () => {
          const calls = terminalFocus.length;
          await act(async () => input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))); await advance(100);
          expect(input()).toBeNull();
          expect.soft(document.activeElement).toBe(openingEligible ? host.querySelector("[data-terminal-a]") : document.body);
          expect.soft(document.activeElement).not.toBe(host.querySelector('[data-session-id="review-B"]'));
          expect.soft(useUiStore.getState().activePaneId).toBe(openingEligible ? pane : "review-B");
          expect.soft(terminalFocus.length - calls).toBe(openingEligible ? 1 : 0);
          expect(terminalSearch).toHaveLength(0);
        }],
      ]);
    },
  );
  it("R3 captures an eligible opening terminal while a launcher is already active", async () => {
    await trace("R3-opening-target-eligibility", [
      ["launcher active with registered A available", async () => {
        otherKind = "launcher"; cleanupFocus(); await render();
        extraFocusCleanups.push(registerFixtureTerminal(pane, "[data-terminal-a]"));
        useUiStore.setState({ activePaneId: "review-B", lastActivePaneId: "review-B" });
      }],
      ["open inactive A", async () => { await click("[data-terminal-magnifier]"); await advance(20); expect(document.activeElement).toBe(input()); expect(useUiStore.getState().activePaneId).toBe("review-B"); }],
      ["search A", async () => { await type("猫"); await advance(1000); assertResult(oracle("猫")); }],
      ["Next keeps launcher active", async () => { await button("次へ"); await advance(100); assertResult(oracle("猫"), 1); expect(useUiStore.getState().activePaneId).toBe("review-B"); }],
      ["Escape returns to the eligible opening terminal", async () => {
        await act(async () => input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))); await advance(100);
        expect(document.activeElement).toBe(host.querySelector("[data-terminal-a]")); expect(useUiStore.getState().activePaneId).toBe(pane);
      }],
    ]);
  });
  it("HX6 refocuses an open panel with zero mapping IPC and validates again after close", async () => {
    let original: Element | null;
    await trace("HX6-focus-only-open-panel", [
      ["open A", async () => { await open(); original = host.querySelector("[data-terminal-transcript-panel]"); }],
      ["search A", async () => { await type("猫"); await advance(1000); assertResult(oracle("猫")); }],
      ["activate and focus B", async () => { await act(async () => { useUiStore.getState().setActivePaneId("review-B"); host.querySelector<HTMLTextAreaElement>("[data-terminal-b]")!.focus(); }); }],
      ["magnifier only focuses retained A", async () => {
        const reads = mappingReads; rejectMapping = reads + 1;
        await click("[data-terminal-magnifier]"); await advance(20);
        expect.soft(mappingReads - reads).toBe(0); expect.soft(terminalSearch).toHaveLength(0);
        expect.soft(host.querySelector("[data-terminal-transcript-panel]")).toBe(original!);
        expect.soft(document.activeElement).toBe(input()); expect(useUiStore.getState().activePaneId).toBe("review-B");
      }],
      ["close and start guarded opening again", async () => {
        rejectMapping = -1; await button("×"); await advance(20); const reads = mappingReads;
        delayMapping = reads + 1; await click("[data-terminal-magnifier]"); await advance(10);
        expect(mappingReads).toBe(reads + 1); expect(releaseMapping).not.toBeNull(); expect(input()).toBeNull();
        await act(async () => releaseMapping!()); await advance(20); expect(mappingReads).toBeGreaterThanOrEqual(reads + 2); expect(document.activeElement).toBe(input());
      }],
      ["fresh query keeps exact A source", async () => { await type("説明"); await advance(1000); assertResult(oracle("説明")); expect(useUiStore.getState().activePaneId).toBe("review-B"); }],
    ]);
  });
  it("HX6 preserves the eligible opening terminal when a launcher takes activation", async () => {
    await trace("HX6-preserves-opening-terminal", [
      ["register A and open", async () => {
        otherKind = "launcher"; cleanupFocus(); await render();
        extraFocusCleanups.push(registerFixtureTerminal(pane, "[data-terminal-a]"));
        await click("[data-terminal-magnifier]"); await advance(20);
      }],
      ["search A", async () => { await type("猫"); await advance(1000); assertResult(oracle("猫")); }],
      ["focus launcher B", async () => { await act(async () => host.querySelector<HTMLInputElement>("[data-nonterminal-b]")!.focus()); expect(useUiStore.getState().activePaneId).toBe("review-B"); }],
      ["refocus existing A without validation", async () => {
        const reads = mappingReads; await click("[data-terminal-magnifier]"); await advance(20);
        expect(mappingReads).toBe(reads); expect(document.activeElement).toBe(input()); expect(useUiStore.getState().activePaneId).toBe("review-B");
      }],
      ["Next still searches A", async () => { await advance(1000); await button("次へ"); await advance(100); assertResult(oracle("猫"), 1); }],
      ["Escape returns to the original terminal input", async () => {
        await act(async () => input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))); await advance(100);
        expect(document.activeElement).toBe(host.querySelector("[data-terminal-a]")); expect(useUiStore.getState().activePaneId).toBe(pane);
      }],
    ]);
  });
  it("R3 uses an eligible remembered terminal when the opening pane has no target", async () => {
    await trace("R3-remembered-terminal", [
      ["launcher active and remembered C registered", async () => {
        otherKind = "launcher"; cleanupFocus(); await render();
        const node = document.createElement("textarea"); node.dataset.terminalRemembered = "true"; host.append(node);
        extraFocusCleanups.push(registerFixtureTerminal("review-C", "[data-terminal-remembered]"));
        useUiStore.setState({ activePaneId: "review-B", lastActivePaneId: "review-C" });
      }],
      ["open A without activating it", async () => { await click("[data-terminal-magnifier]"); await advance(20); expect(useUiStore.getState().activePaneId).toBe("review-B"); }],
      ["search A", async () => { await type("猫"); await advance(1000); assertResult(oracle("猫")); }],
      ["Next keeps B active", async () => { await button("次へ"); await advance(100); assertResult(oracle("猫"), 1); expect(useUiStore.getState().activePaneId).toBe("review-B"); }],
      ["Escape returns actual focus to C", async () => {
        await act(async () => input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))); await advance(100);
        expect(document.activeElement).toBe(host.querySelector("[data-terminal-remembered]")); expect(useUiStore.getState().activePaneId).toBe("review-C");
      }],
    ]);
  });
  it.each(["hidden", "unregistered"] as const)("R3 stops scheduled focus if the selected terminal becomes %s", async cause => {
    let unregisterA: () => void, calls: number;
    await trace(`R3-scheduled-focus-${cause}`, [
      ["register A and show launcher B", async () => {
        otherKind = "launcher"; cleanupFocus(); await render();
        unregisterA = registerFixtureTerminal(pane, "[data-terminal-a]"); extraFocusCleanups.push(unregisterA);
      }],
      ["open and search A", async () => { await click("[data-terminal-magnifier]"); await advance(20); await type("猫"); await advance(1000); assertResult(oracle("猫")); }],
      ["activate and focus B", async () => { await act(async () => host.querySelector<HTMLInputElement>("[data-nonterminal-b]")!.focus()); expect(useUiStore.getState().activePaneId).toBe("review-B"); }],
      ["directly refocus and Next in A", async () => {
        await act(async () => input().focus()); await advance(1000); await button("次へ"); await advance(100);
        assertResult(oracle("猫"), 1); expect(useUiStore.getState().activePaneId).toBe("review-B");
      }],
      ["close then invalidate before the scheduled focus", async () => {
        calls = terminalFocus.length;
        await act(async () => input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
        expect(input()).toBeNull(); expect(useUiStore.getState().activePaneId).toBe(pane);
        if (cause === "hidden") host.querySelector<HTMLElement>(`[data-session-id="${pane}"]`)!.style.display = "none";
        else unregisterA!();
      }],
      ["no physical focus or container fallback", async () => {
        await advance(1000); expect(document.activeElement).toBe(document.body); expect(terminalFocus).toHaveLength(calls!); expect(terminalSearch).toHaveLength(0);
      }],
    ]);
  });
});

describe("stage D cancellation and return focus with the same-session fixture oracle", () => {
  it.each([
    { stage: 1, outcome: "success" }, { stage: 1, outcome: "rejection" },
    { stage: 2, outcome: "success" }, { stage: 2, outcome: "rejection" },
  ])("R1 stage $stage $outcome cannot route or focus after same-session close", async ({ stage, outcome }) => {
    let focusRequest: string, focusCalls: number, historyCalls: number;
    await trace(`R1-close-stage-${stage}-${outcome}`, [
      ["open A with B active", async () => { useUiStore.getState().setActivePaneId("review-B"); await open(); expect(document.activeElement).toBe(input()); }],
      ["close and delay guarded opening validation", async () => {
        await button("×"); await advance(20);
        delayMapping = mappingReads + stage; if (outcome === "rejection") rejectMapping = delayMapping;
      }],
      ["magnifier starts guarded reopening", async () => { await click("[data-terminal-magnifier]"); await advance(10); expect(releaseMapping).not.toBeNull(); expect(input()).toBeNull(); }],
      ["close the same session", async () => {
        await click("[data-cancel-history-opening]"); await advance(20);
        expect(input()).toBeNull(); expect(document.activeElement).toBe(host.querySelector("[data-terminal-b]"));
        expect(host.querySelector("[data-terminal-magnifier]")).not.toBeNull();
        focusRequest = host.querySelector<HTMLElement>("[data-history-focus-request]")!.dataset.historyFocusRequest!;
        focusCalls = terminalFocus.length; historyCalls = historyEvents.length;
      }],
      ["release canceled validation", async () => {
        await act(async () => releaseMapping!()); await advance(100);
        expect.soft(historyEvents).toHaveLength(historyCalls!);
        expect.soft(terminalSearch).toHaveLength(0);
        expect.soft(input()).toBeNull();
        expect.soft(host.querySelector<HTMLElement>("[data-history-focus-request]")!.dataset.historyFocusRequest).toBe(focusRequest!);
        expect.soft(terminalFocus).toHaveLength(focusCalls!);
        expect.soft(useUiStore.getState().activePaneId).toBe("review-B");
        expect.soft(document.activeElement).toBe(host.querySelector("[data-terminal-b]"));
      }],
    ]);
  });
  it("R2 direct focus and Next in retained A close with ordinary Escape to active B", async () => {
    const expected = oracle("猫");
    await trace("R2-direct-refocus-close-to-current-terminal", [
      ["open active A", async () => { await open(); expect(document.activeElement).toBe(input()); expect(useUiStore.getState().activePaneId).toBe(pane); }],
      ["search A", async () => { await type("猫"); await advance(1000); assertResult(expected); }],
      ["activate and focus B", async () => {
        const before = generation();
        await act(async () => { useUiStore.getState().setActivePaneId("review-B"); host.querySelector<HTMLTextAreaElement>("[data-terminal-b]")!.focus(); });
        expect(generation()).toBeGreaterThan(before); expect(document.activeElement).toBe(host.querySelector("[data-terminal-b]"));
      }],
      ["directly focus A search", async () => { await act(async () => input().focus()); await advance(1000); assertResult(expected); expect(useUiStore.getState().activePaneId).toBe("review-B"); }],
      ["Next in A", async () => { await button("次へ"); await advance(1000); assertResult(expected, 1); expect(useUiStore.getState().activePaneId).toBe("review-B"); }],
      ["ordinary Escape returns to B", async () => {
        const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
        await act(async () => input().dispatchEvent(escape)); await advance(100);
        expect(escape.defaultPrevented).toBe(true); expect(input()).toBeNull();
        expect(useUiStore.getState().activePaneId).toBe("review-B");
        expect.soft(terminalFocus).toEqual(["review-B"]);
        expect.soft(document.activeElement).toBe(host.querySelector("[data-terminal-b]"));
        expect(terminalSearch).toHaveLength(0);
      }],
    ]);
  });
  it.each([1, 2].flatMap(stage => ["success", "rejection"].flatMap(outcome =>
    ["session", "toolbar", "panel", "document", "dashboard"].map(cause => ({ stage, outcome, cause })))))(
    "R1 stage $stage $outcome stays canceled after $cause leaves and returns", async ({ stage, outcome, cause }) => {
      let focusRequest: string, focusCalls: number, historyCalls: number, existingPanel: Element | null;
      await trace(`R1-${cause}-stage-${stage}-${outcome}`, [
        ["open A and leave focus on B", async () => {
          useUiStore.getState().setActivePaneId("review-B"); await open();
          await act(async () => host.querySelector<HTMLTextAreaElement>("[data-terminal-b]")!.focus());
        }],
        ["close and delay guarded opening validation", async () => {
          await button("×"); await advance(20);
          delayMapping = mappingReads + stage; if (outcome === "rejection") rejectMapping = delayMapping;
        }],
        ["magnifier starts guarded reopening", async () => { await click("[data-terminal-magnifier]"); await advance(10); expect(releaseMapping).not.toBeNull(); expect(input()).toBeNull(); }],
        ["invalidate and restore context", async () => {
          if (cause === "session") { await render("replacement-session"); await render(); }
          if (cause === "toolbar") { await render(pane, true, false); await render(); }
          if (cause === "panel") { await render(pane, false, true); await render(); }
          if (cause === "document") await act(async () => {
            Object.defineProperty(document, "hidden", { configurable: true, value: true });
            try { document.dispatchEvent(new Event("visibilitychange")); }
            finally { Reflect.deleteProperty(document, "hidden"); document.dispatchEvent(new Event("visibilitychange")); }
          });
          if (cause === "dashboard") await act(async () => {
            useDashboardViewStore.setState({ open: true }); useDashboardViewStore.setState({ open: false });
          });
          focusRequest = host.querySelector<HTMLElement>("[data-history-focus-request]")!.dataset.historyFocusRequest!;
          focusCalls = terminalFocus.length; historyCalls = historyEvents.length;
          existingPanel = host.querySelector("[data-terminal-transcript-panel]");
          expect(document.activeElement).toBe(host.querySelector("[data-terminal-b]"));
        }],
        ["release canceled validation", async () => {
          await act(async () => releaseMapping!()); await advance(100);
          expect(historyEvents).toHaveLength(historyCalls!); expect(terminalSearch).toHaveLength(0);
          expect(host.querySelector("[data-terminal-transcript-panel]")).toBe(existingPanel!);
          expect(host.querySelector<HTMLElement>("[data-history-focus-request]")!.dataset.historyFocusRequest).toBe(focusRequest!);
          expect(terminalFocus).toHaveLength(focusCalls!); expect(useUiStore.getState().activePaneId).toBe("review-B");
          expect(document.activeElement).toBe(host.querySelector("[data-terminal-b]"));
        }],
        ["fresh click searches A with B active", async () => {
          await click("[data-terminal-magnifier]"); await advance(20); expect(document.activeElement).toBe(input());
          await type("猫"); await advance(1000); assertResult(oracle("猫")); expect(useUiStore.getState().activePaneId).toBe("review-B");
        }],
      ]);
    },
  );
});
afterAll(() => {
  if (existsSync(".dispatch")) writeFileSync(`.dispatch/${process.env.HISTORY_REVIEW_STAGE ?? "STAGE-C"}-required-sequences.json`, JSON.stringify({ traces: summaries.length, executed: summaries.reduce((n, s) => n + s.executed, 0), noOps: summaries.reduce((n, s) => n + s.noOps, 0), summaries }, null, 2));
});

describe("stage C required state-valid sequences with an independent fixture oracle", () => {
  it("F1 searches pane A while terminal B stays active and receives return focus", async () => {
    const expected = oracle("猫");
    await trace("F1-inactive-pane", [
      ["activate B", async () => { useUiStore.setState({ activePaneId: "review-B" }); await render(); }],
      ["open A", async () => { await click("[data-terminal-magnifier]"); await advance(20); expect(document.activeElement).toBe(input()); expect(useUiStore.getState().activePaneId).toBe("review-B"); expect(terminalFocus).toHaveLength(0); }],
      ["search A", async () => { await type("猫"); await advance(1000); assertResult(expected); }],
      ["next A", async () => { await button("次へ"); await advance(1000); assertResult(expected, 1); expect(useUiStore.getState().activePaneId).toBe("review-B"); }],
      ["close to B", async () => { await button("×"); await advance(20); expect(terminalFocus).toEqual(["review-B"]); expect(document.activeElement).toBe(host.querySelector("[data-terminal-b]")); }],
    ]);
  });
  it("F2 legacy search clear retype retains the same conversation", async () => {
    useSettingsStore.setState({ conversationHistoryMode: "legacy" });
    await trace("F2-legacy-clear-retype", [
      ["open legacy", async () => { await open(); expect(host.querySelector("[data-archive-view]")).toBeNull(); }],
      ["search", async () => { await type("猫"); await advance(1000); assertResult(oracle("猫")); }],
      ["clear", async () => { await type(""); expect(host.querySelector("[data-archive-view]")).toBeNull(); }],
      ["retype", async () => { await type("説明"); await advance(1000); assertResult(oracle("説明")); }],
      ["next", async () => { await button("次へ"); await advance(1000); assertResult(oracle("説明"), 1); }],
    ]);
  });
  it("a repeated magnifier click refocuses the retained panel without activating A", async () => {
    let originalPanel: Element | null;
    await trace("magnifier-refocus-retained-panel", [
      ["open with B active", async () => { useUiStore.setState({ activePaneId: "review-B" }); await open(); originalPanel = host.querySelector("[data-terminal-transcript-panel]"); }],
      ["search A", async () => { await type("猫"); await advance(1000); assertResult(oracle("猫")); }],
      ["leave to B", async () => { const before = generation(); await act(async () => host.querySelector<HTMLTextAreaElement>("[data-terminal-b]")!.focus()); expect(generation()).toBeGreaterThan(before); }],
      ["magnifier refocus", async () => { await click("[data-terminal-magnifier]"); await advance(1000); expect(host.querySelector("[data-terminal-transcript-panel]")).toBe(originalPanel!); expect(document.activeElement).toBe(input()); expect(useUiStore.getState().activePaneId).toBe("review-B"); assertResult(oracle("猫")); }],
      ["next A", async () => { await button("次へ"); await advance(1000); assertResult(oracle("猫"), 1); }],
      ["close to B", async () => { await button("×"); await advance(20); expect(terminalFocus).toEqual(["review-B"]); }],
    ]);
  });
  it("F3 Next then Previous waits after eviction and selects the exact newer occurrence", async () => {
    seed(900); records = records.map((item, n) => ({ ...item, text: n === 100 || n === 850 ? `猫 ${n}` : `説明 ${n}` }));
    const expected = oracle("猫"); prepared = makeReader();
    await trace("F3-delayed-eviction-reversal", [
      ["open real reader", async () => { await open(); }],
      ["search nine pages", async () => { await type("猫"); await advance(1000); assertResult(expected); }],
      ["delay old page", async () => { delayEnd = 200; }],
      ["next beyond five pages", async () => { await button("次へ"); await advance(500); expect(delayed).toHaveLength(1); expect(prepared!.snapshot.loading).toBe("older"); expect(prepared!.snapshot.pages).toHaveLength(5); expect(prepared!.snapshot.items.some(item => item.occurrenceId === expected.matches[0].occurrenceId)).toBe(false); }],
      ["previous during read then release", async () => { await button("前へ"); await advance(10); await act(async () => release()); await advance(1000); assertResult(expected, 0); }],
    ]);
  });
  it("F5 appended rows are not highlighted as counted snapshot results", async () => {
    seed(10); const expected = oracle("新着");
    await trace("F5-append-highlight-snapshot", [
      ["open", open],
      ["search old snapshot", async () => { await type("新着"); await advance(1000); assertResult(expected); }],
      ["append matching row", async () => { records.push(record(10, "新着の発言")); }],
      ["display latest", async () => { await button("最新へ"); await advance(50); expect(host.querySelector(`[data-archive-row="${records[10].occurrenceId}"]`)).not.toBeNull(); assertResult(expected); }],
      ["restart includes new row", async () => { await button("もう一度検索"); await advance(1000); assertResult(oracle("新着")); }],
    ]);
  });
  it("F6 second mapping rejection uses the terminal-search fallback and allows retry", async () => {
    await trace("F6-second-mapping-rejection", [
      ["initial mapping", render],
      ["reject second validation", async () => { rejectMapping = mappingReads + 2; }],
      ["click with rejection", async () => { await click("[data-terminal-magnifier]"); await advance(20); expect(terminalSearch).toEqual([pane]); expect(input()).toBeNull(); }],
      ["retry opens history", async () => { await click("[data-terminal-magnifier]"); await advance(20); expect(input()).not.toBeNull(); }],
      ["search retry", async () => { await type("猫"); await advance(1000); assertResult(oracle("猫")); }],
    ]);
  });
  it("composes then confirms without consuming the confirming Enter as Next", async () => {
    const expected = oracle("猫");
    await trace("IME-compose-confirm", [
      ["open", open],
      ["compose", async () => { const before = generation(); await act(async () => input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }))); await type("猫"); await advance(1000); expect(generation()).toBeGreaterThan(before); expect(bar().dataset.transcriptSearchState).toBe("composing"); expect(status()).not.toContain("全 "); }],
      ["confirm and post-composition Enter", async () => { const before = generation(); await act(async () => { input().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })); input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); }); expect(generation()).toBeGreaterThan(before); await advance(1000); assertResult(expected, 0); }],
      ["normal Enter", async () => { await act(async () => input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))); await advance(1000); assertResult(expected, 1); }],
      ["Shift Enter", async () => { await act(async () => input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }))); await advance(1000); assertResult(expected, 0); }],
    ]);
  });
  it("composition Escape remains an IME event and a later Escape closes to B", async () => {
    await trace("IME-compose-Escape", [
      ["open with B active", async () => { useUiStore.setState({ activePaneId: "review-B" }); await open(); }],
      ["compose", async () => { await act(async () => input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }))); await type("猫"); await advance(200); }],
      ["composition Escape", async () => { const before = generation(), node = input(); const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }); await act(async () => node.dispatchEvent(event)); expect(event.defaultPrevented).toBe(false); expect(input()).toBe(node); expect(generation()).toBe(before); expect(bar().dataset.transcriptSearchState).toBe("composing"); }],
      ["end composition", async () => { const before = generation(); await act(async () => input().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }))); expect(generation()).toBeGreaterThan(before); await advance(1000); assertResult(oracle("猫")); }],
      ["normal Escape", async () => { await act(async () => input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))); await advance(20); expect(input()).toBeNull(); expect(terminalFocus).toEqual(["review-B"]); }],
    ]);
  });
  it("leaving for active B cancels delayed A results while retaining A's panel", async () => {
    let originalPanel: Element | null, searchingGeneration: number;
    await trace("retained-panel-active-pane-change", [
      ["open A", async () => { await open(); originalPanel = host.querySelector("[data-terminal-transcript-panel]"); }],
      ["delay", async () => { delayAll = true; }],
      ["type", async () => { await type("猫"); await advance(200); searchingGeneration = generation(); expect(delayed).toHaveLength(1); }],
      ["activate and focus B", async () => { await act(async () => { useUiStore.setState({ activePaneId: "review-B" }); host.querySelector<HTMLTextAreaElement>("[data-terminal-b]")!.focus(); }); expect(host.querySelector("[data-terminal-transcript-panel]")).toBe(originalPanel!); expect(generation()).toBeGreaterThan(searchingGeneration!); expect(bar().dataset.transcriptSearchState).toBe("unavailable"); }],
      ["release obsolete A read", async () => { const before = generation(); await act(async () => release()); await advance(1000); expect(generation()).toBe(before); expect(status()).not.toMatch(/全 \d|見つかりません/); expect(host.querySelector("[data-transcript-search-active]")).toBeNull(); }],
      ["focus A again", async () => { const before = generation(); await act(async () => input().focus()); expect(generation()).toBeGreaterThan(before); await advance(1000); assertResult(oracle("猫")); expect(useUiStore.getState().activePaneId).toBe("review-B"); }],
      ["next A", async () => { await button("次へ"); await advance(1000); assertResult(oracle("猫"), 1); }],
    ]);
  });
  it("expires a real delayed search at 15 seconds and rejects its late result", async () => {
    prepared = makeReader(); let originalIds: string[], waitingGeneration: number;
    await trace("scan-deadline-expiry", [
      ["open", async () => { await open(); originalIds = prepared!.snapshot.items.map(item => item.occurrenceId); }],
      ["delay", async () => { delayAll = true; }],
      ["type", async () => { await type("猫"); await advance(200); waitingGeneration = generation(); expect(delayed).toHaveLength(1); }],
      ["expire deadline", async () => { await advance(15_001); expect(bar().dataset.transcriptSearchState).toBe("partial"); expect(status()).toContain("ここまでで 0 件"); expect(status()).toContain("待つ時間の上限"); expect(status()).not.toMatch(/全 \d|見つかりません/); expect(host.querySelector("[data-transcript-search-active]")).toBeNull(); }],
      ["release late result", async () => { await act(async () => release()); await advance(100); expect(generation()).toBe(waitingGeneration!); expect(bar().dataset.transcriptSearchState).toBe("partial"); expect(prepared!.snapshot.items.map(item => item.occurrenceId)).toEqual(originalIds!); }],
      ["replace query", async () => { await type("ありません"); await advance(1000); assertResult(oracle("ありません")); }],
    ]);
  });
  it("the navigation deadline also bounds waiting for an interrupted real read", async () => {
    seed(900); records = records.map((item, n) => ({ ...item, text: n === 100 || n === 850 ? `猫 ${n}` : `説明 ${n}` }));
    prepared = makeReader(); let beforeIds: string[];
    await trace("navigation-wait-deadline", [
      ["open", open],
      ["search", async () => { await type("猫"); await advance(1000); assertResult(oracle("猫")); }],
      ["delay old page", async () => { delayEnd = 200; }],
      ["next", async () => { await button("次へ"); await advance(500); expect(delayed).toHaveLength(1); beforeIds = prepared!.snapshot.items.map(item => item.occurrenceId); }],
      ["previous waits", async () => { await button("前へ"); await advance(10); expect(host.querySelector("[data-transcript-search-active]")).toBeNull(); }],
      ["expire deadline", async () => { await advance(15_001); expect(bar().textContent).toContain("一致した発言を表示できません"); expect(bar().textContent).not.toContain("一致した発言へ移動中"); }],
      ["release after expiry", async () => { await act(async () => release()); await advance(1000); expect(prepared!.snapshot.items.map(item => item.occurrenceId)).toEqual(beforeIds!); expect(host.querySelector("[data-transcript-search-active]")).toBeNull(); }],
    ]);
  });
  it("real ordinary reading and an instruction jump share the connection with a search", async () => {
    seed(900); prepared = makeReader(); const ordinary = makeReader(); let reading: Promise<void>;
    const expected = oracle("ありません");
    await trace("ordinary-reader-instruction-search-contention", [
      ["open consumers", open],
      ["delay ordinary page", async () => { delayEnd = 800; }],
      ["ordinary reading starts", async () => { await act(async () => { reading = ordinary.load("older", { navigate: true }); }); await advance(10); expect(ordinary.snapshot.loading).toBe("older"); expect(delayed).toHaveLength(1); }],
      ["search while ordinary reader busy", async () => { await type("ありません"); await advance(200); expect(status()).not.toMatch(/全 \d|見つかりません/); }],
      ["instruction jump while both read", async () => { await act(async () => useDashboardViewStore.getState().requestUserTurnByLabel(tab, "説明 600")); await advance(10); expect(prepared!.snapshot.loading).not.toBeNull(); expect(activeReads).toBe(1); }],
      ["release shared read", async () => { await act(async () => release()); await advance(1000); await reading!; assertResult(expected); expect(ordinary.snapshot.items.some(item => item.occurrenceId === records[750].occurrenceId)).toBe(true); expect(host.querySelector(".cmux-dashboard-user-turn-nav-label")?.textContent).toBe("説明 600"); expect(useDashboardViewStore.getState().userTurnRequests[tab]).toBeUndefined(); expect(archiveCacheStats().connections).toBe(1); expect(core.invoke.mock.calls.filter(([command]) => command === "open_transcript_history")).toHaveLength(1); }],
      ["replace query after instruction", async () => { await type("猫"); await advance(1000); assertResult(oracle("猫")); }],
    ]);
  });
  it("legacy clear and reading-mode changes never dispose a borrowed reader", async () => {
    prepared = makeReader(); useSettingsStore.setState({ conversationHistoryMode: "legacy" });
    await trace("borrowed-reader-legacy-mode", [
      ["open legacy", async () => { await open(); expect(host.querySelector("[data-archive-view]")).toBeNull(); }],
      ["search borrowed reader", async () => { await type("猫"); await advance(1000); assertResult(oracle("猫")); }],
      ["clear pauses display", async () => { await type(""); expect(prepared!.snapshot.status).toBe("ready"); expect(prepared!.visible).toBe(false); }],
      ["retype resumes binding", async () => { await type("説明"); await advance(1000); assertResult(oracle("説明")); expect(prepared!.snapshot.status).toBe("ready"); }],
      ["ordinary archive mode", async () => { await act(async () => useSettingsStore.setState({ conversationHistoryMode: "agent-wheel" })); }],
      ["clear keeps ordinary archive", async () => { await type(""); expect(host.querySelector("[data-archive-view]")).not.toBeNull(); expect(prepared!.snapshot.status).toBe("ready"); }],
      ["close retains lender ownership", async () => { await button("×"); await advance(20); expect(prepared!.snapshot.status).toBe("ready"); }],
    ]);
  });
  it("first mapping rejection uses the same terminal fallback and retry", async () => {
    await trace("first-mapping-rejection", [
      ["initial mapping", async () => { await render(); }],
      ["reject first validation", async () => { rejectMapping = mappingReads + 1; }],
      ["click with rejection", async () => { await click("[data-terminal-magnifier]"); await advance(20); expect(terminalSearch).toEqual([pane]); expect(input()).toBeNull(); }],
      ["retry opens history", async () => { await click("[data-terminal-magnifier]"); await advance(20); expect(input()).not.toBeNull(); }],
      ["search retry", async () => { await type("猫"); await advance(1000); assertResult(oracle("猫")); }],
    ]);
  });
  it.each([1, 2])("mapping stage %i rejection cannot route a replaced session", async stage => {
    await trace(`mapping-${stage}-session-cancellation`, [
      ["initial mapping", async () => { await render(); }],
      ["delay rejected validation", async () => { delayMapping = rejectMapping = mappingReads + stage; }],
      ["click pending", async () => { await click("[data-terminal-magnifier]"); await advance(10); expect(releaseMapping).not.toBeNull(); expect(input()).toBeNull(); }],
      ["replace session", async () => { await render("replacement-session"); }],
      ["release obsolete rejection", async () => { await act(async () => releaseMapping!()); await advance(20); expect(terminalSearch).toHaveLength(0); expect(input()).toBeNull(); }],
      ["return and retry", async () => { await render(); await click("[data-terminal-magnifier]"); await advance(20); }],
      ["search correct owner", async () => { await type("猫"); await advance(1000); assertResult(oracle("猫")); }],
    ]);
  });
  it("closing cancels a rejected guarded reopening request of the retained session", async () => {
    await trace("mapping-second-request-cancellation", [
      ["open", open],
      ["close and delay rejected reopening", async () => { await button("×"); await advance(20); delayMapping = rejectMapping = mappingReads + 2; }],
      ["click pending", async () => { await click("[data-terminal-magnifier]"); await advance(10); expect(releaseMapping).not.toBeNull(); }],
      ["cancel pending opening", async () => { await click("[data-cancel-history-opening]"); expect(input()).toBeNull(); }],
      ["release obsolete rejection", async () => { await act(async () => releaseMapping!()); await advance(20); expect(terminalSearch).toHaveLength(0); expect(input()).toBeNull(); }],
    ]);
  });
  it("rollover advances generation and rejects late results owned by the old conversation", async () => {
    prepared = makeReader(); let searchingGeneration: number;
    await trace("source-rollover-result-ownership", [
      ["open", open],
      ["delay", async () => { delayAll = true; }],
      ["search old conversation", async () => { await type("猫"); await advance(200); searchingGeneration = generation(); expect(delayed).toHaveLength(1); }],
      ["map new conversation", async () => { conversation = `review-rollover-${++sequence}`; sources.add(conversation); seed(10); records[7] = record(7, "猫の新しい会話"); await advance(3100); expect(generation()).toBeGreaterThan(searchingGeneration!); expect(host.querySelector("[data-transcript-search-active]")).toBeNull(); }],
      ["release old result", async () => { await act(async () => release()); await advance(100); expect(status()).not.toMatch(/全 \d|見つかりません/); expect(host.querySelector("[data-transcript-search-active]")).toBeNull(); }],
      ["open current conversation", async () => { const before = generation(); await button("現在の会話を開く"); await advance(50); expect(generation()).toBeGreaterThan(before); expect(input().value).toBe(""); }],
      ["search new owner", async () => { await type("猫"); await advance(1000); assertResult(oracle("猫")); }],
    ]);
  });
});
