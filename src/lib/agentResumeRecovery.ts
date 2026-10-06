import type { AgentSessionAlreadyRunning } from "./agentResumeConflict";

export interface ResumeRecoveryDependencies {
  ownerPresent(): Promise<boolean>;
  ownerVisible(): boolean;
  ownerWorking(): boolean;
  openOwner(): void;
  confirmStop(working: boolean, hidden: boolean): Promise<boolean>;
  stopOwner(sessionId: string): Promise<void>;
  resume(): Promise<void>;
  fresh(): Promise<void>;
  reopened(): void;
}

/** Serialize recovery, with one automatic attempt per blocked launch. */
export function createAgentResumeRecovery(conflict: AgentSessionAlreadyRunning, dependencies: ResumeRecoveryDependencies) {
  let disposed = false;
  let completed = false;
  let busy = false;
  let automaticAttempted = false;
  const available = () => !disposed && !completed;
  const run = async (action: () => Promise<void>): Promise<void> => {
    if (!available() || busy) return;
    busy = true;
    try { await action(); } finally { busy = false; }
  };
  const resume = async (automatic = false): Promise<void> => {
    if (!available()) return;
    await dependencies.resume();
    if (!available()) return;
    completed = true;
    if (automatic) dependencies.reopened();
  };
  return {
    openOwner: async () => { if (available()) dependencies.openOwner(); },
    takeover: () => run(async () => {
      if (await dependencies.ownerPresent()) {
        const confirmed = await dependencies.confirmStop(dependencies.ownerWorking(), !dependencies.ownerVisible());
        if (!confirmed || !available()) return;
        // The owner may have exited while the confirmation was open.
        if (await dependencies.ownerPresent()) {
          if (!available()) return;
          await dependencies.stopOwner(conflict.ownerSessionId);
        }
      }
      await resume();
    }),
    fresh: () => run(async () => {
      await dependencies.fresh();
      if (available()) completed = true;
    }),
    ownerEnded: () => run(async () => {
      if (automaticAttempted || await dependencies.ownerPresent() || !available()) return;
      automaticAttempted = true;
      await resume(true);
    }),
    dispose: () => { disposed = true; },
  };
}
