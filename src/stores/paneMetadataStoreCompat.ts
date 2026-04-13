import { create } from "zustand";

export type AgentStatus = "working" | "waiting" | "done" | "idle";

export interface PaneMetadata {
  lastLogLine?: string;
  notificationCount?: number;
  workDoneCount?: number;
  cwd?: string;
  gitBranch?: string;
  processTitle?: string;
  agentStatus?: AgentStatus;
  lastNotificationKey?: string;
}

export interface PaneMetadataState {
  metadata: Record<string, PaneMetadata>;
  setMetadata: (sessionId: string, data: Partial<PaneMetadata>) => void;
  incrementNotification: (sessionId: string) => void;
  notifyWaiting: (sessionId: string, patternId: number) => boolean;
  notifyWorkDone: (sessionId: string) => boolean;
  clearNotification: (sessionId: string) => void;
  removeMetadata: (sessionId: string) => void;
}

export const usePaneMetadataStore = create<PaneMetadataState>((set) => ({
  metadata: {},

  setMetadata: (sessionId, data) => set((state) => {
    const prev = state.metadata[sessionId];
    const nextData = data.agentStatus && data.agentStatus !== "waiting"
      ? { ...data, lastNotificationKey: undefined }
      : data;
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
