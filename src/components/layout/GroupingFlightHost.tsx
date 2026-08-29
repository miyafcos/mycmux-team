import { useEffect, useRef } from "react";

import {
  groupingApplyTrackPoint,
  sampleGroupingApplyPath,
  type GroupingApplyAnimationPoint,
} from "./groupingApplyAnimation";
import {
  GROUPING_BRIDGE_FLIGHT_MS,
  createGroupingLandingSettleTracker,
  groupingBridgePath,
  type GroupingLandingRect,
  type GroupingLandingSettleTracker,
} from "./groupingLandingFlight";
import { tabGroupingStrings } from "../dashboard/dashboardStrings";

/**
 * Resident landing-flight host for phase 2 of the grouping apply animation.
 *
 * The panel's in-diagram flight ends at the after chip; this host receives the
 * frozen hand-off (viewport coordinates, exit tangent, destinations), keeps the
 * proxies alive while the panel and Dashboard retire, waits for the real
 * landing rects to settle, then flies each proxy over a tangent-continuous
 * bridge onto the real pane — or onto the workspace navigation entry for tabs
 * bound to a non-visible workspace (settled ruling, 2026-08-29).
 *
 * Mounted directly under the themed root with data-cmux-overlay-root so
 * OverlayShell's background isolation never inerts it; it must not contain a
 * `.cmux-overlay-panel[role='dialog']` or it would hijack the overlay focus
 * trap. Everything inside is imperative DOM driven by a single rAF — no React
 * re-renders during frames.
 */

export const GROUPING_LANDING_FADE_MS = 90;

export interface GroupingLandingFlightItem {
  tabId: string;
  label: string;
  color?: string;
  width: number;
  height: number;
  /** Viewport CSS px centre where the diagram flight ended (after chip). */
  exitCenter: GroupingApplyAnimationPoint;
  /** Unit tangent of the diagram path at its end; null → straight bridge. */
  exitTangent: GroupingApplyAnimationPoint | null;
  destination:
    | { kind: "pane"; workspaceId: string; paneId: string }
    | { kind: "workspace"; workspaceId: string };
}

export interface GroupingLandingFlightRequest {
  items: readonly GroupingLandingFlightItem[];
  movedCount: number;
  /** Workspace focused after the commit; used only for the final focus rule. */
  focusWorkspaceId: string | null;
}

type FlightListener = (request: GroupingLandingFlightRequest) => boolean;

let hostListener: FlightListener | null = null;

/**
 * Hands a landing flight to the resident host. Returns false when the host is
 * not mounted (caller then skips straight to the settled end state).
 */
export function requestGroupingLandingFlight(request: GroupingLandingFlightRequest): boolean {
  return hostListener?.(request) ?? false;
}

