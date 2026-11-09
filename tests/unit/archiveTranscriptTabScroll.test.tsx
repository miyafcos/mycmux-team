// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async importOriginal => ({
  ...await importOriginal<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke,
}));
import { ArchiveTranscript } from "../../src/components/dashboard/ArchiveTranscript";
import { AgentTabOptimisticMessages } from "../../src/components/terminal/AgentTabConversationControls";
import { useComposerStore } from "../../src/stores/composerStore";
import { TranscriptHistoryReader } from "../../src/stores/transcriptHistoryStore";
import type { ArchiveItem, TranscriptDescriptor, TranscriptPage } from "../../src/lib/livebrief";

const descriptor: TranscriptDescriptor = {
  ptySessionId: "tab-scroll", tabId: "tab-scroll", expectedAgentKind: "claude", expectedAgentSessionId: "tab-scroll",
};
const item = (n: number): ArchiveItem => ({
  occurrenceId: `claude:tab-scroll:g:${n * 10}:0`, sourceStart: String(n * 10), sourceEnd: String(n * 10 + 10),
  slot: 0, kind: n % 2 ? "assistant" : "user", text: `message ${n}`, timestamp: null, bodyRef: null,
  callId: null, tool: null, target: null, aliases: [],
});
const page = (partial: boolean): TranscriptPage => ({
  readerId: "tab-scroll-reader", sourceGeneration: "g", snapshotEnd: "80",
  items: Array.from({ length: partial ? 4 : 8 }, (_, n) => item(n + (partial ? 4 : 0))),
  olderCursor: partial ? "older" : null, newerCursor: "tail-80", latestCursor: "latest",
  scanContinuation: partial ? "scan-2" : null, reachedStart: !partial, reachedFence: true, diagnostics: [],
});
let host: HTMLDivElement, root: Root, reader: TranscriptHistoryReader;
let resolvePage: (page: TranscriptPage) => void, viewport: number, tailPage: TranscriptPage | null;
const viewportHeight = () => viewport - host.querySelectorAll("[data-dashboard-optimistic-message]").length * 56;
const observers = new Set<{ targets: Set<Element>; callback: ResizeObserverCallback }>();
const isLog = (node: HTMLElement) => node.classList.contains("cmux-archive-log");
const childHeight = (node: HTMLElement): number => node.dataset.archiveRow ? 75
  : Number.parseFloat(node.style.height) || (node.classList.contains("cmux-archive-pending") ? 30 : 0);
