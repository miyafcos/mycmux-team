import { memo, useLayoutEffect, useRef, useState } from "react";
import { savepointTargetLabel } from "../../lib/savepointHandoff";
import { useSavepointDragStore } from "../../stores/savepointDragStore";
import { onlineStrings } from "./onlineStrings";

const GHOST_OFFSET = 14;
const GHOST_PAD = 8;

export default memo(function SavepointDragOverlay() {
  const item = useSavepointDragStore((state) => state.item);
  const pointer = useSavepointDragStore((state) => state.pointer);
  const target = useSavepointDragStore((state) => state.target);
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
    setOffset((previous) => previous.x === x && previous.y === y ? previous : { x, y });
  }, [pointer]);

  if (!item || !pointer) return null;
  const meta = target?.mode === "paste"
    ? onlineStrings.dragGhostPasteTarget(savepointTargetLabel(target.targetKind))
    : target?.mode === "spawn"
      ? onlineStrings.dragDropFullResumeSplit(target.direction)
      : target?.mode === "export"
        ? onlineStrings.dragGhostTransferTarget
      : onlineStrings.dragGhostMeta;

  return (
    <div
      ref={ghostRef}
      className={`pane-drag-ghost pane-drag-ghost--savepoint${target ? " is-droppable" : ""}`}
      style={{
        transform: `translate3d(${pointer.x + offset.x}px, ${pointer.y + offset.y}px, 0)`,
      }}
    >
      <span className="pane-drag-ghost-savepoint-mark" aria-hidden="true" />
      <span className="pane-drag-ghost-label">{item.label}</span>
      <span className="pane-drag-ghost-meta">{meta}</span>
    </div>
  );
});
