/**
 * The dashboard's copy of what each Web pane is showing.
 *
 * Every other chat column is fed by livebrief, which only knows PTY sessions.
 * A Web tab is read straight from its webview instead (`webpane_read`), so this
 * store is that read: one entry per tab, refreshed while the column is open.
 *
 * A read only works while the pane's webview exists -- a tab that has never
 * been opened has none, and the entry then says so rather than showing an empty
 * conversation.
 */
import { create } from "zustand";

import type { SemanticEventEnvelope } from "../lib/livebrief";
import { mergeWebPaneTurns } from "../lib/webPaneTranscript";
import { readWebPane } from "../components/workspace/webPaneApi";

/** How often an open Web column re-reads its pane. */
export const WEB_PANE_TRANSCRIPT_POLL_MS = 4_000;

export interface WebPaneTranscriptEntry {
  events: SemanticEventEnvelope[];
  /** When the last successful read landed; null until one does. */
  fetchedAt: number | null;
  /** Why the last read failed, in the user's language. Null while it works. */
  error: string | null;
  loading: boolean;
  url: string;
  title: string;
  signedOut: boolean;
  /** The page is mid-answer, so the tail turn is still growing. */
  generating: boolean;
  /** The reader hit its character budget and dropped the oldest turns. */
  truncated: boolean;
}

const EMPTY_ENTRY: WebPaneTranscriptEntry = {
  events: [],
  fetchedAt: null,
  error: null,
  loading: false,
  url: "",
  title: "",
  signedOut: false,
  generating: false,
  truncated: false,
};

interface WebPaneTranscriptState {
  byTab: Record<string, WebPaneTranscriptEntry>;
  /**
   * Tabs the dashboard is currently reading. WebPaneController parks these
   * rather than hiding them: a hidden WebView2 pauses the page, and a paused
   * page stops updating the DOM the reader walks.
   */
  readingTabIds: readonly string[];
  refresh: (tabId: string) => Promise<void>;
  dropExcept: (keep: ReadonlySet<string>) => void;
  reset: () => void;
}

/**
 * The pane cannot be read before it exists. Saying "open the tab once" is the
 * actionable half of that; the raw Rust string is kept for the title attribute.
 */
function readFailureMessage(error: unknown): string {
  const text = String(error);
  // The Rust wording is the contract here: webpane.rs::command_webview says
  // "web pane does not exist" for a tab whose webview was never built.
  if (text.includes("web pane does not exist")) {
    return "このタブのページをまだ開いていないため読めません";
  }
  if (text.includes("has no reader")) return "このページは会話の読み取りに対応していません";
  if (text.includes("timed out")) return "ページの読み取りが時間内に終わりませんでした";
  if (text.includes("primary app webview") || text.includes("another window")) {
    return "別ウィンドウのダッシュボードからは読めません";
  }
  if (text.includes("host changed")) return "ページが別のサイトに移動しているため読めません";
  return `ページを読めませんでした: ${text}`;
}

export const useWebPaneTranscriptStore = create<WebPaneTranscriptState>((set, get) => ({
  byTab: {},
  readingTabIds: [],
  refresh: async (tabId) => {
    const current = get().byTab[tabId] ?? EMPTY_ENTRY;
    // One read per tab at a time: the Rust side serialises reads behind a lock,
    // so stacking them up only delays the answer everyone is waiting for.
    if (current.loading) return;
    set((state) => ({ byTab: { ...state.byTab, [tabId]: { ...current, loading: true } } }));
    try {
      const result = await readWebPane(tabId);
      const now = Date.now();
      set((state) => {
        const previous = state.byTab[tabId] ?? EMPTY_ENTRY;
        return {
          byTab: {
            ...state.byTab,
            [tabId]: {
              events: mergeWebPaneTurns(previous.events, result.turns, tabId, now),
              fetchedAt: now,
              error: null,
              loading: false,
              url: result.url,
              title: result.title,
              signedOut: result.signedOut,
              generating: result.generating,
              truncated: result.truncated,
            },
          },
        };
      });
    } catch (error) {
      set((state) => {
        const previous = state.byTab[tabId] ?? EMPTY_ENTRY;
        // The turns already read stay on screen: a failed poll is a stale
        // column, not an emptied one.
        return {
          byTab: { ...state.byTab, [tabId]: { ...previous, loading: false, error: readFailureMessage(error) } },
        };
      });
    }
  },
  dropExcept: (keep) => set((state) => {
    const stale = Object.keys(state.byTab).filter((tabId) => !keep.has(tabId));
    if (!stale.length) return state;
    const byTab = { ...state.byTab };
    for (const tabId of stale) delete byTab[tabId];
    return { byTab };
  }),
  reset: () => set({ byTab: {}, readingTabIds: [] }),
}));

export function webPaneTranscriptEntry(
  byTab: Record<string, WebPaneTranscriptEntry>,
  tabId: string,
): WebPaneTranscriptEntry {
  return byTab[tabId] ?? EMPTY_ENTRY;
}

let timer: number | undefined;
let polledTabIds: string[] = [];

function pollOnce(): void {
  const { refresh } = useWebPaneTranscriptStore.getState();
  for (const tabId of polledTabIds) void refresh(tabId);
}

/**
 * Keep the open Web columns fresh. Called with the full set every time it
 * changes; passing an empty list stops the timer.
 */
export function syncWebPaneTranscripts(tabIds: readonly string[]): void {
  const next = [...tabIds];
  const changed = next.join(",") !== polledTabIds.join(",");
  polledTabIds = next;
  if (!next.length) {
    stopWebPaneTranscriptPolling();
    useWebPaneTranscriptStore.setState({ readingTabIds: [] });
    useWebPaneTranscriptStore.getState().dropExcept(new Set());
    return;
  }
  if (changed) useWebPaneTranscriptStore.setState({ readingTabIds: next });
  useWebPaneTranscriptStore.getState().dropExcept(new Set(next));
  if (changed) pollOnce();
  if (timer === undefined) {
    timer = window.setInterval(pollOnce, WEB_PANE_TRANSCRIPT_POLL_MS);
  }
}

export function stopWebPaneTranscriptPolling(): void {
  if (timer !== undefined) {
    window.clearInterval(timer);
    timer = undefined;
  }
  polledTabIds = [];
  if (useWebPaneTranscriptStore.getState().readingTabIds.length) {
    useWebPaneTranscriptStore.setState({ readingTabIds: [] });
  }
}
