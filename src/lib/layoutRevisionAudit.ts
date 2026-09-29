import {
  PersistentLayoutValidationError,
  persistentLayoutSignature,
  type Sha256,
} from "./persistentLayoutProjection";
import { useWorkspaceListStore } from "../stores/workspaceListStore";

type LayoutSignatureProbe =
  | { ok: true; signature: Sha256 }
  | { ok: false };

/** Returns an unsubscribe function. Production logs; tests pass `onViolation`. */
export function installLayoutRevisionAudit(options?: {
  onViolation?: (message: string) => void;
}): () => void {
  const report = options?.onViolation ?? ((message: string) => {
    console.warn(`[layoutRevisionAudit] ${message}`);
  });
  const probeSignature = (): LayoutSignatureProbe => {
    try {
      return { ok: true, signature: persistentLayoutSignature(useWorkspaceListStore.getState().workspaces) };
    } catch (error) {
      if (!(error instanceof PersistentLayoutValidationError)) throw error;
      report(error.message);
      return { ok: false };
    }
  };
  let auditedSignature = probeSignature();
  let auditedRevision = useWorkspaceListStore.getState().layoutRevision ?? 0;

  return useWorkspaceListStore.subscribe((state) => {
    const nextSignature = probeSignature();
    const nextRevision = state.layoutRevision ?? 0;
    if (auditedSignature.ok && nextSignature.ok) {
      if (nextSignature.signature !== auditedSignature.signature && nextRevision <= auditedRevision) {
        report("layout changed without layoutRevision bump");
      }
      if (nextSignature.signature === auditedSignature.signature && nextRevision !== auditedRevision) {
        report("layoutRevision bumped without persistent layout change");
      }
    }
    auditedSignature = nextSignature;
    auditedRevision = nextRevision;
  });
}
