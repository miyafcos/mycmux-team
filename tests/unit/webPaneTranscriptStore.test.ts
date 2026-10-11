// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

import {
  stopWebPaneTranscriptPolling,
  syncWebPaneTranscripts,
  useWebPaneTranscriptStore,
  webPaneTranscriptEntry,
  WEB_PANE_TRANSCRIPT_POLL_MS,
} from "../../src/stores/webPaneTranscriptStore";

function readResult(turns: Array<{ role: "user" | "assistant"; text: string }>, overrides: Record<string, unknown> = {}) {
  return {
    tabId: "tab-1",
    presetId: "chatgpt",
    url: "https://chatgpt.com/c/1",
    title: "ChatGPT",
    signedOut: false,
    composerPresent: true,
    generating: false,
    turns,
    lastAssistant: turns[turns.length - 1]?.text ?? "",
    lastAssistantLinks: [],
    chars: 10,
    truncated: false,
    ...overrides,
  };
}

const entry = (tabId: string) => webPaneTranscriptEntry(useWebPaneTranscriptStore.getState().byTab, tabId);

describe("web pane transcript store", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useWebPaneTranscriptStore.getState().reset();
    stopWebPaneTranscriptPolling();
  });
  afterEach(() => {
    stopWebPaneTranscriptPolling();
    vi.useRealTimers();
  });

  it("reads the pane and keeps what the page showed", async () => {
    invokeMock.mockResolvedValue(readResult([{ role: "user", text: "A" }, { role: "assistant", text: "B" }]));
    await useWebPaneTranscriptStore.getState().refresh("tab-1");
    expect(invokeMock).toHaveBeenCalledWith("webpane_read", { tabId: "tab-1" });
    const state = entry("tab-1");
    expect(state.events.map((event) => event.kind.type)).toEqual(["userMessage", "agentMessage"]);
    expect(state.fetchedAt).not.toBeNull();
    expect(state.error).toBeNull();
    expect(state.url).toBe("https://chatgpt.com/c/1");
  });

  it("says why a read failed and keeps the turns it already had", async () => {
    invokeMock.mockResolvedValueOnce(readResult([{ role: "assistant", text: "B" }]));
    await useWebPaneTranscriptStore.getState().refresh("tab-1");
    invokeMock.mockRejectedValueOnce("web pane does not exist: tab-1");
    await useWebPaneTranscriptStore.getState().refresh("tab-1");
    const state = entry("tab-1");
    expect(state.error).toBe("このタブのページをまだ開いていないため読めません");
    expect(state.events).toHaveLength(1);
    expect(state.loading).toBe(false);
  });

  it("polls only the tabs handed to it and drops the rest", async () => {
    vi.useFakeTimers();
    invokeMock.mockResolvedValue(readResult([{ role: "assistant", text: "B" }]));
    await useWebPaneTranscriptStore.getState().refresh("gone");
    expect(entry("gone").events).toHaveLength(1);

    syncWebPaneTranscripts(["tab-1"]);
    expect(entry("gone").events).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(invokeMock).toHaveBeenLastCalledWith("webpane_read", { tabId: "tab-1" });

    const callsAfterFirst = invokeMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(WEB_PANE_TRANSCRIPT_POLL_MS);
    expect(invokeMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);

    // Closing the last Web column stops the timer rather than polling forever.
    const callsBeforeStop = invokeMock.mock.calls.length;
    syncWebPaneTranscripts([]);
    await vi.advanceTimersByTimeAsync(WEB_PANE_TRANSCRIPT_POLL_MS * 3);
    expect(invokeMock.mock.calls.length).toBe(callsBeforeStop);
  });

  it("does not stack reads on a pane that has not answered yet", async () => {
    let release: (value: unknown) => void = () => {};
    invokeMock.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const first = useWebPaneTranscriptStore.getState().refresh("tab-1");
    await useWebPaneTranscriptStore.getState().refresh("tab-1");
    expect(invokeMock).toHaveBeenCalledTimes(1);
    release(readResult([{ role: "assistant", text: "B" }]));
    await first;
    expect(entry("tab-1").loading).toBe(false);
  });
});
