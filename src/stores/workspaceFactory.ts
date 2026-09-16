import { normalizeReadableSplitColumns, reconcileSplitColumnsForPanes } from "../lib/layoutColumns";
import {
  columnDividerPinsMatch,
  columnWidthsMatch,
  rowDividerPinsMatch,
  rowHeightsMatch,
} from "../lib/layoutMetrics";
import { normalizeWorkspaceColor } from "../lib/workspaceColors";
import type { GridTemplateId, Workspace } from "../types";

export type WorkspaceLayoutSizes = Pick<
  Workspace,
  "columnWidths" | "rowHeightsPerCol" | "columnDividerPins" | "rowDividerPinsPerCol"
>;

export interface BuildWorkspaceRecordInput extends WorkspaceLayoutSizes {
  id: string;
  name: string;
  gridTemplateId: GridTemplateId;
  panes: Workspace["panes"];
  splitColumns: string[][];
  status: Workspace["status"];
  createdAt: number;
  color?: string;
  pet?: string;
}


function cloneLayoutSizes(sizes: WorkspaceLayoutSizes): WorkspaceLayoutSizes {
  return {
    columnWidths: sizes.columnWidths ? [...sizes.columnWidths] : undefined,
    rowHeightsPerCol: sizes.rowHeightsPerCol
      ? sizes.rowHeightsPerCol.map((rows) => [...rows])
      : undefined,
    columnDividerPins: sizes.columnDividerPins ? [...sizes.columnDividerPins] : undefined,
    rowDividerPinsPerCol: sizes.rowDividerPinsPerCol
      ? sizes.rowDividerPinsPerCol.map((pins) => [...pins])
      : undefined,
  };
}

export function normalizeWorkspaceLayout(workspace: Workspace): Workspace {
  const panes = structuredClone(workspace.panes);
  const splitColumns = reconcileSplitColumnsForPanes(
    normalizeReadableSplitColumns(structuredClone(workspace.splitColumns ?? [])),
    panes.map((pane) => pane.id),
  );
  const sizes = cloneLayoutSizes(workspace);
  // A pin remembers a position measured against the sizes it was saved with, so
  // it is only believed while those sizes survive validation.
  const keepWidths = columnWidthsMatch(splitColumns, sizes.columnWidths);
  const keepHeights = rowHeightsMatch(splitColumns, sizes.rowHeightsPerCol);
  return {
    id: workspace.id,
    name: workspace.name,
    gridTemplateId: workspace.gridTemplateId,
    panes,
    status: workspace.status,
    createdAt: workspace.createdAt,
    color: normalizeWorkspaceColor(workspace.color),
    pet: workspace.pet,
    splitColumns,
    columnWidths: keepWidths ? sizes.columnWidths : undefined,
    rowHeightsPerCol: keepHeights ? sizes.rowHeightsPerCol : undefined,
    columnDividerPins: keepWidths && columnDividerPinsMatch(splitColumns, sizes.columnDividerPins)
      ? sizes.columnDividerPins
      : undefined,
    rowDividerPinsPerCol: keepHeights && rowDividerPinsMatch(splitColumns, sizes.rowDividerPinsPerCol)
      ? sizes.rowDividerPinsPerCol
      : undefined,
  };
}

export function buildWorkspaceRecord(input: BuildWorkspaceRecordInput): Workspace {
  return normalizeWorkspaceLayout({
    id: input.id,
    name: input.name,
    gridTemplateId: input.gridTemplateId,
    panes: structuredClone(input.panes),
    splitColumns: structuredClone(input.splitColumns),
    status: input.status,
    createdAt: input.createdAt,
    color: input.color,
    pet: input.pet,
    ...cloneLayoutSizes(input),
  });
}
