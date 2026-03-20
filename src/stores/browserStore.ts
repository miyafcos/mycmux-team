import { create } from "zustand";

export type BrowserCommandType =
  | "navigate"
  | "back"
  | "forward"
  | "reload"
  | "eval"
  | "snapshot"
  | "screenshot"
  | "status";

export interface BrowserCommand {
  type: BrowserCommandType;
  url?: string;      // for navigate
  script?: string;   // for eval
  resolve: (result: any) => void;
  reject: (error: string) => void;
}

interface BrowserState {
  // Per-sessionId pending command
  commands: Record<string, BrowserCommand | null>;
  // Dispatch a command to a specific browser pane; returns a promise of the result
  dispatch: (sessionId: string, cmd: Omit<BrowserCommand, "resolve" | "reject">) => Promise<any>;
  // Called by BrowserPane when a command completes
  complete: (sessionId: string) => void;
}

export const useBrowserStore = create<BrowserState>((set) => ({
  commands: {},

  dispatch: (sessionId, cmdData) => {
    return new Promise((resolve, reject) => {
      const cmd: BrowserCommand = { ...cmdData, resolve, reject };
      set((s) => ({ commands: { ...s.commands, [sessionId]: cmd } }));
    });
  },

  complete: (sessionId) => {
    set((s) => ({ commands: { ...s.commands, [sessionId]: null } }));
  },
}));