// CSS.escape is absent under jsdom; the ids are uuids, so quoting the two
// characters that could break an attribute selector is enough there.
const cssEscape: (value: string) => string =
  typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape.bind(CSS)
    : (value) => value.replace(/["\\]/g, "\\$&");

function landingCenterFor(item: GroupingLandingFlightItem): GroupingLandingRect | null {
  if (item.destination.kind === "workspace") {
    const nav = document.querySelector<HTMLElement>(
      `[data-dnd-workspace-target-id="${cssEscape(item.destination.workspaceId)}"]`,
    );
    if (!nav) return null;
    const rect = nav.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }
  const pill = document.querySelector<HTMLElement>(`[data-tab-id="${cssEscape(item.tabId)}"]`);
  if (pill) {
    const rect = pill.getBoundingClientRect();
    if (rect.width > 0 || rect.height > 0) {
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    }
  }
  const pane = document.querySelector<HTMLElement>(
    `[data-dnd-workspace-id="${cssEscape(item.destination.workspaceId)}"][data-dnd-pane-id="${cssEscape(item.destination.paneId)}"]`,
  );
  if (!pane) return null;
  const rect = pane.getBoundingClientRect();
  // Tab-bar edge of the pane: centred horizontally, just below the top edge.
  return { left: rect.left, top: rect.top, width: rect.width, height: Math.min(28, rect.height) };
}

interface FlightProxy {
  item: GroupingLandingFlightItem;
  element: HTMLElement;
  tracker: GroupingLandingSettleTracker;
  landing: GroupingApplyAnimationPoint | null;
  samples: readonly GroupingApplyAnimationPoint[] | null;
  waiting: boolean;
}

function placeProxy(proxy: FlightProxy, center: GroupingApplyAnimationPoint, opacity: number) {
  proxy.element.style.transform = `translate3d(${center.x - proxy.item.width / 2}px, ${center.y - proxy.item.height / 2}px, 0)`;
  proxy.element.style.opacity = String(opacity);
}

export function GroupingFlightHost() {
  const layerRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;

    let frame: number | null = null;
    let proxies: FlightProxy[] = [];
    let phase: "idle" | "waiting" | "flying" | "fading" = "idle";
    let flyStartedAt: number | null = null;
    let fadeStartedAt: number | null = null;
    let inputSeen = false;
    let focusWorkspaceId: string | null = null;

    const noteInput = () => {
      inputSeen = true;
    };

    const clearProxies = () => {
      for (const proxy of proxies) proxy.element.remove();
      proxies = [];
    };

    const stop = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      clearProxies();
      phase = "idle";
      flyStartedAt = null;
      fadeStartedAt = null;
      window.removeEventListener("pointerdown", noteInput, true);
      window.removeEventListener("keydown", noteInput, true);
      window.removeEventListener("focusin", noteInput, true);
    };

    const settleFocus = () => {
      // §6 focus rule: write focus at most once, only when the user gave no
      // input during the flight and nothing meaningful holds focus.
      if (inputSeen || !focusWorkspaceId) return;
      const active = document.activeElement;
      const orphaned = !active || active === document.body || !document.contains(active);
      if (!orphaned) return;
      document.querySelector<HTMLElement>(
        `[data-dnd-workspace-id="${cssEscape(focusWorkspaceId)}"][data-dnd-pane-id]`,
      )?.focus();
    };

    const finish = () => {
      stop();
      settleFocus();
    };

    const discard = () => {
      // §8.5: user action or environment change after the seam — drop only the
      // motion, never the committed data.
      if (phase !== "idle") stop();
    };

    const tick = (timestamp: number) => {
      frame = null;
      if (phase === "waiting") {
        let pending = false;
        for (const proxy of proxies) {
          if (!proxy.waiting) continue;
          const outcome = proxy.tracker.observe(landingCenterFor(proxy.item), timestamp);
          if (outcome.state === "pending") {
            pending = true;
            continue;
          }
          proxy.waiting = false;
          const rect = outcome.rect;
          if (rect) {
            proxy.landing = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
            try {
              proxy.samples = sampleGroupingApplyPath(
                [groupingBridgePath(proxy.item.exitCenter, proxy.item.exitTangent, proxy.landing)],
              );
            } catch {
              proxy.samples = null;
            }
          }
        }
        if (!pending) {
          phase = "flying";
          flyStartedAt = timestamp;
        }
      } else if (phase === "flying") {
        if (flyStartedAt === null) flyStartedAt = timestamp;
        const progress = Math.min(1, (timestamp - flyStartedAt) / GROUPING_BRIDGE_FLIGHT_MS);
        for (const proxy of proxies) {
          if (proxy.samples) placeProxy(proxy, groupingApplyTrackPoint(proxy.samples, progress), 1);
          else placeProxy(proxy, proxy.item.exitCenter, 1 - progress);
        }
        if (progress >= 1) {
          phase = "fading";
          fadeStartedAt = timestamp;
        }
      } else if (phase === "fading") {
        if (fadeStartedAt === null) fadeStartedAt = timestamp;
        const progress = Math.min(1, (timestamp - fadeStartedAt) / GROUPING_LANDING_FADE_MS);
        for (const proxy of proxies) {
          proxy.element.style.opacity = String(1 - progress);
        }
        if (progress >= 1) {
          finish();
          return;
        }
      }
      if (phase !== "idle") frame = requestAnimationFrame(tick);
    };

    const start: FlightListener = (request) => {
      if (request.items.length === 0) return false;
      discard();
      inputSeen = false;
      focusWorkspaceId = request.focusWorkspaceId;
      const startedAt = performance.now();
      proxies = request.items.map((item) => {
        const element = document.createElement("div");
        element.className = "cmux-tab-grouping-flight-chip";
        element.setAttribute("data-flight-tab-id", item.tabId);
        element.style.width = `${item.width}px`;
        element.style.height = `${item.height}px`;
        if (item.color) element.style.setProperty("--grouping-flight-color", item.color);
        const label = document.createElement("span");
        label.className = "cmux-tab-grouping-flight-label";
        label.textContent = item.label;
        element.appendChild(label);
        layer.appendChild(element);
        const proxy: FlightProxy = {
          item,
          element,
          tracker: createGroupingLandingSettleTracker(startedAt),
          landing: null,
          samples: null,
          waiting: true,
        };
        placeProxy(proxy, item.exitCenter, 1);
        return proxy;
      });
      phase = "waiting";
      if (liveRef.current) {
        liveRef.current.textContent = tabGroupingStrings.undoApplied(request.movedCount);
      }
      window.addEventListener("pointerdown", noteInput, true);
      window.addEventListener("keydown", noteInput, true);
      window.addEventListener("focusin", noteInput, true);
      frame = requestAnimationFrame(tick);
      return true;
    };

    hostListener = start;
    window.addEventListener("mycmux:workspace-visibility-change", discard);
    window.addEventListener("resize", discard);
    document.addEventListener("visibilitychange", discard);
    return () => {
      if (hostListener === start) hostListener = null;
      window.removeEventListener("mycmux:workspace-visibility-change", discard);
      window.removeEventListener("resize", discard);
      document.removeEventListener("visibilitychange", discard);
      stop();
    };
  }, []);

  return (
    <>
      <div data-cmux-overlay-root="true" className="cmux-grouping-flight-host" aria-hidden="true" ref={layerRef} />
      {/* Kept outside the aria-hidden flight layer so the announcement is read. */}
      <div
        data-cmux-overlay-root="true"
        aria-live="polite"
        ref={liveRef}
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          margin: -1,
          padding: 0,
          overflow: "hidden",
          clipPath: "inset(50%)",
          whiteSpace: "nowrap",
          border: 0,
        }}
      />
    </>
  );
}
