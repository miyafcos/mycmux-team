import type { PaneDropZone } from "../stores/paneDragStore";
import { reconcileSplitColumnsForPanes } from "./layoutColumns";

export interface DropResultRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The rectangle the dragged pane will occupy once it lands, at its real size.
 *
 * A left/right split adds a whole column, so it claims half of the *column*
 * the target sits in — top to bottom, even when that column is stacked. An
 * up/down split only halves the target itself. Showing a fixed sliver instead
 * (the pane's 26%) is why the result never matched what the drop did.
 */
export function resolveDropResultRect(
  paneRect: DropResultRect,
  columnRect: DropResultRect,
  zone: PaneDropZone,
): DropResultRect {
  const halfColumn = columnRect.width / 2;
  const halfPane = paneRect.height / 2;
  switch (zone) {
    case "left":
      return { left: columnRect.left, top: columnRect.top, width: halfColumn, height: columnRect.height };
    case "right":
      return { left: columnRect.left + halfColumn, top: columnRect.top, width: halfColumn, height: columnRect.height };
    case "up":
      return { left: paneRect.left, top: paneRect.top, width: paneRect.width, height: halfPane };
    case "down":
      return { left: paneRect.left, top: paneRect.top + halfPane, width: paneRect.width, height: halfPane };
    default:
      return paneRect;
  }
}

export function unionRects(rects: DropResultRect[]): DropResultRect | null {
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.left + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.top + rect.height));
  return { left, top, width: right - left, height: bottom - top };
}

/** The panes stacked in the same column as `paneId`, target included. */
export function resolveColumnPaneIds(
  splitColumns: string[][] | undefined,
  paneIds: string[],
  paneId: string,
): string[] {
  const columns = reconcileSplitColumnsForPanes(splitColumns, paneIds);
  return columns.find((column) => column.includes(paneId)) ?? [paneId];
}

/**
 * Measures the drop result against the live layout. Panes are read from the
 * DOM by attribute rather than by selector string so an id never has to be
 * escaped, and a zoomed or hidden pane simply drops out of the column union.
 */
export function measureDropResultRect(
  workspaceId: string,
  paneId: string,
  zone: PaneDropZone,
  splitColumns: string[][] | undefined,
  paneIds: string[],
): DropResultRect | null {
  const paneRects = new Map<string, DropResultRect>();
  for (const element of document.querySelectorAll<HTMLElement>("[data-dnd-workspace-id][data-dnd-pane-id]")) {
    if (element.getAttribute("data-dnd-workspace-id") !== workspaceId) continue;
    const id = element.getAttribute("data-dnd-pane-id");
    if (!id) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    paneRects.set(id, { left: rect.left, top: rect.top, width: rect.width, height: rect.height });
  }
  const paneRect = paneRects.get(paneId);
  if (!paneRect) return null;
  const columnRect = zone === "left" || zone === "right"
    ? unionRects(
        resolveColumnPaneIds(splitColumns, paneIds, paneId)
          .map((id) => paneRects.get(id))
          .filter((rect): rect is DropResultRect => rect !== undefined),
      ) ?? paneRect
    : paneRect;
  return resolveDropResultRect(paneRect, columnRect, zone);
}
