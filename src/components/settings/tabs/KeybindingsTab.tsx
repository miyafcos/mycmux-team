// eslint-disable-next-line import/no-unresolved -- KeybindingsPanel is a
// named export being added to KeybindingsModal.tsx concurrently by another
// agent (export function KeybindingsPanel(props: { embedded?: boolean })).
// See task pendingCrossAgentImports.
import { KeybindingsPanel } from "../../layout/KeybindingsModal";

export function KeybindingsTab() {
  return <KeybindingsPanel embedded />;
}
