import { installLayoutRevisionAudit } from "./layoutRevisionAudit";

type AuditOptions = Parameters<typeof installLayoutRevisionAudit>[0];

let activeCleanup: (() => void) | null = null;

export function initializeLayoutRevisionAudit(options?: AuditOptions): () => void {
  if (activeCleanup) return activeCleanup;
  const unsubscribe = installLayoutRevisionAudit(options);
  let disposed = false;
  const cleanup = (): void => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    if (activeCleanup === cleanup) activeCleanup = null;
  };
  activeCleanup = cleanup;
  import.meta.hot?.dispose(cleanup);
  return cleanup;
}

export function __resetLayoutRevisionAuditBootstrapForTests(): void {
  activeCleanup?.();
  activeCleanup = null;
}

if (import.meta.env.DEV) initializeLayoutRevisionAudit();
