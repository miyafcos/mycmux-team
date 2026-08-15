export const DEFAULT_LAYOUT_SIZE = 1;

function positiveLayoutSizes(sizes: number[] | undefined, itemCount: number): number[] | null {
  if (!sizes || sizes.length !== itemCount) return null;
  const cleaned = sizes.map((size) =>
    typeof size === "number" && Number.isFinite(size) && size > 0 ? size : null,
  );
  return cleaned.every((size): size is number => size !== null) ? cleaned : null;
}

export function fitLayoutSizes(
  sizes: number[] | undefined,
  availableSize: number,
  itemCount: number,
): number[] | undefined {
  const fitSize = Math.floor(availableSize);
  if (itemCount <= 0 || fitSize <= 0) return undefined;

  const source = positiveLayoutSizes(sizes, itemCount) ?? Array.from({ length: itemCount }, () => 1);
  const total = source.reduce((sum, size) => sum + size, 0);
  if (total <= 0) return undefined;

  const rawSizes = source.map((size) => (size / total) * fitSize);
  const fitted = rawSizes.map((size) => Math.floor(size));
  let remaining = fitSize - fitted.reduce((sum, size) => sum + size, 0);
  const order = rawSizes
    .map((size, index) => ({ index, fraction: size - Math.floor(size) }))
    .sort((a, b) => b.fraction - a.fraction);

  for (let idx = 0; remaining > 0 && order.length > 0; idx = (idx + 1) % order.length) {
    fitted[order[idx].index] += 1;
    remaining -= 1;
  }

  return fitted;
}

export function positiveSize(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function fallbackColumns(
  splitColumns: string[][] | undefined,
  paneIds: string[],
): string[][] {
  return splitColumns && splitColumns.length > 0 ? splitColumns : [paneIds];
}

export function columnWidthsMatch(
  columns: string[][],
  columnWidths: number[] | undefined,
): boolean {
  return Boolean(
    columnWidths
      && columnWidths.length === columns.length
      && columnWidths.every((size) => positiveSize(size) !== null),
  );
}

export function rowHeightsMatch(
  columns: string[][],
  rowHeightsPerCol: number[][] | undefined,
): boolean {
  return Boolean(
    rowHeightsPerCol
      && rowHeightsPerCol.length === columns.length
      && rowHeightsPerCol.every((row, index) =>
        row.length === columns[index].length
        && row.every((size) => positiveSize(size) !== null),
      ),
  );
}

export function bestPreviousColumnIndex(
  nextColumn: string[],
  previousColumns: string[][],
  usedIndices: Set<number>,
): number {
  let bestIndex = -1;
  let bestOverlap = 0;
  for (let index = 0; index < previousColumns.length; index += 1) {
    if (usedIndices.has(index)) continue;
    const overlap = nextColumn.filter((paneId) => previousColumns[index].includes(paneId)).length;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function previousColumnIndicesForSurvivors(
  previousColumns: string[][],
  nextColumns: string[][],
): number[] | null {
  const previousPaneIds = new Set(previousColumns.flat());
  const usedIndices = new Set<number>();
  const previousIndices: number[] = [];

  for (const nextColumn of nextColumns) {
    const previousIndex = bestPreviousColumnIndex(nextColumn, previousColumns, usedIndices);
    if (
      previousIndex < 0
      || !nextColumn.every((paneId) =>
        previousColumns[previousIndex].includes(paneId) || !previousPaneIds.has(paneId),
      )
    ) {
      return null;
    }
    usedIndices.add(previousIndex);
    previousIndices.push(previousIndex);
  }

  return previousIndices;
}

export function columnsRequireBalancedWidths(
  previousColumns: string[][],
  nextColumns: string[][],
): boolean {
  return previousColumnIndicesForSurvivors(previousColumns, nextColumns) === null;
}

export function reconcileColumnWidths(
  previousColumns: string[][],
  previousWidths: number[] | undefined,
  nextColumns: string[][],
): number[] | undefined {
  if (nextColumns.length === 0) return undefined;
  const previousIndices = previousColumnIndicesForSurvivors(previousColumns, nextColumns);
  if (!previousIndices) {
    return nextColumns.map(() => DEFAULT_LAYOUT_SIZE);
  }

  const survivorWidths = previousIndices.map((previousIndex) =>
    positiveSize(previousWidths?.[previousIndex]),
  );
  if (survivorWidths.some((size) => size === null)) {
    return nextColumns.map(() => DEFAULT_LAYOUT_SIZE);
  }
  return survivorWidths as number[];
}

export function reconcileRowHeightsPerCol(
  previousColumns: string[][],
  previousRows: number[][] | undefined,
  nextColumns: string[][],
): number[][] | undefined {
  if (nextColumns.length === 0) return undefined;
  const usedIndices = new Set<number>();

  return nextColumns.map((nextColumn) => {
    const previousIndex = bestPreviousColumnIndex(nextColumn, previousColumns, usedIndices);
    const previousColumn = previousColumns[previousIndex];
    if (
      previousIndex >= 0
      && nextColumn.every((paneId) => previousColumn.includes(paneId))
    ) {
      usedIndices.add(previousIndex);
      const previousHeights = previousRows?.[previousIndex];
      if (previousHeights && previousHeights.length === previousColumn.length) {
        const survivorHeights = nextColumn.map((paneId) =>
          positiveSize(previousHeights[previousColumn.indexOf(paneId)]),
        );
        if (survivorHeights.every((size) => size !== null)) {
          return survivorHeights as number[];
        }
      }
    }
    return nextColumn.map(() => DEFAULT_LAYOUT_SIZE);
  });
}

export interface ReconciledLayoutMetrics {
  columnWidths: number[] | undefined;
  rowHeightsPerCol: number[][] | undefined;
}

export function reconcileLayoutMetrics(
  previousColumns: string[][],
  previousWidths: number[] | undefined,
  previousRows: number[][] | undefined,
  nextColumns: string[][] | undefined,
  resetLayoutMetrics: boolean,
): ReconciledLayoutMetrics | undefined {
  if (!resetLayoutMetrics) return undefined;
  if (!nextColumns || nextColumns.length === 0) {
    return { columnWidths: undefined, rowHeightsPerCol: undefined };
  }
  return {
    columnWidths: reconcileColumnWidths(previousColumns, previousWidths, nextColumns),
    rowHeightsPerCol: reconcileRowHeightsPerCol(previousColumns, previousRows, nextColumns),
  };
}
