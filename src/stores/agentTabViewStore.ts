import { create } from "zustand";

export type AgentTabContent = "terminal" | "conversation";
export const normalizeAgentTabContent = (value: unknown): AgentTabContent => value === "conversation" ? "conversation" : "terminal";
export const AGENT_TAB_VIEW_KEY = "mycmux:agent-tab-views";
export const AGENT_TAB_VIEW_LIMIT = 256;

export function readAgentTabViews(): Record<string, AgentTabContent> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(AGENT_TAB_VIEW_KEY) ?? "null");
    if (!Array.isArray(value)) return {};
    return Object.fromEntries(value.filter((entry): entry is [string, AgentTabContent] =>
      Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && entry[0].length > 0
      && entry[0].length <= 256 && (entry[1] === "terminal" || entry[1] === "conversation")).slice(-AGENT_TAB_VIEW_LIMIT));
  } catch { return {}; }
}

interface AgentTabViewState {
  views: Record<string, AgentTabContent>;
  conversationTabs: Record<string, true>;
  setConversationVisible: (tabId: string, visible: boolean) => void;
  setView: (tabId: string, view: AgentTabContent) => void;
}

/** Only a person's choice is persisted. Temporary record failures never write here. */
export const useAgentTabViewStore = create<AgentTabViewState>((set) => ({
  views: readAgentTabViews(),
  conversationTabs: {},
  setConversationVisible: (tabId, visible) => set(state => {
    if (Boolean(state.conversationTabs[tabId]) === visible) return state;
    const conversationTabs = { ...state.conversationTabs };
    if (visible) conversationTabs[tabId] = true;
    else delete conversationTabs[tabId];
    return { conversationTabs };
  }),
  setView: (tabId, value) => {
    if (!tabId || tabId.length > 256) return;
    set(state => {
      const entries = Object.entries(state.views).filter(([id]) => id !== tabId);
      entries.push([tabId, normalizeAgentTabContent(value)]);
      const bounded = entries.slice(-AGENT_TAB_VIEW_LIMIT);
      try { localStorage.setItem(AGENT_TAB_VIEW_KEY, JSON.stringify(bounded)); } catch { /* Storage is optional. */ }
      return { views: Object.fromEntries(bounded) };
    });
  },
}));
