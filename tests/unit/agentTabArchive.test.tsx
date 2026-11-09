// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../src/components/dashboard/useTranscriptHistory", () => ({
  useTranscriptHistory: (_descriptor: unknown, reader: unknown) => reader,
}));
import { ArchiveTranscript } from "../../src/components/dashboard/ArchiveTranscript";
import { descriptorKey, type HistoryState, type TranscriptHistoryReader } from "../../src/stores/transcriptHistoryStore";
import type { ArchiveItem, TranscriptDescriptor } from "../../src/lib/livebrief";

const descriptor: TranscriptDescriptor = { ptySessionId: "tab-archive", tabId: "tab", expectedAgentKind: "claude", expectedAgentSessionId: "agent" };
const item = (index: number, kind: ArchiveItem["kind"], extra: Partial<ArchiveItem> = {}): ArchiveItem => ({
  occurrenceId: `claude:agent:g:${index * 10}:0`, sourceStart: String(index * 10), sourceEnd: String(index * 10 + 10),
  slot: 0, kind, timestamp: null, text: `${kind} ${index}`, bodyRef: null, callId: null, tool: null, target: null, aliases: [], ...extra,
});
let root: Root, host: HTMLDivElement, state: HistoryState, beforeMutation: (() => void) | null;
let listeners: Set<() => void>, reader: TranscriptHistoryReader;
function update(patch: Partial<HistoryState>) {
  beforeMutation?.(); state = { ...state, ...patch }; listeners.forEach(listener => listener());
}
function tools() {
  return [item(0, "user"), item(1, "assistant"), ...Array.from({ length: 3 }, (_, index) => [
    item(2 + index * 2, "toolCall", { tool: "exec", target: index ? "cargo test --lib" : "cargo test", text: `command ${index}`, callId: `call-${index}` }),
    item(3 + index * 2, "toolResult", { text: `output ${index}`, callId: `call-${index}`, bodyRef: index === 1 ? "body-ref" : null }),
  ]).flat(), item(8, "assistant")];
}
async function render(patch: Partial<Parameters<typeof ArchiveTranscript>[0]> = {}) {
  await act(async () => root.render(<div className="terminal-transcript-panel--tab"><ArchiveTranscript descriptor={descriptor}
    prepared={reader} compact tabPresentation {...patch} /></div>));
}
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); listeners = new Set(); beforeMutation = null;
  state = { descriptor, status: "ready", readerId: "fixture", sourceGeneration: "g", items: tools(), pages: [],
    olderCursor: null, newerCursor: "tail", continuation: null, reachedStart: true, reachedFence: true, loading: null,
    following: true, newTail: false, error: null, notice: null, version: 0 };
  reader = {
    getSnapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    get snapshot() { return state; }, visible: true,
    setBeforeMutation: (fn: (() => void) | null) => { beforeMutation = fn; },
    setVisible: vi.fn(), setSelection: vi.fn(), cancelSearch: vi.fn(),
    setFollowing: (following: boolean) => update({ following }),
    find: vi.fn(async (predicate: (item: ArchiveItem) => boolean) => state.items.find(predicate) ?? null),
    latest: vi.fn(async () => update({ following: true, newTail: false })),
    first: vi.fn(async () => true), readBody: vi.fn(async () => ({ text: "full continuation", cursor: null, sourceText: false })),
  } as unknown as TranscriptHistoryReader;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe("archive layout confined to a tab", () => {
  it("groups consecutive calls/results once without changing dashboard compact defaults", async () => {
    await render();
    const groups = host.querySelectorAll<HTMLDetailsElement>(".agent-tab-tool-group");
    expect(groups).toHaveLength(1); expect(groups[0].open).toBe(false);
    expect(groups[0].querySelector("summary")!.textContent).toBe("ツール 3 件 · cargo test");
    expect(host.querySelectorAll("[data-archive-row]")).toHaveLength(4);
    await act(async () => { groups[0].open = true; groups[0].dispatchEvent(new Event("toggle")); });
    expect(groups[0].textContent).toContain("command 0"); expect(groups[0].textContent).toContain("output 2");
    await render({ tabPresentation: false });
    expect(host.querySelector(".agent-tab-tool-group")).toBeNull();
    expect(host.querySelectorAll("details.cmux-archive-tool")).toHaveLength(6);
    expect(host.querySelectorAll("[data-archive-row]")).toHaveLength(9);
  });
  it("shows a recorded Codex cmd when an older projection omitted its target", async () => {
    state={...state,items:[item(0,"toolCall",{tool:"exec",text:'{"cmd":"cargo test --lib","yield_time_ms":1000}'}),item(1,"toolResult")]};
    await render();
    expect(host.querySelector("summary")!.textContent).toBe("ツール 1 件 · cargo test --lib");
  });
  it("reveals a grouped member by its original occurrence and preserves body continuation", async () => {
    const target = state.items[5];
    await render({ targetEventId: target.occurrenceId, targetEventRequest: 1 });
    const group = host.querySelector<HTMLDetailsElement>(".agent-tab-tool-group")!;
    expect(group.open).toBe(true);
    expect(host.querySelector(`[data-dashboard-event="${target.occurrenceId}"]`)).not.toBeNull();
    const more = group.querySelector<HTMLButtonElement>('[aria-label="本文の続きを表示"]')!;
    await act(async () => more.click());
    expect(reader.readBody).toHaveBeenCalledWith(target, null, expect.any(AbortSignal));
    expect(host.querySelector(".cmux-archive-body")!.textContent).toContain("full continuation");
    await act(async () => { group.open = false; group.dispatchEvent(new Event("toggle")); });
    await render({ targetEventId: target.occurrenceId, targetEventRequest: 2 });
    expect(group.open).toBe(true);
  });
  it("maps a search reveal onto its group while preserving the body-only search scope", async () => {
    const target = state.items[5];
    const report = vi.fn();
    await render({ transcriptSearch: { query: "output 1", targetId: target.occurrenceId, generation: 1, navigation: 1,
      identity: descriptorKey(descriptor), snapshotEnd: "90", sourceGeneration: "g" }, onSearchNavigation: report });
    expect(host.querySelector<HTMLDetailsElement>(".agent-tab-tool-group")!.open).toBe(true);
    const active = host.querySelector<HTMLElement>('[data-transcript-search-active="true"]')!;
    expect(active.dataset.archiveRow).toBe(state.items[2].occurrenceId);
    expect(active.dataset.transcriptSearchMatch).toBeUndefined(); // Tool text is outside the existing body-only search.
    expect(report).toHaveBeenCalledWith(1, 1, false, null);
  });
  it("opens an offscreen group member without breaking virtual spacers or source identity", async () => {
    const items = Array.from({ length: 500 }, (_, index) => item(index, "assistant"));
    items[490] = item(490, "toolCall", { target: "cargo test" });
    items[491] = item(491, "toolResult");
    state = { ...state, items };
    await render({ targetEventId: items[491].occurrenceId, targetEventRequest: 1 });
    expect(host.querySelector<HTMLDetailsElement>(".agent-tab-tool-group")!.open).toBe(true);
    expect(host.querySelector(`[data-dashboard-event="${items[491].occurrenceId}"]`)).not.toBeNull();
    expect(host.querySelectorAll("[data-archive-row]").length).toBeLessThanOrEqual(120);
    const log = host.querySelector("[role=log]")!;
    expect(log.firstElementChild!.getAttribute("aria-hidden")).toBe("true");
    expect(log.lastElementChild!.getAttribute("aria-hidden")).toBe("true");
  });
  it("marks appended replies/tools for 1.5 seconds only when following the latest records", async () => {
    await render();
    expect(host.querySelector("[data-agent-tab-arrival]")).toBeNull();
    await act(async () => update({ items: [...state.items, item(9, "assistant")] }));
    expect(host.querySelector('[data-agent-tab-arrival="true"]')!.getAttribute("data-archive-row")).toBe(item(9, "assistant").occurrenceId);
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(host.querySelector("[data-agent-tab-arrival]")).toBeNull();
    await act(async () => update({ items: [...state.items, item(10, "toolCall", { target: "cargo test" })] }));
    expect(host.querySelector('[data-agent-tab-arrival="true"]')).not.toBeNull();
    await act(async () => update({ following: false }));
    const log = host.querySelector<HTMLElement>("[role=log]")!; log.scrollTop = 100;
    await act(async () => update({ items: [...state.items, item(11, "assistant")], newTail: true }));
    expect(log.scrollTop).toBe(100);
    expect(host.querySelector("[data-agent-tab-arrival]")).toBeNull();
    const latest = host.querySelector<HTMLButtonElement>(".agent-tab-new-records")!;
    expect(latest.getAttribute("aria-label")).toBe("新しい記録へ");
    expect(latest.closest("[role=log]")).toBeNull();
    await act(async () => latest.click());
    expect(reader.latest).toHaveBeenCalled();
  });
  it("suppresses arrival marks for reduced motion and for dashboard compact mode", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    await render();
    await act(async () => update({ items: [...state.items, item(9, "assistant")] }));
    expect(host.querySelector("[data-agent-tab-arrival]")).toBeNull();
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    await render({ tabPresentation: false });
    await act(async () => update({ items: [...state.items, item(10, "assistant")] }));
    expect(host.querySelector("[data-agent-tab-arrival]")).toBeNull();
  });
});
