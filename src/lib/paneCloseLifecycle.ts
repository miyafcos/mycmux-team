import type { Pane } from "../types";
import { autoRefreshCrsmSessions } from "../components/CommandPalette/CrsmPalette";
import { pushClosedPane } from "../stores/closedPaneStore";

export function beforePaneClose(pane: Pane): void {
  pushClosedPane(pane);
  void autoRefreshCrsmSessions().catch(() => undefined);
}
