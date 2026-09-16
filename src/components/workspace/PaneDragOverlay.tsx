import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { usePaneDragStore, type PaneDropZone } from "../../stores/paneDragStore";
import { useDetachedDockStore } from "../../stores/detachedDockStore";
import { useWorkspaceListStore } from "../../stores/workspaceListStore";
import { measureDropResultRect } from "../../lib/paneDropResultRect";
import { paneDndStrings } from "./paneDndStrings";

const GHOST_OFFSET = 14;
const GHOST_PAD = 8;
/** Keeps the frame just inside the pane border it is drawn over. */
const RESULT_INSET = 3;

export default memo(function PaneDragOverlay() {
  const item = usePaneDragStore((state) => state.item);
  const pointer = usePaneDragStore((state) => state.pointer);
  const target = usePaneDragStore((state) => state.target);
  // A detached window being dragged back lands the same way, so it gets the
  // same frame. Its pointer lives in another window, hence no ghost here.
  const dockZone = useDetachedDockStore((state) =>
    state.target?.kind === "pane-zone" ? state.target : null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState({ x: GHOST_OFFSET, y: GHOST_OFFSET });

  useLayoutEffect(() => {
    if (!pointer || !ghostRef.current) return;
    const { offsetWidth: width, offsetHeight: height } = ghostRef.current;
    let x = GHOST_OFFSET;
    let y = GHOST_OFFSET;
    if (pointer.x + x + width + GHOST_PAD > window.innerWidth) {
      x = Math.min(GHOST_OFFSET, window.innerWidth - GHOST_PAD - width - pointer.x);
    }
    if (pointer.y + y + height + GHOST_PAD > window.innerHeight) {
      y = Math.min(GHOST_OFFSET, window.innerHeight - GHOST_PAD - height - pointer.y);
    }
    setOffset((prev) => (prev.x === x && prev.y === y ? prev : { x, y }));
  }, [pointer]);

  if (!item || !pointer) {
    return dockZone
      ? <PaneDropResultFrame
          workspaceId={dockZone.workspaceId}
          paneId={dockZone.paneId}
          zone={dockZone.zone}
          source="pane"
        />
      : null;
  }

  const isTabBundle = item.kind === "tab-bundle";
  const isTabDrag = item.kind === "tab" || isTabBundle;
  const meta = item.kind === "pane"
    ? paneDndStrings.paneGhostMeta(item.tabCount)
    : isTabBundle
      ? `${item.tabIds.length}本`
      : paneDndStrings.tabGhostMeta;
  const className = [
    "pane-drag-ghost",
    `pane-drag-ghost--${isTabBundle ? "tab-bundle" : item.kind}`,
    target ? "is-droppable" : "",
  ].filter(Boolean).join(" ");

  // Outside the window there is nothing to draw the ghost against (the pointer
  // has left the viewport), so tear-out readiness gets a stationary banner
  // instead of a cursor-following hint.
  if (target?.kind === "new-window") {
    // Only a lone pane becomes a content-only window (see detachedOriginForDrag);
    // a tab or a bundle opens the normal shell.
    return <TearOutBanner label={`⬈ ${item.kind === "tab"
      ? paneDndStrings.dropAsDetachedPane
      : paneDndStrings.dropInNewWindow}`} />;
  }

  const zoneTarget = target?.kind === "pane" && target.surface !== "minimap" ? target : null;
  return (
    <>
      {zoneTarget && (
        <PaneDropResultFrame
          workspaceId={zoneTarget.workspaceId}
          paneId={zoneTarget.paneId}
          zone={zoneTarget.zone}
          source={isTabDrag ? "tab" : "pane"}
        />
      )}
      <div
        ref={ghostRef}
        className={className}
        style={{
          transform: `translate3d(${pointer.x + offset.x}px, ${pointer.y + offset.y}px, 0)`,
        }}
      >
        {isTabDrag ? (
          <span className="pane-drag-ghost-tab-mark" />
        ) : (
          <span className="pane-drag-ghost-pane-mark">
            <span />
            <span />
          </span>
        )}
        <span className="pane-drag-ghost-label">{item.label}</span>
        {isTabBundle ? <span className="pane-drag-ghost-count" aria-label={`${item.tabIds.length}本を移動`}>{item.tabIds.length}</span> : null}
        <span className="pane-drag-ghost-meta">{meta}</span>
      </div>
    </>
  );
});

/**
 * Draws where the pane will land, at the size it will land in — a left/right
 * split covers half the column, an up/down split half the pane. It is a fixed
 * overlay because a pane cannot paint outside its own box, which is why the
 * old in-pane band could never show a column-wide result.
 *
 * The minimap keeps its own cell feedback, and a tear-out has no rectangle to
 * point at, so neither draws a frame here.
 */
function PaneDropResultFrame({ workspaceId, paneId, zone, source }: {
  workspaceId: string;
  paneId: string;
  zone: PaneDropZone;
  source: "tab" | "pane";
}) {
  // Read the layout once per target change: it cannot move mid-drag, and
  // subscribing to the workspace list would re-render this on every store write.
  const rect = useMemo(() => {
    const workspace = useWorkspaceListStore.getState().getWorkspace(workspaceId);
    if (!workspace) return null;
    return measureDropResultRect(
      workspaceId,
      paneId,
      zone,
      workspace.splitColumns,
      workspace.panes.map((pane) => pane.id),
    );
  }, [workspaceId, paneId, zone]);
  if (!rect) return null;

  const label = zone === "center"
    ? (source === "tab" ? paneDndStrings.attachTab : paneDndStrings.mergePane)
    : paneDndStrings.split[zone];
  return (
    <div
      className={[
        "pane-drop-result",
        zone === "center" ? "pane-drop-result--merge" : "pane-drop-result--split",
        `pane-drop-result--source-${source}`,
      ].join(" ")}
      style={{
        left: rect.left + RESULT_INSET,
        top: rect.top + RESULT_INSET,
        width: Math.max(0, rect.width - RESULT_INSET * 2),
        height: Math.max(0, rect.height - RESULT_INSET * 2),
      }}
    >
      <span className="pane-drop-result__label">{label}</span>
    </div>
  );
}

/** Shared by tab/pane drags and the sidebar workspace drag (TabBar). */
export function TearOutBanner({ label }: { label: string }) {
  return (
    <div
      role="status"
      style={{
        position: "fixed",
        top: 10,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 200,
        padding: "6px 14px",
        borderRadius: 999,
        background: "var(--cmux-popover)",
        border: "1px solid var(--cmux-accent)",
        boxShadow: "var(--cmux-shadow-popover)",
        color: "var(--cmux-text)",
        fontSize: 12,
        fontFamily: "var(--cmux-font-ui)",
        pointerEvents: "none",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </div>
  );
}
