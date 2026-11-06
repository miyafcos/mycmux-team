import { useEffect, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { titleBarStrings } from "./titleBarStrings";
import { useUiStore } from "../../stores/uiStore";
import { useDashboardViewStore } from "../../stores/dashboardViewStore";

export const buttonStyle: CSSProperties = {
  minWidth: "var(--cmux-dashboard-control-size)", minHeight: "var(--cmux-dashboard-control-size)",
  background: "none", border: "none", color: "var(--cmux-text-secondary)",
  cursor: "pointer", padding: "3px 6px", display: "flex", alignItems: "center",
};

interface NativeButtonState { owner: string; hovered: boolean; pressed: boolean }

// Serialize native updates across effect cleanup/remount, including StrictMode.
// The owner token also prevents an old unmount from removing a newer button.
let nativeUpdates: Promise<unknown> = Promise.resolve();
function updateNative(owner: string, rect: Record<string, number> | null) {
  const next = nativeUpdates.catch(() => {}).then(() => invoke<boolean>("snap_layouts_update", { owner, rect }));
  nativeUpdates = next;
  return next;
}

/** Shared by the main title bar and Windows native tear-out bands. */
export function WindowControls({ onClose, closing = false, closeLabel = titleBarStrings.close,
  closeHint = closeLabel }: { onClose?: () => void; closing?: boolean; closeLabel?: string; closeHint?: string }) {
  const [maximized, setMaximized] = useState(false);
  const maximizeButton = useRef<HTMLButtonElement>(null);
  const [nativeState, setNativeState] = useState({ hovered: false, pressed: false });
  useEffect(() => {
    if (!/Win/i.test(navigator.platform)) return;
    const button = maximizeButton.current;
    if (!button) return;
    const owner = crypto.randomUUID();
    let live = true;
    let ready = false;
    let disabled = false;
    let frame = 0;
    let lastRect = "";
    let stop: (() => void) | undefined;
    const pressable = (target: HTMLElement, box: DOMRect) => {
      if (getComputedStyle(target).visibility !== "visible") return false;
      if (typeof document.elementFromPoint !== "function") return true;
      const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return !top || top === target || target.contains(top);
    };
    const measure = () => {
      frame = 0;
      if (!live || !ready || disabled) return;
      const bounds = button.getBoundingClientRect();
      // :active scales around the centre. Report its stable layout box rather
      // than shrinking the native target during a press or CSS transition.
      const width = button.offsetWidth;
      const height = button.offsetHeight;
      // innerWidth rounds CSS pixels. The root fills this viewport and retains
      // subpixel width when its physical size is odd on a 150% display.
      const viewport = document.documentElement.getBoundingClientRect();
      // The native hit-test rectangle must not outlive a button the user cannot
      // press: pane zoom hides the title bar (visibility) or covers a detached
      // band, yet the box keeps its size and would swallow clicks on the zoomed
      // pane's heading buttons. Report a rectangle only while the button is
      // visible and topmost at its centre.
      const rect = width > 0 && height > 0 && pressable(button, bounds) ? {
        x: bounds.left - (width - bounds.width) / 2,
        y: bounds.top - (height - bounds.height) / 2,
        width, height, viewportWidth: viewport.width, viewportHeight: viewport.height,
      } : null;
      const key = JSON.stringify(rect);
      if (key === lastRect) return;
      lastRect = key;
      void updateNative(owner, rect).then(enabled => {
        if (live && rect && !enabled) { disabled = true; setNativeState({ hovered: false, pressed: false }); }
      }).catch(() => { if (live) { disabled = true; setNativeState({ hovered: false, pressed: false }); } });
    };
    const schedule = () => { if (live && !frame) frame = requestAnimationFrame(measure); };
    // A physical one-pixel change at fractional DPI can leave WebView's
    // rounded CSS extent unchanged. Still rebase the native client rectangle.
    const forceSchedule = () => { lastRect = ""; schedule(); };
    // Zoom, the dashboard and focus change visibility or stacking from outside
    // the title bar, so the observers below cannot see them. Measure again on the
    // next frame as well: the store fires before React commits the new markup.
    const resettle = () => { forceSchedule(); requestAnimationFrame(forceSchedule); };
    const unsubscribeZoom = useUiStore.subscribe((state, previous) => {
      if (state.zoomedPaneId !== previous.zoomedPaneId) resettle();
    });
    const unsubscribeDashboard = useDashboardViewStore.subscribe((state, previous) => {
      if (state.open !== previous.open) resettle();
    });
    // While the rectangle is withdrawn the button receives the WebView press, so
    // hovering is the moment to give the Snap Layouts rectangle back.
    button.addEventListener("pointerenter", forceSchedule);
    window.addEventListener("focus", forceSchedule);
    const win = getCurrentWindow();
    const nativeSignals = [win.onResized(forceSchedule), win.onMoved(forceSchedule)];
    for (const signal of nativeSignals) void signal.catch(() => {});
    const parent = button.parentElement;
    const layout = button.closest("[data-native-pane-band]") ?? parent?.parentElement ?? parent;
    const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
    resize?.observe(button);
    if (layout) resize?.observe(layout);
    const changes = new MutationObserver(schedule);
    if (layout) changes.observe(layout, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden"] });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    void getCurrentWindow().listen<NativeButtonState>("snap-layouts-state", ({ payload }) => {
      if (live && payload.owner === owner) setNativeState({ hovered: payload.hovered, pressed: payload.pressed });
    }).then(unlisten => {
      if (!live) { unlisten(); return; }
      stop = unlisten;
      ready = true;
      schedule();
    }).catch(() => { disabled = true; });
    return () => {
      live = false;
      stop?.();
      for (const signal of nativeSignals) void signal.then(unlisten => unlisten()).catch(() => {});
      cancelAnimationFrame(frame);
      unsubscribeZoom();
      unsubscribeDashboard();
      button.removeEventListener("pointerenter", forceSchedule);
      window.removeEventListener("focus", forceSchedule);
      resize?.disconnect();
      changes.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      void updateNative(owner, null).catch(() => {});
    };
  }, []);
  useEffect(() => {
    const win = getCurrentWindow();
    let live = true;
    const refresh = () => { void win.isMaximized().then(value => { if (live) setMaximized(value); }).catch(() => {}); };
    refresh();
    const resize = win.onResized(refresh);
    const move = win.onMoved(refresh);
    return () => {
      live = false;
      void resize.then(stop => stop());
      void move.then(stop => stop());
    };
  }, []);
  const maximizeLabel = maximized ? titleBarStrings.restore : titleBarStrings.maximize;
  return <>
    <button type="button" className="cmux-title-btn" style={buttonStyle}
      aria-label={titleBarStrings.minimize} title={titleBarStrings.minimize}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => { void getCurrentWindow().minimize().catch(console.error); }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
    </button>
    <button ref={maximizeButton} type="button" className="cmux-title-btn" data-snap-maximize="true"
      data-native-hover={nativeState.hovered ? "true" : undefined}
      data-native-pressed={nativeState.pressed ? "true" : undefined}
      style={{ ...buttonStyle, ...(nativeState.hovered ? { background: "var(--cmux-hover)" } : {}),
        ...(nativeState.pressed ? { transform: "scale(0.97)" } : {}) }}
      aria-label={maximizeLabel} title={maximizeLabel}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => { void getCurrentWindow().toggleMaximize().catch(console.error); }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {maximized ? <><rect x="5" y="7" width="12" height="12" rx="1" />
          <path d="M7 7V6a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-1" /></>
          : <rect x="4" y="4" width="16" height="16" rx="1" />}
      </svg>
    </button>
    <button type="button" className="cmux-title-btn cmux-title-btn--close" style={buttonStyle}
      aria-label={closeLabel} title={closeHint} disabled={closing}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClose ?? (() => { void getCurrentWindow().close().catch(console.error); })}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>
  </>;
}
