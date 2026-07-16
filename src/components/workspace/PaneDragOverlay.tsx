import { memo, useLayoutEffect, useRef, useState } from "react";
import { usePaneDragStore } from "../../stores/paneDragStore";
import { paneDndStrings } from "./paneDndStrings";

const GHOST_OFFSET = 14;
const GHOST_PAD = 8;

export default memo(function PaneDragOverlay() {
  const item = usePaneDragStore((state) => state.item);
  const pointer = usePaneDragStore((state) => state.pointer);
  const target = usePaneDragStore((state) => state.target);
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

  if (!item || !pointer) return null;

  const meta = item.kind === "pane"
    ? paneDndStrings.paneGhostMeta(item.tabCount)
    : paneDndStrings.tabGhostMeta;
  const className = [
    "pane-drag-ghost",
    `pane-drag-ghost--${item.kind}`,
    target ? "is-droppable" : "",
  ].filter(Boolean).join(" ");

  return (
    <div
      ref={ghostRef}
      className={className}
      style={{
        transform: `translate3d(${pointer.x + offset.x}px, ${pointer.y + offset.y}px, 0)`,
      }}
    >
      {item.kind === "tab" ? (
        <span className="pane-drag-ghost-tab-mark" />
      ) : (
        <span className="pane-drag-ghost-pane-mark">
          <span />
          <span />
        </span>
      )}
      <span className="pane-drag-ghost-label">{item.label}</span>
      <span className="pane-drag-ghost-meta">{meta}</span>
    </div>
  );
});
