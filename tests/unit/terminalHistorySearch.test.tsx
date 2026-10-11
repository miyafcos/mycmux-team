// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
import { archiveCacheStats } from "../../src/stores/transcriptHistoryStore";
import type { ArchiveItem, TranscriptPage } from "../../src/lib/livebrief";
import { normalizeTranscriptQuery, TRANSCRIPT_SEARCH_LIMIT } from "../../src/stores/transcriptSearchStore";
import { TranscriptHistoryReader } from "../../src/stores/transcriptHistoryStore";

let root: Root, host: HTMLDivElement;
let mapped = true, kind = "claude", total = 240;
let pageFailure = false;
let pageBusy = false;
let delayed: (() => void)[] = [];
let delayPage = false;
let fixtureSequence = 0, conversation = "";
const fences = new Map<string, number>();
const leakedKeys = vi.fn();
function releasePages() { for (const release of delayed.splice(0)) release(); }
function page(end: number, fence = total, source = conversation): TranscriptPage {
  const start = Math.max(0, end - 100);
  return { readerId: `synthetic-reader:${source}`, sourceGeneration: "g", snapshotEnd: String(fence * 100),
    items: Array.from({ length: end - start }, (_, offset): ArchiveItem => {
      const n = start + offset;
      return { occurrenceId: `claude:${source}:g:${n * 100}:0`, sourceStart: String(n * 100), sourceEnd: String(n * 100 + 100), slot: 0,
        kind: n === 220 ? "toolResult" : n === 201 ? "question" : n % 2 ? "assistant" : "user", timestamp: null,
        text: n === 1 || n === 201 || n === 220 ? `猫の発言 ${n}` : `説明 ${n}`, bodyRef: n === 230 ? "long-body" : null,
        callId: null, tool: null, target: null, aliases: [] };
    }), olderCursor: start ? `older:${start}:${fence}` : null, newerCursor: `newer:${end}:${fence}`, latestCursor: `latest:${fence}:${fence}`,
    scanContinuation: null, reachedStart: start === 0, reachedFence: end === fence, diagnostics: [] };
}
function Harness({ sessionId = "pty", visible = true }: { sessionId?: string; visible?: boolean }) {
  const panel = useTerminalHistoryPanel(sessionId, visible);
  return <div data-terminal-parent onKeyDown={leakedKeys}>
    <TerminalHistoryEntry sessionId={sessionId} visible={visible} />
    <div data-live-terminal />
    {panel.transcriptPanelOpen && <TerminalTranscriptPanel sessionId={sessionId} tabId="tab" agentKind={kind} visible={visible} focusRequest={panel.transcriptPanelFocusRequest} onClose={panel.closeTranscriptPanel} />}
  </div>;
}
async function render(sessionId = "pty", visible = true) { await act(async () => root.render(<Harness sessionId={sessionId} visible={visible} />)); }
async function advance(ms = 1_000) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function open() {
  await render();
  await act(async () => host.querySelector<HTMLButtonElement>("[data-terminal-magnifier]")?.click());
  await advance(20);
}
function input() { return host.querySelector<HTMLInputElement>("[data-transcript-search-input]")!; }
async function type(query: string) {
  const node = input(); expect(node).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, query);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function button(label: string) {
  const node = [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === label);
  const enabled = !!node && !node.disabled;
  if (enabled) await act(async () => node.click());
  return enabled;
}
const status = () => host.querySelector("[data-transcript-search-status]")?.textContent ?? "";
const mutationCalls = () => core.invoke.mock.calls.filter(([command]) => /^(create_session|resize_session|write_to_session|kill_session|.*owner.*)$/.test(command));
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] }); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  conversation = `synthetic-${++fixtureSequence}`;
  fences.clear();
  mapped = true; kind = "claude"; total = 240; pageFailure = false; pageBusy = false; delayPage = false; delayed = []; leakedKeys.mockClear();
  core.invoke.mockReset();
  core.invoke.mockImplementation(async (command: string, args: any) => {
    if (command === "read_agent_session_mappings") return mapped ? Object.fromEntries(args.sessionIds.map((id: string) => [id, { agent_kind: kind, session_id: conversation }])) : {};
    if (command === "open_transcript_history") { const reply = page(total, total, args.request.expectedAgentSessionId); fences.set(reply.readerId, total); return reply; }
    if (command === "read_transcript_history_page") {
      if (pageFailure) throw new Error("permissionDenied");
      if (pageBusy) throw new Error("readerBusy");
      const parts = args.request.cursor.split(":");
      const reply = page(Number(parts[1]), Number(parts[2]), args.request.readerId.slice("synthetic-reader:".length));
      if (delayPage) await new Promise<void>(resolve => { delayed.push(resolve); });
      return reply;
    }
    if (command === "refresh_transcript_history_tail") {
      const source = args.readerId.slice("synthetic-reader:".length);
      const fence = source === conversation ? total : fences.get(args.readerId)!;
      const after = Number(args.afterCursor.split(":")[1]);
      const reply = page(Math.min(fence, after + 100), fence, source);
      fences.set(args.readerId, fence);
      return { ...reply, latestCursor: `latest:${fence}:${fence}`, items: reply.items.filter(item => BigInt(item.sourceStart) >= BigInt(after * 100)) };
    }
    if (command === "heartbeat_transcript_history") return { hasNewBytes: args.readerId === `synthetic-reader:${conversation}` && total > (fences.get(args.readerId) ?? total) };
    if (command === "plugin:event|listen") return 1;
    if (command === "get_live_events" || command === "get_live_briefs" || command === "get_live_read_observations") return [];
    return null;
  });
  useSettingsStore.setState({ showTerminalHistoryButton: true, conversationHistoryMode: "agent-wheel" });
  useUiStore.setState({ activePaneId: "pty" });
  useDashboardViewStore.setState({ open: false, userTurnRequests: {} });
  useLiveBriefStore.getState().reset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  delayPage = false; releasePages();
  await act(async () => root.unmount());
  await vi.advanceTimersByTimeAsync(10);
  host.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
});
describe("L29 history search regressions through the real panel and reader", () => {
  it("replaces the text/book entry with one magnifier and focuses the search bar", async () => {
    await open();
    expect(host.querySelectorAll("[data-terminal-magnifier]")).toHaveLength(1);
    expect(host.querySelector("[data-terminal-history-entry]")).toBeNull();
    expect(input()).not.toBeNull(); expect(document.activeElement).toBe(input());
    expect(host.textContent).toContain("長い本文の続きは対象外");
    expect(mutationCalls()).toHaveLength(0);
  });
  it("counts matching utterances across older pages, excludes tools, and navigates", async () => {
    await open(); await type("猫"); await advance();
    expect(status()).toContain("全 2 件"); expect(status()).toContain("最初まで検索しました");
    await button("次へ"); await advance();
    expect(host.querySelector("[data-transcript-search-active]")?.textContent).toContain("猫の発言");
    expect(mutationCalls()).toHaveLength(0);
  });
  it("holds Japanese composition and its confirming Enter inside the search bar", async () => {
    await open();
    await act(async () => input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    await type("猫"); await advance();
    expect(status()).not.toContain("全 2 件");
    await act(async () => input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true })));
    expect(host.querySelector("[data-transcript-search-active]")).toBeNull();
    await act(async () => input().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
    await advance(); expect(status()).toContain("全 2 件");
    expect(mutationCalls()).toHaveLength(0);
  });
  it("reports a failed older page honestly instead of asserting a complete count", async () => {
    await open(); pageFailure = true; await type("猫"); await advance();
    expect(status()).toContain("ここまでで"); expect(status()).not.toContain("全 "); expect(status()).toContain("読み取れ");
  });
  it("discards delayed results after changing the query and after stopping", async () => {
    await open(); delayPage = true; await type("猫"); await advance(300);
    await type("ありません"); delayPage = false; await act(async () => releasePages()); await advance();
    expect(status()).not.toContain("全 2 件");
    await type("猫"); await advance(190); await button("止める"); await advance();
    expect(status()).not.toContain("全 2 件");
    expect(mutationCalls()).toHaveLength(0);
  });
  it("keeps the magnifier as terminal search for off, unmapped, shell, and Grok panes", async () => {
    for (const choice of ["off", "unmapped", "shell", "grok"]) {
      useSettingsStore.setState({ showTerminalHistoryButton: choice !== "off" });
      mapped = choice !== "unmapped"; kind = choice === "shell" || choice === "grok" ? choice : "claude";
      await render();
      const search = vi.fn(); window.addEventListener("mycmux:terminal-search", search);
      await act(async () => host.querySelector<HTMLButtonElement>("[data-terminal-magnifier]")?.click());
      expect(search).toHaveBeenCalledOnce(); window.removeEventListener("mycmux:terminal-search", search);
      expect(host.querySelector("[data-terminal-transcript-panel]")).toBeNull();
    }
    expect(archiveCacheStats().bytes).toBe(0); expect(mutationCalls()).toHaveLength(0);
  });
  it("normalizes Japanese width, Latin case, and whitespace without fuzzy matching", () => {
    expect(normalizeTranscriptQuery(" ＡＢＣ　ﾈｺ\n\t 猫 ")).toBe("abc ネコ 猫");
    expect(normalizeTranscriptQuery("ねこ")).not.toBe(normalizeTranscriptQuery("ネコ"));
  });
  it("caps result locations and exposes a lower bound", async () => {
    total = 2_000; await open(); await type("説明"); await advance(1_500);
    expect(status()).toContain(`${TRANSCRIPT_SEARCH_LIMIT.toLocaleString("ja-JP")} 件以上`);
    expect(status()).not.toContain("全 ");
    expect(core.invoke.mock.calls.filter(([command]) => command === "read_transcript_history_body")).toHaveLength(0);
    expect(archiveCacheStats().bytes).toBeLessThanOrEqual(12 * 1024 * 1024);
  });
  it("restores the same conversation's query after close and clears it on rollover", async () => {
    await open(); await type("猫"); await advance();
    await button("×"); await open(); expect(input().value).toBe("猫");
    conversation = `synthetic-rollover-${++fixtureSequence}`;
    await advance(3_100);
    await button("現在の会話を開く"); await advance();
    expect(input().value).toBe(""); expect(host.querySelector("[data-transcript-search-active]")).toBeNull();
  });
  it("leaves legacy ordinary reading intact and searches full archive when asked", async () => {
    useSettingsStore.setState({ conversationHistoryMode: "legacy" });
    await open(); expect(host.querySelector("[data-archive-view]")).toBeNull();
    await type("猫"); await advance(); expect(status()).toContain("全 2 件");
    await type(""); expect(host.querySelector("[data-archive-view]")).toBeNull();
  });
  it("keeps the search snapshot stable when new records arrive and samples them on restart", async () => {
    await open(); await type("説明"); await advance(205);
    total += 20; await advance(1_600);
    expect(status()).toContain("全 237 件"); expect(host.textContent).toContain("新しい記録は、もう一度検索すると探せます");
    await button("もう一度検索"); await advance(1_000);
    expect(status()).toContain("全 257 件");
  });
  it("discards a delayed navigation page before installing it after abort", async () => {
    const reader = new TranscriptHistoryReader({ ptySessionId: "guard", tabId: "guard", expectedAgentKind: "claude", expectedAgentSessionId: conversation });
    await advance(10);
    const before = reader.snapshot.items.map(item => item.occurrenceId);
    const abort = new AbortController(); delayPage = true;
    const pending = reader.find(item => item.text.includes("猫の発言 1"), { signal: abort.signal });
    await advance(10); abort.abort(); expect(reader.snapshot.notice).toBeNull(); delayPage = false; releasePages(); await advance(10);
    expect(await pending).toBeNull(); expect(reader.snapshot.items.map(item => item.occurrenceId)).toEqual(before);
    reader.dispose();
  });
  it("wraps search controls beneath a full-width input at normal and narrow widths", async () => {
    const css = readFileSync("src/global.css", "utf8");
    const style = document.createElement("style");
    style.textContent = css.slice(css.indexOf(".terminal-transcript-panel__head {"), css.indexOf(".cmux-archive-transcript {"));
    document.head.append(style);
    try {
      await open();
      for (const [width, height] of [[1440, 900], [240, 900]]) {
        host.style.width = `${width}px`; host.style.height = `${height}px`;
        const bar = host.querySelector<HTMLElement>("[data-transcript-search]")!;
        const controls = bar.querySelector<HTMLElement>(".terminal-transcript-search__controls")!;
        expect(getComputedStyle(bar).flexDirection).toBe("column");
        expect(getComputedStyle(controls).flexWrap).toBe("wrap");
        expect(getComputedStyle(input()).width).toBe("100%");
        expect(getComputedStyle(input()).minWidth).toBe("0px");
        expect(bar.parentElement?.querySelector(".terminal-transcript-panel__body")).not.toBeNull();
      }
      expect(style.textContent).toContain("font-size: var(--cmux-font-size-xs)");
      expect(style.textContent).not.toMatch(/font-size:\s*(?:9|10)px/);
    } finally { style.remove(); }
  });
});

