/**
 * Workspace Store - Re-exports all split stores from a single location
 * 
 * This file provides a convenient single import point for all workspace-related stores.
 * Each store is focused on a specific domain:
 * 
 * - useWorkspaceListStore: Workspace CRUD, active workspace
 * - useWorkspaceLayoutStore: Pane/tab management within workspaces
 * - useUiStore: UI state (sidebar, keybindings, zoom)
 * - usePaneMetadataStore: Per-pane metadata (notifications, cwd, git branch)
 */

// Re-export all stores
export { useWorkspaceListStore } from "./workspaceListStore";
export { useWorkspaceLayoutStore } from "./workspaceLayoutStore";
export { useUiStore } from "./uiStore";
export { usePaneMetadataStore } from "./paneMetadataStore";

// Re-export types
export type { PaneMetadata, PaneMetadataState } from "./paneMetadataStore";
