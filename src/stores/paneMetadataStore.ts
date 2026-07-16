import { create } from "zustand";
import type { AgentSessionKind } from "../types";

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
  agentKind?: AgentSessionKind;
  agentSessionId?: string;
}

export interface PaneMetadataState {
  metadata: Record<string, PaneMetadata>;
  lastLog: Record<string, string>;
  setMetadata: (sessionId: string, data: Partial<PaneMetadata>) => void;
  clearAgentStatus: (sessionId: string) => void;
  clearClaudeSessionId: (sessionId: string) => void;
  clearAgentSessionId: (sessionId: string) => void;
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
  lastLog: {},

  setMetadata: (sessionId, data) => set((state) => {
    const filtered = dropUndefined(data);
    if (Object.keys(filtered).length === 0) return state;
    const { lastLogLine, ...metadataFields } = filtered;
    const hasLastLogLine = Object.prototype.hasOwnProperty.call(filtered, "lastLogLine");
    const hasMetadataFields = Object.keys(metadataFields).length > 0;
    let nextLastLog = state.lastLog;
    let nextMetadata = state.metadata;
    let changed = false;
    if (hasLastLogLine && lastLogLine !== undefined && state.lastLog[sessionId] !== lastLogLine) {
      nextLastLog = {
        ...state.lastLog,
        [sessionId]: lastLogLine,
      };
      const prevMetadata = state.metadata[sessionId];
      if (prevMetadata) {
        // Preserve legacy getState().metadata reads without changing the low-frequency map reference.
        prevMetadata.lastLogLine = lastLogLine;
      } else {
        nextMetadata = {
          ...state.metadata,
          [sessionId]: { lastLogLine },
        };
      }
      changed = true;
    }
    if (!hasMetadataFields) {
      return changed ? { metadata: nextMetadata, lastLog: nextLastLog } : state;
    }
    const prev = nextMetadata[sessionId];
    // Reset the approval-notification dedupe key when the agent leaves waiting.
    const nextData: Partial<PaneMetadata> =
      metadataFields.agentStatus && metadataFields.agentStatus !== "waiting"
        ? { ...metadataFields, lastNotificationKey: undefined }
        : metadataFields;
    if (prev) {
      const keys = Object.keys(nextData) as (keyof PaneMetadata)[];
      const metadataChanged = keys.some((k) => prev[k] !== nextData[k]);
      if (!metadataChanged) return changed ? { lastLog: nextLastLog } : state;
    }
    nextMetadata = {
      ...nextMetadata,
      [sessionId]: { ...prev, ...nextData },
    };
    return {
      metadata: nextMetadata,
      lastLog: nextLastLog,
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

  clearAgentSessionId: (sessionId) => set((state) => {
    const prev = state.metadata[sessionId];
    if (!prev?.agentSessionId && !prev?.agentKind) return state;
    return {
      metadata: {
        ...state.metadata,
        [sessionId]: {
          ...prev,
          agentKind: undefined,
          agentSessionId: undefined,
        },
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

  clearNotification: (sessionId) => set((state) => {
    const previous = state.metadata[sessionId];
    if (
      (previous?.notificationCount ?? 0) === 0
      && (previous?.workDoneCount ?? 0) === 0
    ) {
      return state;
    }
    return {
      metadata: {
        ...state.metadata,
        [sessionId]: {
          ...previous,
          notificationCount: 0,
          workDoneCount: 0,
        },
      },
    };
  }),

  removeMetadata: (sessionId) => set((state) => {
    const { [sessionId]: _, ...rest } = state.metadata;
    const { [sessionId]: _lastLog, ...lastLogRest } = state.lastLog;
    return { metadata: rest, lastLog: lastLogRest };
  }),
}));