const events = ["open", "close", "type", "change", "compose", "confirm", "next", "previous", "stop", "append", "delay", "release", "fail", "busy", "pane", "source", "setting", "hidden", "settle"] as const;
type TraceEvent = typeof events[number];
const traces: TraceEvent[][] = Array.from({ length: 108 }, (_, index) => {
  let seed = 0x29c0de ^ (index + 1);
  const trace: TraceEvent[] = ["open", "type", events[index % events.length]];
  while (trace.length < 5 + index % 3) { seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0; trace.push(events[seed % events.length]); }
  return trace;
});
let generatedWallNs = 0n;
const eventCounts: Record<string, number> = {};
const executedCounts: Record<string, number> = {}, noOpCounts: Record<string, number> = {};
describe("generated 5–7-event traces with only the Tauri core boundary mocked", () => {
  it.each(traces.map((trace, index) => ({ trace, index })))("trace $index: $trace", async ({ trace }) => {
    const started = process.hrtime.bigint();
    let sessionId = "pty", visible = true;
    for (const event of trace) {
      eventCounts[event] = (eventCounts[event] ?? 0) + 1;
      let executed = true;
      const previousInput = input();
      const oldGeneration = Number(host.querySelector("[data-transcript-search-generation]")?.getAttribute("data-transcript-search-generation") ?? 0);
      switch (event) {
        case "open": executed = visible && !input(); await render(sessionId, visible); await act(async () => host.querySelector<HTMLButtonElement>("[data-terminal-magnifier]")?.click()); break;
        case "close": executed = await button("×"); break;
        case "type": executed = !!input() && input().value !== "猫"; if (input()) await type("猫"); break;
        case "change": executed = !!input() && input().value !== "ありません"; if (input()) await type("ありません"); break;
        case "compose":
          executed = !!input();
          if (input()) {
            await act(async () => input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
            await type("猫");
            await act(async () => input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true })));
            expect(host.querySelector("[data-transcript-search-active]")).toBeNull();
          }
          break;
        case "confirm":
          executed = !!input();
          if (input()) await act(async () => {
            input().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
            input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
          });
          break;
        case "next": executed = await button("次へ"); break;
        case "previous": executed = await button("前へ"); break;
        case "stop": executed = await button("止める"); break;
        case "append": total += 20; break;
        case "delay": executed = !delayPage; delayPage = true; break;
        case "release": executed = delayPage || pageBusy || delayed.length > 0; delayPage = false; pageBusy = false; await act(async () => releasePages()); break;
        case "fail": executed = !pageFailure; pageFailure = true; break;
        case "busy": executed = !pageBusy; pageBusy = true; break;
        case "pane": sessionId = sessionId === "pty" ? "other-pty" : "pty"; await act(async () => useUiStore.setState({ activePaneId: sessionId })); await render(sessionId, visible); break;
        case "source": conversation = `synthetic-next-${++fixtureSequence}`; await advance(3_100); await button("現在の会話を開く"); break;
        case "setting": await act(async () => useSettingsStore.setState({ showTerminalHistoryButton: !useSettingsStore.getState().showTerminalHistoryButton })); break;
        case "hidden": visible = !visible; await render(sessionId, visible); break;
        case "settle": await advance(1_500); break;
      }
      const counts = executed ? executedCounts : noOpCounts;
      counts[event] = (counts[event] ?? 0) + 1;
      await advance(event === "type" || event === "change" ? 200 : 25);
      // HINV1/HINV2: no PTY/owner command and no key reached the terminal ancestor.
      expect(mutationCalls(), trace.join(",")).toHaveLength(0); expect(leakedKeys).not.toHaveBeenCalled();
      // HINV3: generations never go backwards; replaced/no-match queries cannot retain a selected cat row.
      const bar = host.querySelector("[data-transcript-search]");
      if (bar && !["open", "pane"].includes(event)) expect(Number(bar.getAttribute("data-transcript-search-generation"))).toBeGreaterThanOrEqual(oldGeneration);
      if (executed && previousInput && input() === previousInput && ["type", "change", "compose", "confirm", "stop", "hidden"].includes(event)) expect(Number(bar?.getAttribute("data-transcript-search-generation"))).toBeGreaterThan(oldGeneration);
      if (input()?.value === "ありません") expect(host.querySelector("[data-transcript-search-active]")).toBeNull();
      // HINV4: live cache and retained source leases remain bounded even when reads are delayed.
      expect(archiveCacheStats().bytes).toBeLessThanOrEqual(12 * 1024 * 1024); expect(archiveCacheStats().connections).toBeLessThanOrEqual(2);
      // HINV5: only the actual completion state may claim an exhaustive count/no-match.
      const searchState = bar?.getAttribute("data-transcript-search-state");
      if (searchState !== "complete") expect(status()).not.toMatch(/全 \d|見つかりません/);
      if (searchState === "stopped" || searchState === "partial") expect(status()).toContain("ここまでで");
      // HINV6: toggling the stored preference updates the real magnifier's routing.
      const magnifier = host.querySelector("[data-terminal-magnifier]");
      if (magnifier) expect(magnifier.getAttribute("data-terminal-magnifier-destination")).toBe(useSettingsStore.getState().showTerminalHistoryButton ? "history" : "terminal");
    }
    delayPage = false; pageBusy = false; await act(async () => releasePages()); await advance(1_000);
    expect(mutationCalls()).toHaveLength(0); expect(leakedKeys).not.toHaveBeenCalled();
    generatedWallNs += process.hrtime.bigint() - started;
  });
});
afterEach(() => {
  const sum = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0);
  expect(sum(executedCounts) + sum(noOpCounts)).toBe(sum(eventCounts));
  if (existsSync(".dispatch")) writeFileSync(`.dispatch/${process.env.HISTORY_REVIEW_STAGE ?? "STAGE-B"}-generated.json`, JSON.stringify({ sequences: traces.length, lengths: [5, 6, 7], events: eventCounts, checkedSteps: sum(eventCounts), executedTransitions: sum(executedCounts), noOpEvents: sum(noOpCounts), executedCounts, noOpCounts, wallMs: Number(generatedWallNs / 1_000_000n) }, null, 2));
});
