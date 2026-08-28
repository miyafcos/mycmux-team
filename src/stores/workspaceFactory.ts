import { normalizeReadableSplitColumns, reconcileSplitColumnsForPanes } from "../lib/layoutColumns";
import { columnWidthsMatch, rowHeightsMatch } from "../lib/layoutMetrics";
import { normalizeWorkspaceColor } from "../lib/workspaceColors";
import type { GridTemplateId, Workspace } from "../types";

export interface BuildWorkspaceRecordInput {
  id: string;
  name: string;
  gridTemplateId: GridTemplateId;
  panes: Workspace["panes"];
  splitColumns: string[][];
  status: Workspace["status"];
  createdAt: number;
  color?: string;
  pet?: string;
  columnWidths?: number[];
  rowHeightsPerCol?: number[][];
}

type Assert<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
export type _FactoryCoversWorkspace = Assert<Equal<keyof Workspace, keyof BuildWorkspaceRecordInput>>;

function cloneLayoutSizes(
  columnWidths: number[] | undefined,
  rowHeightsPerCol: number[][] | undefined,
): Pick<Workspace, "columnWidths" | "rowHeightsPerCol"> {
  return {
    columnWidths: columnWidths ? [...columnWidths] : undefined,
    rowHeightsPerCol: rowHeightsPerCol
      ? rowHeightsPerCol.map((rows) => [...rows])
      : undefined,
  };
}

export function normalizeWorkspaceLayout(workspace: Workspace): Workspace {
  const panes = structuredClone(workspace.panes);
  const splitColumns = reconcileSplitColumnsForPanes(
    normalizeReadableSplitColumns(structuredClone(workspace.splitColumns ?? [])),
    panes.map((pane) => pane.id),
  );
  const sizes = cloneLayoutSizes(workspace.columnWidths, workspace.rowHeightsPerCol);
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
    columnWidths: columnWidthsMatch(splitColumns, sizes.columnWidths)
      ? sizes.columnWidths
      : undefined,
    rowHeightsPerCol: rowHeightsMatch(splitColumns, sizes.rowHeightsPerCol)
      ? sizes.rowHeightsPerCol
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
    ...cloneLayoutSizes(input.columnWidths, input.rowHeightsPerCol),
  });
}
