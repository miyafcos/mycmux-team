import { create } from "zustand";
import { dashboardStrings } from "../components/dashboard/dashboardStrings";
import type { ArtifactSourceKind } from "../types";
import { useToastStore } from "./toastStore";

export type DashboardStateFilter = "needsHuman" | "running" | "noUpdate" | "done";

export const DASHBOARD_MINIMAP_DEFAULT_WIDTH = 336;
export const DASHBOARD_MINIMAP_MIN_WIDTH = 240;
export const DASHBOARD_MINIMAP_MAX_VIEWPORT_RATIO = 0.45;
export const DASHBOARD_SESSION_LIST_WIDTH = 256;
export const DASHBOARD_SESSION_LIST_COLLAPSED_WIDTH = 32;
export const DASHBOARD_MINIMAP_RESIZER_WIDTH = 8;
export const DASHBOARD_CHAT_MIN_WIDTH = 360;
export const DASHBOARD_MINIMAP_STORAGE_KEY = "mycmux:dashboard-minimap-width";
export const DASHBOARD_SESSION_LIST_COLLAPSED_STORAGE_KEY = "mycmux:dashboard-session-list-collapsed";
export const DASHBOARD_CHAT_COLUMN_LIMIT_MIN = 1;
export const DASHBOARD_CHAT_COLUMN_LIMIT_MAX = 5;
export const DASHBOARD_CHAT_COLUMN_LIMIT_DEFAULT = 3;
export const DASHBOARD_CHAT_COLUMN_LIMIT = DASHBOARD_CHAT_COLUMN_LIMIT_DEFAULT;
export const DASHBOARD_CHAT_COLUMN_LIMIT_STORAGE_KEY = "mycmux:dashboard-chat-column-limit";
export const DASHBOARD_CHAT_COLUMN_PINS_STORAGE_KEY = "mycmux:dashboard-chat-column-pins";
export const DASHBOARD_INBOX_COLUMN_ID = "__mycmux_report_inbox__";
export const DASHBOARD_PREVIEW_COLUMN_ID = "__mycmux_preview__";

export type DashboardPreviewSource = {
  previewPath: string;
  sourcePath?: string;
  sourceKind?: ArtifactSourceKind;
};

export type DashboardPreviewColumn = {
  htmlPath: string;
  sourcePath: string;
  sourceKind: ArtifactSourceKind;
  previewPath: string;
  reloadKey: number;
  isDirty: boolean;
  label: string;
};

function viewportWidth(): number {
  return typeof window === "undefined" ? 0 : window.innerWidth;
}

export function dashboardSessionListWidth(collapsed = false): number {
  return collapsed ? DASHBOARD_SESSION_LIST_COLLAPSED_WIDTH : DASHBOARD_SESSION_LIST_WIDTH;
}

export function dashboardMinimapMaxWidth(width = viewportWidth(), collapsed = false): number {
  const ratioMaximum = Math.floor(width * DASHBOARD_MINIMAP_MAX_VIEWPORT_RATIO);
  const readableChatMaximum = Math.floor(width
    - dashboardSessionListWidth(collapsed)
    - DASHBOARD_MINIMAP_RESIZER_WIDTH
    - DASHBOARD_CHAT_MIN_WIDTH);
  return Math.max(DASHBOARD_MINIMAP_MIN_WIDTH, Math.min(ratioMaximum, readableChatMaximum));
}

export function normalizeDashboardMinimapWidth(value: number): number {
  const safeValue = Number.isFinite(value) && value > 0 ? value : DASHBOARD_MINIMAP_DEFAULT_WIDTH;
  return Math.max(DASHBOARD_MINIMAP_MIN_WIDTH, Math.round(safeValue));
}

export function clampDashboardMinimapWidth(value: number, width = viewportWidth(), collapsed = false): number {
  const safeValue = Number.isFinite(value) ? Math.round(value) : DASHBOARD_MINIMAP_DEFAULT_WIDTH;
  return Math.max(DASHBOARD_MINIMAP_MIN_WIDTH, Math.min(dashboardMinimapMaxWidth(width, collapsed), safeValue));
}

