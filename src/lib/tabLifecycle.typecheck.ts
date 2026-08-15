import {
  assertNeverLaunchable,
  type DeclaredPaneTab,
  type RestorablePaneTab,
} from "./tabLifecycle";
import { startBackgroundTabSession } from "../components/layout/socketCommands";
import { useWorkspaceLayoutStore } from "../stores/workspaceLayoutStore";
import type { Pane } from "../types/workspace";

declare const declaredTab: DeclaredPaneTab;
declare const restorableTab: RestorablePaneTab;
declare const pane: Pane;
declare const launchDeclaredTab: ReturnType<
  typeof useWorkspaceLayoutStore.getState
>["launchDeclaredTab"];

const launch = (tab: RestorablePaneTab): string => tab.id;
launch(restorableTab);

if (false) {
  void startBackgroundTabSession(restorableTab, pane);
  launchDeclaredTab("workspace", "pane", restorableTab.id);
  // @ts-expect-error Declared tabs cannot reach a launch-typed API.
  launch(declaredTab);
  // @ts-expect-error The real background launch API accepts only restorable tabs.
  void startBackgroundTabSession(declaredTab, pane);
  // @ts-expect-error The real declared-launch action accepts a tab id, never a declared tab object.
  launchDeclaredTab("workspace", "pane", declaredTab);
  // @ts-expect-error The exhaustiveness guard accepts no launchable variant.
  assertNeverLaunchable(declaredTab);
}
