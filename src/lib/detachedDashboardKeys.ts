import { isEditableTarget } from "./keybindings";
import { useKeybindingStore } from "../stores/keybindingStore";
import { requestDashboard, type DashboardTarget } from "../components/layout/openDashboardForTab";

// Keep AppShell's fixture-delimited helpers in place.
function isXtermTarget(target: EventTarget | null): boolean {
  return Boolean((target as HTMLElement | null)?.closest(".xterm"));
}

export function handleDetachedDashboardKey(event: KeyboardEvent, target?: DashboardTarget): void {
  if (event.isComposing || event.repeat
    || (isEditableTarget(event.target) && !isXtermTarget(event.target))) return;
  if (useKeybindingStore.getState().getActionsForEvent(event)[0] !== "dashboard.open") return;
  event.preventDefault();
  void requestDashboard(target);
}