const rect = (top: number, height: number) => ({
  top, bottom: top + height, height, left: 0, right: 600, width: 600, x: 0, y: top, toJSON() { return {}; },
});
const logNode = () => host.querySelector<HTMLElement>("[role=log]")!;
const bottomGap = () => logNode().scrollHeight - logNode().clientHeight - logNode().scrollTop;
async function resize() {
  await act(async () => {
    for (const observer of [...observers]) {
      if (observer.targets.has(logNode())) observer.callback([{ target: logNode() } as ResizeObserverEntry], {} as ResizeObserver);
    }
  });
}
async function scrollTo(top: number) {
  await act(async () => { logNode().scrollTop = top; logNode().dispatchEvent(new Event("scroll")); });
}
async function open(tabPresentation = true, visible = true, optimistic = false) {
  await act(async () => {
    reader = new TranscriptHistoryReader(descriptor);
    root.render(<div className="terminal-transcript-panel__body">
      <ArchiveTranscript descriptor={descriptor} prepared={reader} compact tabPresentation={tabPresentation} visible={visible}
        onUserMessages={messages => useComposerStore.getState().collapseDashboardOptimisticMessages("tab-scroll", messages)} />
      {optimistic ? <AgentTabOptimisticMessages sessionId="tab-scroll" events={[]} archiveEnabled /> : null}
    </div>);
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("read_transcript_history_page", { request: { readerId: "tab-scroll-reader", cursor: "scan-2", limit: 100 } }), { timeout: 5000 });
  });
}
async function finishLoading() {
  await act(async () => {
    resolvePage(page(false));
    await vi.waitFor(() => expect(reader.snapshot.loading).toBeNull(), { timeout: 5000 });
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  viewport = 200; tailPage = null; observers.clear();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  useComposerStore.setState({ dashboardOptimisticMessagesBySession: {}, dashboardRetryBySession: {} });
  vi.stubGlobal("ResizeObserver", class {
    targets = new Set<Element>();
    constructor(public callback: ResizeObserverCallback) { observers.add(this); }
    observe(target: Element) { this.targets.add(target); }
    disconnect() { observers.delete(this); }
    unobserve(target: Element) { this.targets.delete(target); }
  });
  const tops = new WeakMap<HTMLElement, number>();
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function () { return isLog(this) ? viewportHeight() : 0; });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function () {
    return isLog(this) ? Math.max(viewportHeight(), [...this.children].reduce((sum, child) => sum + childHeight(child as HTMLElement), 0)) : 0;
  });
  vi.spyOn(HTMLElement.prototype, "scrollTop", "get").mockImplementation(function () { const top = tops.get(this) ?? 0;
    return isLog(this) ? Math.max(0, Math.min(top, this.scrollHeight - this.clientHeight)) : top; });
  vi.spyOn(HTMLElement.prototype, "scrollTop", "set").mockImplementation(function (value: number) {
    tops.set(this, isLog(this) ? Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)) : value);
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
    if (isLog(this)) return rect(0, viewportHeight());
    if (this.dataset.archiveRow) {
      const parent = this.parentElement!;
      const index = [...parent.children].indexOf(this);
      return rect([...parent.children].slice(0, index).reduce((sum, child) => sum + childHeight(child as HTMLElement), 0) - parent.scrollTop, 75);
    }
    return rect(0, 0);
  });
  mocks.invoke.mockReset();
  const next = new Promise<TranscriptPage>(resolve => { resolvePage = resolve; });
  mocks.invoke.mockImplementation(async (command: string) => command === "open_transcript_history" ? page(true)
    : command === "read_transcript_history_page" ? next
      : command === "refresh_transcript_history_tail" ? tailPage ?? { ...page(false), items: [], newerCursor: "tail-80" }
        : command === "heartbeat_transcript_history" ? { hasNewBytes: false } : null);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); reader?.dispose(); host.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("tab archive startup bottom position", () => {
  it("stays at the bottom after a second page prepends rows and the log shrinks later", async () => {
    await open();
    expect(bottomGap()).toBeLessThanOrEqual(2);
    viewport -= 40; await resize();
    expect(bottomGap()).toBeLessThanOrEqual(2);
    await finishLoading();
    expect(reader.snapshot.items).toHaveLength(8);
    expect(bottomGap()).toBeLessThanOrEqual(2);
    viewport -= 72; await resize();
    expect(bottomGap()).toBeLessThanOrEqual(2);
    expect(reader.snapshot.following).toBe(true);
    expect(host.querySelector(".agent-tab-new-records")).toBeNull();
  });

  it("keeps the person's content anchor while more history loads and the viewport changes", async () => {
    await open();
    await scrollTo(40);
    const row = host.querySelector<HTMLElement>(`[data-archive-row="${item(4).occurrenceId}"]`)!;
    const offset = row.getBoundingClientRect().top;
    expect(reader.snapshot.following).toBe(false);
    viewport -= 40; await resize();
    expect(logNode().scrollTop).toBe(40);
    await finishLoading();
    expect(Math.abs(row.getBoundingClientRect().top - offset)).toBeLessThanOrEqual(2);
    const position = logNode().scrollTop;
    viewport -= 72; await resize();
    expect(logNode().scrollTop).toBe(position);
    expect(reader.snapshot.following).toBe(false);
    await act(async () => reader.markTail());
    expect(host.querySelector(".agent-tab-new-records")).not.toBeNull();
    expect(logNode().scrollTop).toBe(position);
  });

  it("keeps following through two optimistic bubbles and a pre-observer resize scroll, then renders the polled tail", async () => {
    await open(true, true, true); await finishLoading();
    // Deliver the browser's prior programmatic scroll event before the next resize.
    await scrollTo(logNode().scrollTop);
    for (const text of ["queued first", "queued second"]) {
      const position = logNode().scrollTop;
      await act(async () => useComposerStore.getState().addDashboardOptimisticMessage("tab-scroll", text));
      // Browser layout/scroll anchoring can dispatch scroll before ResizeObserver.
      await scrollTo(position);
      expect(reader.snapshot.following).toBe(true);
      expect(bottomGap()).toBeLessThanOrEqual(2);
      await resize();
    }
    expect(host.querySelectorAll("[data-dashboard-optimistic-message]")).toHaveLength(2);
    tailPage = { ...page(false), snapshotEnd: "110", olderCursor: null, newerCursor: "tail-110",
      items: [{ ...item(8), text: "queued second", timestamp: Date.now() + 100 },
        { ...item(9), kind: "toolCall", text: "ping finished", tool: "Bash" },
        { ...item(10), kind: "assistant", text: "new tail reply" }] };
    await act(async () => {
      await vi.waitFor(() => expect(reader.snapshot.items).toHaveLength(11), { timeout: 5000 });
    });
    expect(mocks.invoke).toHaveBeenCalledWith("refresh_transcript_history_tail",
      { readerId: "tab-scroll-reader", afterCursor: "tail-80" });
    expect(host.querySelector('[data-kind="user"][data-archive-row="' + item(8).occurrenceId + '"]')?.textContent).toContain("queued second");
    expect(host.querySelector('[data-kind="toolCall"]')?.textContent).toContain("Bash");
    expect(host.textContent).toContain("new tail reply");
    expect(reader.snapshot.following).toBe(true);
    expect(host.querySelectorAll("[data-dashboard-optimistic-message]")).toHaveLength(1);
    expect(bottomGap()).toBeLessThanOrEqual(2);
  });

  it.each(["wheel", "key", "thumb"])("stops following on a person's upward %s scroll even during a shrink", async method => {
    await open(true, true, true); await finishLoading();
    await scrollTo(logNode().scrollTop);
    await act(async () => {
      useComposerStore.getState().addDashboardOptimisticMessage("tab-scroll", "queued first");
      useComposerStore.getState().addDashboardOptimisticMessage("tab-scroll", "queued second");
      logNode().dispatchEvent(method === "wheel" ? new WheelEvent("wheel", { deltaY: -80, bubbles: true })
        : method === "key" ? new KeyboardEvent("keydown", { key: "PageUp", bubbles: true })
          : new MouseEvent("pointerdown", { bubbles: true }));
    });
    await scrollTo(logNode().scrollTop - 80);
    expect(reader.snapshot.following).toBe(false);
    const position = logNode().scrollTop;
    await resize();
    expect(logNode().scrollTop).toBe(position);
    expect(reader.snapshot.following).toBe(false);
    await act(async () => reader.markTail());
    expect(host.querySelector(".agent-tab-new-records")).not.toBeNull();
  });

  it("leaves dashboard resize behavior unchanged", async () => {
    await open(false); await finishLoading();
    const position = logNode().scrollTop;
    viewport -= 112; await resize();
    expect(logNode().scrollTop).toBe(position);
    expect(bottomGap()).toBe(112);
  });
});
