import { useCallback, useEffect, useMemo, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { usePaneDragStore } from "../../stores/paneDragStore";
import { useKeybindingStore } from "../../stores/keybindingStore";
import { useSavepointDragStore } from "../../stores/savepointDragStore";
import { useWorkspaceListStore } from "../../stores/workspaceListStore";
import { useWebPaneTranscriptStore } from "../../stores/webPaneTranscriptStore";
import type { Workspace } from "../../types";
import {
  createWebPane,
  destroyWebPane,
  updateWebPane,
  WEB_PANE_SIGNIN_EVENT,
  type WebPaneBounds,
  type WebPaneSigninEvent,
} from "./webPaneApi";
import {
  deriveWebPaneForwardedShortcuts,
  dispatchWebPaneKeydown,
  WEB_PANE_KEYDOWN_EVENT,
  type WebPaneForwardedKey,
} from "./webPaneShortcuts";

const OCCLUDER_SELECTOR = [
  ".cmux-overlay-backdrop",
  ".cmux-popover-panel",
  "[aria-modal='true']",
  "[role='menu']",
  "[data-cmux-native-webview-occluder]",
].join(",");

export interface WebPaneTabDescriptor {
  tabId: string;
  presetId: string;
  webBackground?: boolean;
  webInitialUrl?: string;
}

export function collectWebPaneTabs(workspaces: readonly Workspace[]): WebPaneTabDescriptor[] {
  return workspaces.flatMap((workspace) => workspace.panes.flatMap((pane) => (
    pane.tabs.flatMap((tab) => tab.type === "web" && tab.presetId
      ? [{ tabId: tab.id, presetId: tab.presetId, webBackground: tab.webBackground, webInitialUrl: tab.webInitialUrl }]
      : [])
  )));
}

function findHost(tabId: string): HTMLElement | null {
  const hosts = document.querySelectorAll<HTMLElement>("[data-web-pane-host-tab-id]");
  for (const host of hosts) {
    if (host.dataset.webPaneHostTabId === tabId) return host;
  }
  return null;
}

export function webPaneBoundsForHost(host: HTMLElement | null): WebPaneBounds | null {
  if (!host) return null;
  const style = window.getComputedStyle(host);
  if (style.display === "none" || style.visibility === "hidden") return null;
  const rect = host.getBoundingClientRect();
  if (
    !Number.isFinite(rect.x)
    || !Number.isFinite(rect.y)
    || !Number.isFinite(rect.width)
    || !Number.isFinite(rect.height)
    || rect.width <= 0
    || rect.height <= 0
  ) return null;
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function frameKey(bounds: WebPaneBounds | null): string {
  return bounds
    ? `${bounds.x.toFixed(2)}:${bounds.y.toFixed(2)}:${bounds.width.toFixed(2)}:${bounds.height.toFixed(2)}`
    : "hidden";
}

export default function WebPaneController() {
  const workspaces = useWorkspaceListStore((state) => state.workspaces);
  const keybindings = useKeybindingStore((state) => state.keybindings);
  const paneDragActive = usePaneDragStore((state) => state.item !== null);
  const savepointDragActive = useSavepointDragStore((state) => state.item !== null);
  const readingTabIds = useWebPaneTranscriptStore((state) => state.readingTabIds);
  const tabs = useMemo(() => collectWebPaneTabs(workspaces), [workspaces]);
  const tabsSignature = tabs.map((tab) => `${tab.tabId}:${tab.presetId}`).sort().join("|");
  const forwardedShortcuts = useMemo(
    () => deriveWebPaneForwardedShortcuts(keybindings),
    [keybindings],
  );
  const shortcutsSignature = forwardedShortcuts.join("|");

  const descriptorsRef = useRef(tabs);
  descriptorsRef.current = tabs;
  const desiredRef = useRef(new Map<string, string>());
  const knownRef = useRef(new Map<string, string>());
  const createdRef = useRef(new Set<string>());
  const openingRef = useRef(new Set<string>());
  const failedRef = useRef(new Set<string>());
  const transferRetryRef = useRef(new Map<string, { attempts: number; retryAt: number }>());
  const lastFrameRef = useRef(new Map<string, string>());
  // Tabs whose profile folder is currently held by a sign-in browser window.
  // Recreating a webview then would fight the other process for the folder.
  const suspendedRef = useRef(new Set<string>());
  const operationsRef = useRef(new Map<string, Promise<void>>());
  const dragBlockedRef = useRef(false);
  const forwardedShortcutsRef = useRef(new Set<string>());
  // Tabs the dashboard is reading. They are parked instead of hidden so the
  // page keeps running while the dashboard covers the workspace.
  const readingRef = useRef(new Set<string>());
  // Set by the placement loop below while it is running. The loop parks
  // itself when there is no web pane to place, and this is how it is woken.
  const wakePlacementRef = useRef<(() => void) | null>(null);

  desiredRef.current = new Map(tabs.map((tab) => [tab.tabId, tab.presetId]));
  dragBlockedRef.current = paneDragActive || savepointDragActive;
  forwardedShortcutsRef.current = new Set(forwardedShortcuts);
  readingRef.current = new Set(readingTabIds);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<WebPaneForwardedKey>(WEB_PANE_KEYDOWN_EVENT, (event) => {
      dispatchWebPaneKeydown(
        event.payload,
        forwardedShortcutsRef.current,
        new Set(desiredRef.current.keys()),
      );
    }).then((cleanup) => {
      if (cancelled) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      unlisten?.();
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<WebPaneSigninEvent>(WEB_PANE_SIGNIN_EVENT, (event) => {
      const { tabIds, state } = event.payload;
      for (const tabId of tabIds) {
        if (state === "running") {
          // Rust already closed these webviews to free the profile folder, so
          // forget they exist -- otherwise the pane stays blank for good.
          suspendedRef.current.add(tabId);
          createdRef.current.delete(tabId);
          openingRef.current.delete(tabId);
          failedRef.current.delete(tabId);
          lastFrameRef.current.delete(tabId);
        } else {
          suspendedRef.current.delete(tabId);
        }
      }
    }).then((cleanup) => {
      if (cancelled) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      unlisten?.();
      cancelled = true;
    };
  }, []);

  const enqueue = useCallback((tabId: string, operation: () => Promise<void>): void => {
    const previous = operationsRef.current.get(tabId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(operation)
      .catch((error) => {
        console.error("[web-pane] operation failed", tabId, error);
      });
    operationsRef.current.set(tabId, next);
    void next.finally(() => {
      if (operationsRef.current.get(tabId) === next) operationsRef.current.delete(tabId);
    });
  }, []);

  useEffect(() => {
    const next = new Map(tabs.map((tab) => [tab.tabId, tab.presetId]));
    for (const [tabId, previousPresetId] of knownRef.current) {
      const nextPresetId = next.get(tabId);
      if (nextPresetId === previousPresetId) continue;
      openingRef.current.delete(tabId);
      failedRef.current.delete(tabId);
      lastFrameRef.current.delete(tabId);
      transferRetryRef.current.delete(tabId);
      enqueue(tabId, async () => {
        await destroyWebPane(tabId);
        createdRef.current.delete(tabId);
      });
    }
    knownRef.current = next;
    for (const tabId of next.keys()) failedRef.current.delete(tabId);
    wakePlacementRef.current?.();
  }, [enqueue, tabsSignature]);

  useEffect(() => {
    let cancelled = false;
    let rafId = 0;

    const schedule = () => {
      if (cancelled || rafId !== 0) return;
      rafId = window.requestAnimationFrame(tick);
    };

    const tick = () => {
      rafId = 0;
      if (cancelled) return;
      // Nothing to follow: stop asking for frames. This loop ran at the display
      // rate in every window — each frame querying the DOM for five overlay
      // selectors — whether or not the workspace had a single web pane in it,
      // which kept WebKit's frame loop awake and burned battery for nothing.
      // Anything that can create one wakes it again (wakePlacementRef).
      if (
        desiredRef.current.size === 0
        && createdRef.current.size === 0
        && openingRef.current.size === 0
      ) {
        return;
      }
      const domOccluded = document.visibilityState === "hidden"
        || document.querySelector(OCCLUDER_SELECTOR) !== null;
      const blocked = dragBlockedRef.current || domOccluded;

      for (const [tabId, presetId] of desiredRef.current) {
        if (suspendedRef.current.has(tabId)) continue;
        const retry = transferRetryRef.current.get(tabId);
        if (retry && Date.now() < retry.retryAt) continue;
        const bounds = blocked ? null : webPaneBoundsForHost(findHost(tabId));
        const key = `${frameKey(bounds)}:${shortcutsSignature}`;

        const tab = descriptorsRef.current.find((candidate) => candidate.tabId === tabId);
        if ((bounds || tab?.webBackground) && !createdRef.current.has(tabId) && !openingRef.current.has(tabId) && !failedRef.current.has(tabId)) {
          openingRef.current.add(tabId);
          enqueue(tabId, async () => {
            try {
              if (bounds) {
                await createWebPane(tabId, presetId, bounds, forwardedShortcuts,
                  tab?.webInitialUrl === undefined ? undefined : { url: tab.webInitialUrl });
              } else {
                await createWebPane(tabId, presetId,
                  { x: 0, y: 0, width: 1024, height: 768 }, forwardedShortcuts,
                  { visible: false, url: tab?.webInitialUrl });
              }
              if (!desiredRef.current.has(tabId)) {
                await destroyWebPane(tabId);
                createdRef.current.delete(tabId);
                return;
              }
              transferRetryRef.current.delete(tabId);
              createdRef.current.add(tabId);
              lastFrameRef.current.delete(tabId);
            } catch (error) {
              // The source controller releases the old webview after adoption.
              // Retry only that ownership collision, without destroying its view.
              const attempts = transferRetryRef.current.get(tabId)?.attempts ?? 0;
              if (String(error).includes(`web pane ${tabId} is attached to a different window`)
                && desiredRef.current.has(tabId) && attempts < 20) {
                transferRetryRef.current.set(tabId, { attempts: attempts + 1, retryAt: Date.now() + 250 });
                return;
              }
              transferRetryRef.current.delete(tabId);
              failedRef.current.add(tabId);
              throw error;
            } finally {
              openingRef.current.delete(tabId);
            }
          });
        } else if (createdRef.current.has(tabId) && lastFrameRef.current.get(tabId) !== key) {
          lastFrameRef.current.set(tabId, key);
          // A background tab is parked off-screen rather than hidden: a hidden
          // WebView2 pauses requestAnimationFrame and Gemini's streamed answer
          // never reaches the DOM (2026-09-07).
          const park = bounds === null && (tab?.webBackground === true || readingRef.current.has(tabId));
          enqueue(tabId, () => (park
            ? updateWebPane(tabId, null, false, forwardedShortcuts, { park: true })
            : updateWebPane(tabId, bounds, bounds !== null, forwardedShortcuts)));
        }
      }

      schedule();
    };

    wakePlacementRef.current = schedule;
    schedule();
    return () => {
      cancelled = true;
      wakePlacementRef.current = null;
      window.cancelAnimationFrame(rafId);
    };
  }, [enqueue, forwardedShortcuts, shortcutsSignature]);

  return null;
}
