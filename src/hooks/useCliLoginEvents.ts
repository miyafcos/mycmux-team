import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  CLI_LOGIN_COMPLETED_EVENT,
  CLI_LOGIN_FAILED_EVENT,
  CLI_LOGIN_IDENTITY_MISMATCH_EVENT,
  type CliLoginCompletedPayload,
  type CliLoginFailedPayload,
  type CliLoginIdentityMismatchPayload,
} from "../lib/ipc";
import { useCliLoginStore } from "../stores/cliLoginStore";
import { useWorkspaceListStore } from "../stores/workspaceListStore";

/**
 * Isolated CLI logins outlive the panel that starts them — they can take
 * minutes and the user is expected to go do the login elsewhere. This has to be
 * mounted somewhere that lives for the whole app session (it sits next to
 * `useAccountsPolling` in the title bar) so a login that finishes while every
 * account surface is closed still gets registered.
 */
export function useCliLoginEvents(): void {
  useEffect(() => {
    let cancelled = false;
    const unlisteners: UnlistenFn[] = [];
    const register = (subscription: Promise<UnlistenFn>) => {
      void subscription.then((unlisten) => {
        if (cancelled) unlisten();
        else unlisteners.push(unlisten);
      });
    };

    register(
      listen<CliLoginCompletedPayload>(CLI_LOGIN_COMPLETED_EVENT, (event) => {
        void useCliLoginStore.getState().handleCompleted(event.payload);
      }),
    );
    register(
      listen<CliLoginFailedPayload>(CLI_LOGIN_FAILED_EVENT, (event) => {
        useCliLoginStore.getState().handleFailed(event.payload);
      }),
    );
    register(
      listen<CliLoginIdentityMismatchPayload>(CLI_LOGIN_IDENTITY_MISMATCH_EVENT, (event) => {
        useCliLoginStore.getState().handleIdentityMismatch(event.payload);
      }),
    );

    // Closing the login tab by hand is a cancellation; nothing else tells the
    // backend, so its staging directory would sit there until the timeout.
    const unsubscribe = useWorkspaceListStore.subscribe((state) => {
      const liveSessionIds = new Set<string>();
      for (const workspace of state.workspaces) {
        for (const pane of workspace.panes) {
          for (const tab of pane.tabs) liveSessionIds.add(tab.sessionId);
        }
      }
      useCliLoginStore.getState().handleTabsChanged(liveSessionIds);
    });

    return () => {
      cancelled = true;
      for (const unlisten of unlisteners) unlisten();
      unsubscribe();
    };
  }, []);
}
