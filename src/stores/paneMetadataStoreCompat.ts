import { create } from "zustand";

export type AgentStatus = "working" | "waiting" | "done" | "idle";

export interface PaneMetadata {
  lastLogLine?: string;
  notificationCount?: number;
  workDoneCount?: number;
  cwd?: string;
  gitBranch?: string;
  processTitle?: string;
  processIsShell?: boolean;
  agentStatus?: AgentStatus;
  lastNotificationKey?: string;
  claudeSessionId?: string;
}

export interface PaneMetadataState {
  metadata: Record<string, PaneMetadata>;
  setMetadata: (sessionId: string, data: Partial<PaneMetadata>) => void;
  clearAgentStatus: (sessionId: string) => void;
  clearClaudeSessionId: (sessionId: string) => void;
  incrementNotification: (sessionId: string) => void;
  notifyWaiting: (sessionId: string, patternId: number) => boolean;
  notifyWorkDone: (sessionId: string) => boolean;
  clearNotification: (sessionId: string) => void;
  removeMetadata: (sessionId: string) => void;
}

// Drop undefined-valued keys so a partial update never accidentally clears
// a previously-set field. Use clearAgentStatus for explicit clears.
function dropUndefined<T extends object>(data: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(data) as (keyof T)[]) {
    const value = data[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export const usePaneMetadataStore = create<PaneMetadataState>((set) => ({
  metadata: {},

  setMetadata: (sessionId, data) => set((state) => {
    const filtered = dropUndefined(data);
    if (Object.keys(filtered).length === 0) return state;
    const prev = state.metadata[sessionId];
    // Reset the approval-notification dedupe key when the agent leaves waiting.
    const nextData: Partial<PaneMetadata> =
      filtered.agentStatus && filtered.agentStatus !== "waiting"
        ? { ...filtered, lastNotificationKey: undefined }
        : filtered;
    if (prev) {
      const keys = Object.keys(nextData) as (keyof PaneMetadata)[];
      const changed = keys.some((k) => prev[k] !== nextData[k]);
      if (!changed) return state;
    }
    return {
      metadata: {
        ...state.metadata,
        [sessionId]: { ...prev, ...nextData },
      },
    };
  }),

  clearAgentStatus: (sessionId) => set((state) => {
    const prev = state.metadata[sessionId];
    if (!prev || prev.agentStatus === undefined) return state;
    return {
      metadata: {
        ...state.metadata,
        [sessionId]: { ...prev, agentStatus: undefined, lastNotificationKey: undefined },
      },
    };
  }),

  clearClaudeSessionId: (sessionId) => set((state) => {
    const prev = state.metadata[sessionId];
    if (!prev?.claudeSessionId) return state;
    return {
      metadata: {
        ...state.metadata,
        [sessionId]: { ...prev, claudeSessionId: undefined },
      },
    };
  }),

  incrementNotification: (sessionId) => set((state) => {
    const prev = state.metadata[sessionId];
    const oldCount = prev?.notificationCount || 0;
    return {
      metadata: {
        ...state.metadata,
        [sessionId]: { ...prev, notificationCount: oldCount + 1 },
      },
    };
  }),

  notifyWaiting: (sessionId, patternId) => {
    const normalizedKey = `w:${patternId}`;
    let didNotify = false;

    set((state) => {
      const prev = state.metadata[sessionId];
      const oldCount = prev?.notificationCount || 0;
      const alreadyNotified =
        prev?.agentStatus === "waiting" &&
        prev?.lastNotificationKey === normalizedKey;

      if (alreadyNotified) {
        return state;
      }

      didNotify = true;

      return {
        metadata: {
          ...state.metadata,
          [sessionId]: {
            ...prev,
            agentStatus: "waiting",
            notificationCount: oldCount + 1,
            lastNotificationKey: normalizedKey,
          },
        },
      };
    });

    return didNotify;
  },

  notifyWorkDone: (sessionId) => {
    let didNotify = false;
    set((state) => {
      const prev = state.metadata[sessionId];
      const oldCount = prev?.workDoneCount || 0;
      didNotify = true;
      return {
        metadata: {
          ...state.metadata,
          [sessionId]: { ...prev, workDoneCount: oldCount + 1 },
        },
      };
    });
    return didNotify;
  },

  clearNotification: (sessionId) => set((state) => ({
    metadata: {
      ...state.metadata,
      [sessionId]: {
        ...state.metadata[sessionId],
        notificationCount: 0,
        workDoneCount: 0,
      }
    }
  })),

  removeMetadata: (sessionId) => set((state) => {
    const { [sessionId]: _, ...rest } = state.metadata;
    return { metadata: rest };
  }),
}));
