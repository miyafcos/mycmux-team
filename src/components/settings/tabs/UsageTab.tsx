// eslint-disable-next-line import/no-unresolved -- UsageAccountsPanel is a
// named export being added to UsageAccountsDialog.tsx concurrently by
// another agent (content without backdrop). See task pendingCrossAgentImports.
import { UsageAccountsPanel } from "../../layout/UsageAccountsDialog";

export function UsageTab() {
  return <UsageAccountsPanel />;
}
