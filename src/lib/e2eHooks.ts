/**
 * Test-only handles for scripted end-to-end checks (`e2e.eval`, see
 * src-tauri/src/e2e.rs). Installed only in bundles built with VITE_E2E=1; the
 * guard is a build-time constant, so every other bundle drops this module.
 *
 * Scripts reach the app through the same functions the UI calls — the drop
 * commit the drag loop runs, the stores the components read — so a check
 * exercises the shipped code path rather than a test double.
 */
import { commitPaneDragDrop } from "../hooks/usePaneDragSource";
import { getTearOutDiagnosticEvents } from "./tearOutDiagnostics";
import { isMainWindow, windowLabel } from "./windowContext";
import { useWorkspaceListStore } from "../stores/workspaceListStore";
import { useWorkspaceLayoutStore } from "../stores/workspaceLayoutStore";
import { usePaneMetadataStore } from "../stores/paneMetadataStore";
import { useUiStore } from "../stores/uiStore";
import { useToastStore } from "../stores/toastStore";

declare global {
  interface Window {
    __mycmuxE2E?: Record<string, unknown>;
  }
}

/** Drop the given tab outside the window, exactly as a drag release would. */
function detachTab(
  workspaceId: string,
  paneId: string,
  tabId: string,
  screenX: number,
  screenY: number,
): void {
  commitPaneDragDrop(
    { kind: "tab", workspaceId, paneId, tabId, label: "" },
    { kind: "new-window", screenX, screenY },
  );
}

export function installE2eHooks(): void {
  if (import.meta.env.VITE_E2E !== "1") return;
  const bootAt = performance.now();
  window.__mycmuxE2E = {
    bootAt,
    bootEpochMs: Date.now() - bootAt,
    windowLabel,
    isMainWindow,
    detachTab,
    tearOutEvents: getTearOutDiagnosticEvents,
    stores: {
      workspaceList: useWorkspaceListStore,
      layout: useWorkspaceLayoutStore,
      paneMetadata: usePaneMetadataStore,
      ui: useUiStore,
      toast: useToastStore,
    },
  };
}
