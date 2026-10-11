import { usePaneDragStore, type PaneDragSurface } from "../stores/paneDragStore";
import { useWorkspaceListStore } from "../stores/workspaceListStore";

const WORKSPACE_HOVER_DELAY_MS = 350;
interface WorkspaceHoverEffects {
  active: () => boolean;
  surface?: () => PaneDragSurface | undefined;
  switchWorkspace?: (id: string) => void;
}

/** Shared row dwell/mark policy for in-app drags and native dock receivers.
 * Each owner cancels its own timer; neither path changes the sidebar drop result. */
export function createWorkspaceHover(effects: WorkspaceHoverEffects) {
  let timer: number | null = null;
  let marked: string | null = null;
  let point: { x: number; y: number } | null = null;
  const eligibleWorkspace = (): string | null => {
    if (!point || !effects.active() || effects.surface?.() === "minimap") return null;
    const element = document.elementFromPoint(point.x, point.y);
    if (element?.closest("[data-dnd-new-workspace-target='true']")) return null;
    const id = element?.closest("[data-dnd-workspace-target-id]")?.getAttribute("data-dnd-workspace-target-id");
    const list = useWorkspaceListStore.getState();
    return id && id !== list.activeWorkspaceId && list.getWorkspace(id) ? id : null;
  };
  const clear = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null; point = null;
    // An idle hook unmount must not clear another owner's native hover mark.
    if (marked !== null && usePaneDragStore.getState().hoverWorkspaceId === marked) {
      usePaneDragStore.getState().setHoverWorkspaceId(null);
    }
    marked = null;
  };
  const update = (x: number, y: number) => {
    point = { x, y };
    const id = eligibleWorkspace();
    if (!id) { clear(); return; }
    usePaneDragStore.getState().setHoverWorkspaceId(id);
    if (marked === id && timer !== null) return;
    if (timer !== null) window.clearTimeout(timer);
    marked = id;
    timer = window.setTimeout(() => {
      const valid = eligibleWorkspace() === id;
      clear();
      if (valid) {
        if (effects.switchWorkspace) effects.switchWorkspace(id);
        else useWorkspaceListStore.getState().setActiveWorkspace(id);
      }
    }, WORKSPACE_HOVER_DELAY_MS);
  };
  return { update, clear };
}
