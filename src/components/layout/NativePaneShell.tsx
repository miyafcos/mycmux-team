import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import WorkspaceView from "../workspace/WorkspaceView";
import PaneDragOverlay from "../workspace/PaneDragOverlay";
import { buildThemeVars } from "./themeVars";
import { useThemeStore } from "../../stores/themeStore";
import { useTearoutStore, regrabTearoutWindow } from "../../lib/tearout/runtime";
import { nativePaneTearoutEnabled } from "../../lib/tearout/feature";
import { useSettingsStore } from "../../stores/settingsStore";
import { useWorkspaceListStore } from "../../stores/workspaceListStore";
import { confirmPaneClose } from "../../lib/paneCloseConfirmation";
import { getTabDisplayLabel } from "../../lib/tabDisplayLabel";
import { closeWindowWorkspacesAndDestroy } from "./SocketListener";
import { tearoutStrings } from "./tearoutStrings";
import { TearoutRecord } from "../../lib/tearout/record";
import { windowLabel } from "../../lib/windowContext";
import { getWindowFragments } from "../../lib/ipc";

/** The same live pane renderer and drag feedback, without a sidebar. */
export default function NativePaneShell() {
  const theme = useThemeStore();
  const workspaces = useWorkspaceListStore((state) => state.workspaces);
  const panes = workspaces.flatMap((workspace) => workspace.panes);
  const tabs = panes.flatMap((pane) => pane.tabs);
  const title = tabs.length === 1 ? getTabDisplayLabel(tabs[0]) : tearoutStrings.windowTitle(tabs.length);
  const [failed, setFailed] = useState(false);
  const [closing, setClosing] = useState(false);
  const stopBand = useRef(() => {});
  useEffect(() => () => stopBand.current(), []);
  const beginBand = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    stopBand.current();
    const start = { x: event.clientX, y: event.clientY, id: event.pointerId, at: Date.now() };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
    };
    const move = (next: PointerEvent) => {
      if (next.pointerId !== start.id || Math.hypot(next.clientX - start.x, next.clientY - start.y) < 9) return;
      cleanup();
      const native = workspaces.length === 1 && nativePaneTearoutEnabled(useSettingsStore.getState().nativePaneTearoutEnabled);
      const kind = panes.length > 1 ? "workspace" : tabs.length > 1 ? "tab" : "pane";
      void (native ? regrabTearoutWindow(new TearoutRecord(crypto.randomUUID(), tabs[0]?.id ?? workspaces[0].id,
        windowLabel(), start.at, kind, tabs.length)) : getCurrentWindow().startDragging())
        .catch((error) => { setFailed(true); console.warn("[tearout] band move failed", error); });
    };
    stopBand.current = cleanup;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", cleanup);
    window.addEventListener("pointercancel", cleanup);
  };
  const close = async () => {
    if (closing) return;
    setClosing(true);
    try {
      const peerWindowCount = tabs.length > 1
        ? new Set((await getWindowFragments()).map((fragment) => fragment.window_label)
          .filter((label) => label && label !== windowLabel())).size
        : 0;
      if (!await confirmPaneClose(panes, tabs.length === 1 ? "pane" : "window", { peerWindowCount })) return;
      await closeWindowWorkspacesAndDestroy();
    } catch (error) {
      setFailed(true);
      console.warn("[tearout] close failed", error);
    } finally {
      setClosing(false);
    }
  };
  const themeVars = buildThemeVars({ ...theme, background: theme.themeTweaks.background, mediaActive: false });
  return <div data-native-pane-shell="true" data-cmux-themed-root="true" style={{ ...themeVars,
    display: "flex", flexDirection: "column", width: "100%", height: "100%", position: "relative", background: "var(--cmux-bg)" }}>
    <div onPointerDown={beginBand} style={{ height: 30, flex: "0 0 30px", display: "flex", alignItems: "center",
      padding: "0 6px 0 10px", userSelect: "none", touchAction: "none", background: "var(--cmux-surface)",
      borderBottom: "1px solid var(--cmux-border-hairline)", color: "var(--cmux-text-secondary)" }}>
      <span title={title} style={{ flex: 1, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
      <button type="button" aria-label={tearoutStrings.close} title={tearoutStrings.closeHint} disabled={closing}
        onClick={() => { void close(); }} style={{ height: 22, width: 22, border: "none", borderRadius: "var(--cmux-radius-sm)",
          background: "transparent", color: "inherit", cursor: "pointer" }}>{"\u00d7"}</button>
    </div>
    {failed && <div role="alert" style={{ fontSize: 12, padding: "4px 10px", color: "var(--cmux-red)" }}>{tearoutStrings.failed}</div>}
    <div style={{ flex: 1, minHeight: 0, position: "relative" }}><WorkspaceView /></div>
    <PaneDragOverlay />
  </div>;
}

export function TearoutSourceGap() {
  const gap = useTearoutStore((state) => state.gap);
  const label = useTearoutStore((state) => state.gapLabel);
  return gap ? <div aria-hidden="true" title={label} style={{ position: "fixed", left: gap.x, top: gap.y,
    width: gap.width, height: gap.height, border: "1px dashed var(--cmux-border)", opacity: 0.55,
    pointerEvents: "none", zIndex: 10000 }} /> : null;
}