export function clampDashboardChatColumnLimit(value: number): number {
  if (!Number.isFinite(value)) return DASHBOARD_CHAT_COLUMN_LIMIT_DEFAULT;
  return Math.max(
    DASHBOARD_CHAT_COLUMN_LIMIT_MIN,
    Math.min(DASHBOARD_CHAT_COLUMN_LIMIT_MAX, Math.round(value)),
  );
}

function readStoredSessionListCollapsed(): boolean {
  try {
    return window.localStorage.getItem(DASHBOARD_SESSION_LIST_COLLAPSED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function persistSessionListCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(DASHBOARD_SESSION_LIST_COLLAPSED_STORAGE_KEY, collapsed ? "true" : "false");
  } catch {
    // Client-local dashboard preferences are best-effort in restricted WebViews.
  }
}

function readStoredMinimapWidth(): number {
  try {
    const stored = window.localStorage.getItem(DASHBOARD_MINIMAP_STORAGE_KEY);
    return stored === null
      ? DASHBOARD_MINIMAP_DEFAULT_WIDTH
      : clampDashboardMinimapWidth(Number(stored), viewportWidth(), readStoredSessionListCollapsed());
  } catch {
    return DASHBOARD_MINIMAP_DEFAULT_WIDTH;
  }
}

function persistMinimapWidth(width: number): void {
  try {
    window.localStorage.setItem(DASHBOARD_MINIMAP_STORAGE_KEY, String(width));
  } catch {
    // Client-local dashboard preferences are best-effort in restricted WebViews.
  }
}

function readStoredChatColumnLimit(): number {
  try {
    const stored = window.localStorage.getItem(DASHBOARD_CHAT_COLUMN_LIMIT_STORAGE_KEY);
    return stored === null ? DASHBOARD_CHAT_COLUMN_LIMIT_DEFAULT : clampDashboardChatColumnLimit(Number(stored));
  } catch {
    return DASHBOARD_CHAT_COLUMN_LIMIT_DEFAULT;
  }
}

function persistChatColumnLimit(limit: number): void {
  try {
    window.localStorage.setItem(DASHBOARD_CHAT_COLUMN_LIMIT_STORAGE_KEY, String(limit));
  } catch {
    // Client-local dashboard preferences are best-effort in restricted WebViews.
  }
}

function readStoredChatColumnPins(): string[] {
  try {
    const stored = window.localStorage.getItem(DASHBOARD_CHAT_COLUMN_PINS_STORAGE_KEY);
    if (stored === null) return [];
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return normalizeChatColumns(parsed.filter((tabId): tabId is string => typeof tabId === "string"));
  } catch {
    return [];
  }
}

function persistChatColumnPins(tabIds: readonly string[]): void {
  try {
    window.localStorage.setItem(DASHBOARD_CHAT_COLUMN_PINS_STORAGE_KEY, JSON.stringify(tabIds));
  } catch {
    // Client-local dashboard preferences are best-effort in restricted WebViews.
  }
}

function notifyChatColumnOpenBlocked(): void {
  useToastStore.getState().pushToast(dashboardStrings.chatColumnOpenBlocked, "warning");
}

export function isDashboardInboxColumn(tabId: string | null | undefined): boolean {
  return tabId === DASHBOARD_INBOX_COLUMN_ID;
}

export function isDashboardPreviewColumn(tabId: string | null | undefined): boolean {
  return tabId === DASHBOARD_PREVIEW_COLUMN_ID;
}

export function isDashboardSpecialColumn(tabId: string | null | undefined): boolean {
  return isDashboardInboxColumn(tabId) || isDashboardPreviewColumn(tabId);
}

export function dashboardReportInboxOpen(tabIds: readonly string[]): boolean {
  return tabIds.includes(DASHBOARD_INBOX_COLUMN_ID);
}

export function dashboardPreviewOpen(tabIds: readonly string[]): boolean {
  return tabIds.includes(DASHBOARD_PREVIEW_COLUMN_ID);
}

function normalizeDashboardPreviewPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function dashboardPreviewSourceKind(path: string, kind?: ArtifactSourceKind): ArtifactSourceKind {
  if (kind) return kind;
  if (/\.(?:md|markdown)$/i.test(path)) return "markdown";
  if (/\.(?:docx?|docm|dotx?|dotm|xlsx?|xlsm|xlsb|xltx?|xltm|pptx?|pptm|potx?|potm|ppsx?|ppsm)$/i.test(path)) {
    return "office";
  }
  return "html";
}

function dashboardPreviewLabel(sourcePath: string, sourceKind: ArtifactSourceKind): string {
  const fileLeaf = sourcePath.split(/[\\/]/).pop() || "artifact";
  if (sourceKind === "markdown") return `MD ${fileLeaf}`;
  if (sourceKind === "office") return `OFFICE ${fileLeaf}`;
  return `HTML ${fileLeaf}`;
}

function normalizeDashboardPreviewSource(info: DashboardPreviewSource): Omit<DashboardPreviewColumn, "reloadKey" | "isDirty"> {
  const previewPath = normalizeDashboardPreviewPath(info.previewPath);
  const sourcePath = normalizeDashboardPreviewPath(info.sourcePath ?? info.previewPath);
  const sourceKind = dashboardPreviewSourceKind(sourcePath, info.sourceKind);
  return {
    htmlPath: previewPath,
    sourcePath,
    sourceKind,
    previewPath,
    label: dashboardPreviewLabel(sourcePath, sourceKind),
  };
}

function confirmDiscardDashboardPreview(preview: DashboardPreviewColumn | null): boolean {
  if (!preview?.isDirty) return true;
  return window.confirm(`${preview.label} has unsaved edits. Discard them and reload?`);
}

function previewColumnDropped(previousIds: readonly string[], nextIds: readonly string[]): boolean {
  return previousIds.includes(DASHBOARD_PREVIEW_COLUMN_ID) && !nextIds.includes(DASHBOARD_PREVIEW_COLUMN_ID);
}

function applyPreviewColumnDrop<T extends { chatColumnTabIds: string[] }>(
  state: { chatColumnTabIds: string[]; previewColumn: DashboardPreviewColumn | null },
  next: T,
): (T & { previewColumn: DashboardPreviewColumn | null }) | null {
  if (!previewColumnDropped(state.chatColumnTabIds, next.chatColumnTabIds)) {
    return { ...next, previewColumn: state.previewColumn };
  }
  if (!confirmDiscardDashboardPreview(state.previewColumn)) return null;
  return {
    ...next,
    previewColumn: state.previewColumn ? { ...state.previewColumn, isDirty: false } : null,
  };
}

/** Deduplicate open chat columns. Truncation lives in `trimChatColumns`. */
export function normalizeChatColumns(tabIds: readonly string[], _limit?: number): string[] {
  const normalized: string[] = [];
  for (const tabId of tabIds) {
    if (tabId && !normalized.includes(tabId)) normalized.push(tabId);
  }
  return normalized;
}

export function findChatColumnEvictionIndex(
  tabIds: readonly string[],
  pinnedTabIds: readonly string[],
  activeTabId: string | null,
): number {
  const pinned = new Set(pinnedTabIds);
  return tabIds.findIndex((tabId) => !pinned.has(tabId) && tabId !== activeTabId);
}

export function canOpenAdditionalChatColumn(
  tabIds: readonly string[],
  limit: number,
  pinnedTabIds: readonly string[],
  activeTabId: string | null,
): boolean {
  const unique = normalizeChatColumns(tabIds);
  if (unique.length < clampDashboardChatColumnLimit(limit)) return true;
  if (findChatColumnEvictionIndex(unique, pinnedTabIds, activeTabId) >= 0) return true;
  return unique.length === 1 && !pinnedTabIds.includes(unique[0]!);
}

/** Evict the oldest unpinned, non-active column until `limit` is met. */
export function trimChatColumns(
  tabIds: readonly string[],
  limit: number,
  pinnedTabIds: readonly string[],
  activeTabId: string | null,
): string[] {
  const unique = normalizeChatColumns(tabIds);
  const safeLimit = clampDashboardChatColumnLimit(limit);
  if (unique.length <= safeLimit) return unique;
  const next = [...unique];
  while (next.length > safeLimit) {
    const evictIndex = findChatColumnEvictionIndex(next, pinnedTabIds, activeTabId);
    if (evictIndex < 0) break;
    next.splice(evictIndex, 1);
  }
  return next;
}

function openChatColumnWithEviction(
  tabIds: readonly string[],
  tabId: string,
  limit: number,
  pinnedTabIds: readonly string[],
  activeTabId: string | null,
  insertIndex?: number,
): string[] | null {
  const unique = normalizeChatColumns(tabIds);
  if (unique.includes(tabId)) return unique;
  const next = [...unique];
  let slot = insertIndex;
  if (next.length >= clampDashboardChatColumnLimit(limit)) {
    let evictIndex = findChatColumnEvictionIndex(next, pinnedTabIds, activeTabId);
    // Limit 1 has no inactive column. Replace the lone unpinned column so a
    // click can still switch sessions. Mixed pinned+active stays blocked.
    if (evictIndex < 0 && next.length === 1 && !pinnedTabIds.includes(next[0]!)) {
      evictIndex = 0;
    }
    if (evictIndex < 0) return null;
    next.splice(evictIndex, 1);
    if (slot !== undefined && evictIndex < slot) slot -= 1;
  }
  if (slot === undefined) next.push(tabId);
  else next.splice(Math.min(Math.max(slot, 0), next.length), 0, tabId);
  return next;
}

function syncPinnedChatColumns(pinnedTabIds: readonly string[], remainingTabIds: readonly string[]): string[] {
  const remaining = new Set(remainingTabIds);
  return pinnedTabIds.filter((tabId) => remaining.has(tabId));
}

function withPinnedSync<T extends { chatColumnTabIds: string[] }>(
  pinnedTabIds: readonly string[],
  next: T,
): T & { pinnedChatColumnTabIds: string[] } {
  const pinnedChatColumnTabIds = syncPinnedChatColumns(pinnedTabIds, next.chatColumnTabIds);
  if (pinnedChatColumnTabIds.length !== pinnedTabIds.length) persistChatColumnPins(pinnedChatColumnTabIds);
  return { ...next, pinnedChatColumnTabIds };
}

function activeChatColumnIndex(tabIds: readonly string[], activeColumn: number): number {
  if (!tabIds.length) return 0;
  if (!Number.isInteger(activeColumn)) return 0;
  return Math.max(0, Math.min(tabIds.length - 1, activeColumn));
}

function currentActiveTabId(tabIds: readonly string[], activeColumn: number): string | null {
  return tabIds[activeChatColumnIndex(tabIds, activeColumn)] ?? null;
}

function columnSnapshot(
  tabIds: readonly string[],
  activeColumn: number,
  limit: number,
  pinnedTabIds: readonly string[],
): {
  selectedTabId: string | null;
  chatColumnTabIds: string[];
  activeChatColumn: number;
  pinnedChatColumnTabIds: string[];
} {
  const unique = normalizeChatColumns(tabIds);
  const activeTabId = currentActiveTabId(unique, activeColumn);
  const chatColumnTabIds = trimChatColumns(unique, limit, pinnedTabIds, activeTabId);
  const activeChatColumn = activeTabId && chatColumnTabIds.includes(activeTabId)
    ? chatColumnTabIds.indexOf(activeTabId)
    : 0;
  const pinnedChatColumnTabIds = syncPinnedChatColumns(pinnedTabIds, chatColumnTabIds);
  if (pinnedChatColumnTabIds.length !== pinnedTabIds.length) persistChatColumnPins(pinnedChatColumnTabIds);
  return {
    chatColumnTabIds,
    activeChatColumn,
    selectedTabId: chatColumnTabIds[activeChatColumn] ?? null,
    pinnedChatColumnTabIds,
  };
}

function applyFocusChatColumn(
  state: Pick<DashboardViewState, "chatColumnTabIds" | "chatColumnLimit" | "activeChatColumn" | "pinnedChatColumnTabIds">,
  tabId: string | null,
  notifyBlocked = true,
): Pick<DashboardViewState, "selectedTabId" | "chatColumnTabIds" | "activeChatColumn" | "pinnedChatColumnTabIds"> {
  if (!tabId) {
    if (state.pinnedChatColumnTabIds.length) persistChatColumnPins([]);
    return { selectedTabId: null, chatColumnTabIds: [], activeChatColumn: 0, pinnedChatColumnTabIds: [] };
  }
  const chatColumnTabIds = normalizeChatColumns(state.chatColumnTabIds);
  const existingIndex = chatColumnTabIds.indexOf(tabId);
  if (existingIndex >= 0) {
    return { selectedTabId: tabId, chatColumnTabIds, activeChatColumn: existingIndex, pinnedChatColumnTabIds: state.pinnedChatColumnTabIds };
  }
  const next = openChatColumnWithEviction(
    chatColumnTabIds,
    tabId,
    state.chatColumnLimit,
    state.pinnedChatColumnTabIds,
    currentActiveTabId(chatColumnTabIds, state.activeChatColumn),
  );
  if (!next) {
    if (notifyBlocked) notifyChatColumnOpenBlocked();
    return {
      selectedTabId: currentActiveTabId(chatColumnTabIds, state.activeChatColumn),
      chatColumnTabIds,
      activeChatColumn: activeChatColumnIndex(chatColumnTabIds, state.activeChatColumn),
      pinnedChatColumnTabIds: state.pinnedChatColumnTabIds,
    };
  }
  return withPinnedSync(state.pinnedChatColumnTabIds, {
    selectedTabId: tabId,
    chatColumnTabIds: next,
    activeChatColumn: Math.max(0, next.indexOf(tabId)),
  });
}

function applyToggleChatColumn(
  state: Pick<DashboardViewState, "chatColumnTabIds" | "activeChatColumn" | "chatColumnLimit" | "pinnedChatColumnTabIds">,
  tabId: string,
): Pick<DashboardViewState, "selectedTabId" | "chatColumnTabIds" | "activeChatColumn" | "pinnedChatColumnTabIds"> {
  const chatColumnTabIds = normalizeChatColumns(state.chatColumnTabIds);
  const existingIndex = chatColumnTabIds.indexOf(tabId);
  if (existingIndex < 0) {
    return applyFocusChatColumn(state, tabId);
  }
  const activeChatColumn = activeChatColumnIndex(chatColumnTabIds, state.activeChatColumn);
  if (existingIndex !== activeChatColumn) {
    return { selectedTabId: tabId, chatColumnTabIds, activeChatColumn: existingIndex, pinnedChatColumnTabIds: state.pinnedChatColumnTabIds };
  }
  chatColumnTabIds.splice(existingIndex, 1);
  const nextActive = activeChatColumnIndex(
    chatColumnTabIds,
    existingIndex < chatColumnTabIds.length ? existingIndex : existingIndex - 1,
  );
  return withPinnedSync(state.pinnedChatColumnTabIds, {
    selectedTabId: chatColumnTabIds[nextActive] ?? null,
    chatColumnTabIds,
    activeChatColumn: nextActive,
  });
}

interface DashboardViewState {
  open: boolean;
  query: string;
  workspaceFilter: string | null;
  agentFilter: string | null;
  stateFilter: DashboardStateFilter | null;
  selectedTabId: string | null;
  chatColumnTabIds: string[];
  activeChatColumn: number;
  chatColumnLimit: number;
  pinnedChatColumnTabIds: string[];
  previewColumn: DashboardPreviewColumn | null;
  highlightedEventId: string | null;
  highlightedEventRequest: number;
  minimapWidth: number;
  sessionListCollapsed: boolean;
  toggle: () => void;
  openView: () => void;
  close: () => void;
  openOrReloadPreviewColumn: (info: DashboardPreviewSource) => void;
  setPreviewDirty: (isDirty: boolean) => void;
  applyPreviewSaved: (result: { sourcePath: string; previewPath: string }) => void;
  setQuery: (query: string) => void;
  setWorkspaceFilter: (workspaceId: string | null) => void;
  setAgentFilter: (agentKind: string | null) => void;
  setStateFilter: (stateFilter: DashboardStateFilter | null) => void;
  setSelectedTabId: (tabId: string | null) => void;
  toggleChatColumn: (tabId: string) => void;
  focusChatColumn: (tabId: string) => void;
  setChatColumnLimit: (limit: number) => void;
  toggleChatColumnPin: (tabId: string) => void;
  addChatColumn: (tabId: string) => void;
  moveChatColumn: (from: number, to: number) => void;
  insertChatColumn: (tabId: string, index: number) => void;
  setActiveChatColumn: (index: number) => void;
  removeChatColumn: (index: number) => void;
  setHighlightedEventId: (eventId: string | null) => void;
  setMinimapWidth: (width: number) => void;
  toggleSessionListCollapsed: () => void;
}

export const useDashboardViewStore = create<DashboardViewState>((set, get) => ({
  open: false,
  query: "",
  workspaceFilter: null,
  agentFilter: null,
  stateFilter: null,
  selectedTabId: null,
  chatColumnTabIds: [],
  activeChatColumn: 0,
  chatColumnLimit: readStoredChatColumnLimit(),
  pinnedChatColumnTabIds: readStoredChatColumnPins(),
  previewColumn: null,
  highlightedEventId: null,
  highlightedEventRequest: 0,
  minimapWidth: readStoredMinimapWidth(),
  sessionListCollapsed: readStoredSessionListCollapsed(),
  toggle: () => set((state) => ({ open: !state.open })),
  openView: () => set({ open: true }),
  close: () => set({ open: false }),
  setQuery: (query) => set({ query }),
  setWorkspaceFilter: (workspaceFilter) => set({ workspaceFilter }),
  setAgentFilter: (agentFilter) => set({ agentFilter }),
  setStateFilter: (stateFilter) => set({ stateFilter }),
  setSelectedTabId: (selectedTabId) => set((state) => applyPreviewColumnDrop(state, applyFocusChatColumn(state, selectedTabId, false)) ?? state),
  toggleChatColumn: (tabId) => set((state) => applyPreviewColumnDrop(state, applyToggleChatColumn(state, tabId)) ?? state),
  focusChatColumn: (tabId) => set((state) => applyPreviewColumnDrop(state, applyFocusChatColumn(state, tabId)) ?? state),
  setChatColumnLimit: (limit) => set((state) => {
    const chatColumnLimit = clampDashboardChatColumnLimit(limit);
    const next = applyPreviewColumnDrop(
      state,
      columnSnapshot(state.chatColumnTabIds, state.activeChatColumn, chatColumnLimit, state.pinnedChatColumnTabIds),
    );
    if (!next) return state;
    persistChatColumnLimit(chatColumnLimit);
    return { chatColumnLimit, ...next };
  }),
  openOrReloadPreviewColumn: (info) => set((state) => {
    const normalized = normalizeDashboardPreviewSource(info);
    const alreadyOpen = state.chatColumnTabIds.includes(DASHBOARD_PREVIEW_COLUMN_ID);
    if (alreadyOpen && !confirmDiscardDashboardPreview(state.previewColumn)) return state;
    const next = alreadyOpen
      ? applyFocusChatColumn(state, DASHBOARD_PREVIEW_COLUMN_ID)
      : applyPreviewColumnDrop(state, applyFocusChatColumn(state, DASHBOARD_PREVIEW_COLUMN_ID));
    if (!next) return state;
    if (!next.chatColumnTabIds.includes(DASHBOARD_PREVIEW_COLUMN_ID)) return next;
    return {
      ...next,
      previewColumn: {
        ...normalized,
        reloadKey: alreadyOpen || state.previewColumn?.sourcePath === normalized.sourcePath
          ? (state.previewColumn?.reloadKey ?? 0) + 1
          : 0,
        isDirty: false,
      },
    };
  }),
  setPreviewDirty: (isDirty) => set((state) => {
    if (!state.previewColumn || state.previewColumn.isDirty === isDirty) return state;
    return { previewColumn: { ...state.previewColumn, isDirty } };
  }),
  applyPreviewSaved: (result) => set((state) => {
    if (!state.previewColumn) return state;
    const sourcePath = normalizeDashboardPreviewPath(result.sourcePath);
    const previewPath = normalizeDashboardPreviewPath(result.previewPath);
    return {
      previewColumn: {
        ...state.previewColumn,
        htmlPath: previewPath,
        sourcePath,
        previewPath,
        isDirty: false,
        reloadKey: state.previewColumn.reloadKey + 1,
        label: dashboardPreviewLabel(sourcePath, state.previewColumn.sourceKind),
      },
    };
  }),
  toggleChatColumnPin: (tabId) => set((state) => {
    if (!tabId || !state.chatColumnTabIds.includes(tabId)) return state;
    const pinned = new Set(state.pinnedChatColumnTabIds);
    if (pinned.has(tabId)) pinned.delete(tabId);
    else pinned.add(tabId);
    const pinnedChatColumnTabIds = state.chatColumnTabIds.filter((id) => pinned.has(id));
    persistChatColumnPins(pinnedChatColumnTabIds);
    return { pinnedChatColumnTabIds };
  }),
  addChatColumn: (tabId) => set((state) => {
    const chatColumnTabIds = normalizeChatColumns(state.chatColumnTabIds);
    const existingIndex = chatColumnTabIds.indexOf(tabId);
    if (existingIndex >= 0) {
      return { selectedTabId: tabId, chatColumnTabIds, activeChatColumn: existingIndex };
    }
    const next = openChatColumnWithEviction(
      chatColumnTabIds,
      tabId,
      state.chatColumnLimit,
      state.pinnedChatColumnTabIds,
      currentActiveTabId(chatColumnTabIds, state.activeChatColumn),
    );
    if (!next) {
      notifyChatColumnOpenBlocked();
      return {
        chatColumnTabIds,
        activeChatColumn: activeChatColumnIndex(chatColumnTabIds, state.activeChatColumn),
      };
    }
    return applyPreviewColumnDrop(state, withPinnedSync(state.pinnedChatColumnTabIds, {
      selectedTabId: tabId,
      chatColumnTabIds: next,
      activeChatColumn: Math.max(0, next.indexOf(tabId)),
    })) ?? state;
  }),
  moveChatColumn: (from, to) => set((state) => {
    const chatColumnTabIds = normalizeChatColumns(state.chatColumnTabIds);
    if (from < 0 || from >= chatColumnTabIds.length || to < 0 || to > chatColumnTabIds.length || from === to) return state;
    // Slots are measured while the dragged column remains in the array.
    // Removing it first shifts every following slot one position to the left.
    const toIndex = to > from ? to - 1 : to;
    if (toIndex === from) return state;
    const activeTabId = currentActiveTabId(chatColumnTabIds, state.activeChatColumn);
    const [movedTabId] = chatColumnTabIds.splice(from, 1);
    chatColumnTabIds.splice(toIndex, 0, movedTabId!);
    const activeChatColumn = activeTabId ? chatColumnTabIds.indexOf(activeTabId) : 0;
    return {
      selectedTabId: activeTabId,
      chatColumnTabIds,
      activeChatColumn: Math.max(0, activeChatColumn),
    };
  }),
  insertChatColumn: (tabId, index) => set((state) => {
    const chatColumnTabIds = normalizeChatColumns(state.chatColumnTabIds);
    const slot = Math.min(Math.max(index, 0), chatColumnTabIds.length);
    const existingIndex = chatColumnTabIds.indexOf(tabId);
    if (existingIndex >= 0) {
      const toIndex = slot > existingIndex ? slot - 1 : slot;
      if (toIndex === existingIndex) return state;
      const activeTabId = currentActiveTabId(chatColumnTabIds, state.activeChatColumn);
      chatColumnTabIds.splice(existingIndex, 1);
      chatColumnTabIds.splice(toIndex, 0, tabId);
      const activeChatColumn = activeTabId ? chatColumnTabIds.indexOf(activeTabId) : 0;
      return {
        selectedTabId: activeTabId,
        chatColumnTabIds,
        activeChatColumn: Math.max(0, activeChatColumn),
      };
    }
    const next = openChatColumnWithEviction(
      chatColumnTabIds,
      tabId,
      state.chatColumnLimit,
      state.pinnedChatColumnTabIds,
      currentActiveTabId(chatColumnTabIds, state.activeChatColumn),
      slot,
    );
    if (!next) {
      notifyChatColumnOpenBlocked();
      return state;
    }
    return applyPreviewColumnDrop(state, withPinnedSync(state.pinnedChatColumnTabIds, {
      selectedTabId: tabId,
      chatColumnTabIds: next,
      activeChatColumn: Math.max(0, next.indexOf(tabId)),
    })) ?? state;
  }),
  setActiveChatColumn: (index) => set((state) => {
    const chatColumnTabIds = normalizeChatColumns(state.chatColumnTabIds);
    if (!chatColumnTabIds.length) return { selectedTabId: null, chatColumnTabIds, activeChatColumn: 0 };
    const activeChatColumn = activeChatColumnIndex(chatColumnTabIds, index);
    return {
      selectedTabId: chatColumnTabIds[activeChatColumn],
      chatColumnTabIds,
      activeChatColumn,
    };
  }),
  removeChatColumn: (index) => set((state) => {
    const chatColumnTabIds = normalizeChatColumns(state.chatColumnTabIds);
    if (!chatColumnTabIds.length) return { selectedTabId: null, chatColumnTabIds, activeChatColumn: 0 };
    const removedIndex = activeChatColumnIndex(chatColumnTabIds, index);
    chatColumnTabIds.splice(removedIndex, 1);
    const activeChatColumn = activeChatColumnIndex(
      chatColumnTabIds,
      state.activeChatColumn > removedIndex ? state.activeChatColumn - 1 : state.activeChatColumn,
    );
    return applyPreviewColumnDrop(state, withPinnedSync(state.pinnedChatColumnTabIds, {
      selectedTabId: chatColumnTabIds[activeChatColumn] ?? null,
      chatColumnTabIds,
      activeChatColumn,
    })) ?? state;
  }),
  setHighlightedEventId: (highlightedEventId) => set((state) => ({
    highlightedEventId,
    highlightedEventRequest: state.highlightedEventRequest + 1,
  })),
  setMinimapWidth: (width) => {
    const minimapWidth = clampDashboardMinimapWidth(width, viewportWidth(), get().sessionListCollapsed);
    persistMinimapWidth(minimapWidth);
    set({ minimapWidth });
  },
  toggleSessionListCollapsed: () => {
    const sessionListCollapsed = !get().sessionListCollapsed;
    persistSessionListCollapsed(sessionListCollapsed);
    set({ sessionListCollapsed });
  },
}));
