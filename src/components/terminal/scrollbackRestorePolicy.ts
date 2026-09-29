export interface ScrollbackRestorePolicyInput {
  isSessionAlive: boolean;
  hasPersistedScrollback: boolean;
  isAgentTab: boolean;
  initialReplay?: string[];
}

export interface ScrollbackRestorePolicy {
  usePersistedScrollback: boolean;
  initialReplay?: string[];
}

export function resolveScrollbackRestorePolicy({
  isSessionAlive,
  hasPersistedScrollback,
  isAgentTab,
  initialReplay,
}: ScrollbackRestorePolicyInput): ScrollbackRestorePolicy {
  const usePersistedScrollback = !isSessionAlive && hasPersistedScrollback;
  return {
    usePersistedScrollback,
    initialReplay: usePersistedScrollback || isAgentTab ? undefined : initialReplay,
  };
}

export function shouldFinalizePersistedInitialReplay(
  usePersistedScrollback: boolean,
  recoveryAction: string,
): boolean {
  return usePersistedScrollback && recoveryAction === "initial-replay";
}
