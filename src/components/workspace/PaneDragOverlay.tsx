import { memo } from "react";
import { usePaneDragStore } from "../../stores/paneDragStore";

export default memo(function PaneDragOverlay() {
  const item = usePaneDragStore((state) => state.item);
  const pointer = usePaneDragStore((state) => state.pointer);
  const target = usePaneDragStore((state) => state.target);

  if (!item || !pointer) return null;

  const meta = item.kind === "pane"
    ? `${item.tabCount} tab${item.tabCount === 1 ? "" : "s"}`
    : "tab";
  const className = [
    "pane-drag-ghost",
    `pane-drag-ghost--${item.kind}`,
    target ? "is-droppable" : "",
  ].filter(Boolean).join(" ");

  return (
    <div
      className={className}
      style={{
        transform: `translate3d(${pointer.x + 14}px, ${pointer.y + 14}px, 0)`,
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
