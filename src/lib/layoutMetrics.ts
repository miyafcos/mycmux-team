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

/**
 * Widths for a layout whose columns did not survive one-to-one — a split, or a
 * pane moved between columns. A new column is cut out of the column it was
 * dropped against, so it takes half of that column's width and every other
 * column keeps the width the user dragged it to. Rebalancing all of them (what
 * this used to do) threw away the whole layout on every single split.
 *
 * Widths are relative — fitLayoutSizes normalises them against the viewport —
 * so the halves do not have to add up to anything in particular.
 */
function splitColumnWidths(
  previousColumns: string[][],
  previousWidths: number[] | undefined,
  nextColumns: string[][],
): number[] {
  const usedIndices = new Set<number>();
  const origins = nextColumns.map((column) => {
    const index = bestPreviousColumnIndex(column, previousColumns, usedIndices);
    if (index < 0) return null;
    usedIndices.add(index);
    return index;
  });
  // A column born from a split sits next to the column it was cut from, so it
  // inherits that neighbour's origin and the two then share its width.
  // ponytail: a column inserted between two others is charged to its left
  // neighbour — the layout alone cannot say which side it was cut from. Thread
  // the drop zone through from layoutMutation if that guess starts to matter.
  const inherited: (number | null)[] = [];
  for (let index = 0; index < origins.length; index += 1) {
    inherited.push(origins[index] ?? inherited[index - 1] ?? origins[index + 1] ?? null);
  }
  const shares = new Map<number, number>();
  for (const origin of inherited) {
    if (origin === null) continue;
    shares.set(origin, (shares.get(origin) ?? 0) + 1);
  }
  return inherited.map((origin) => {
    if (origin === null) return DEFAULT_LAYOUT_SIZE;
    const width = positiveSize(previousWidths?.[origin]) ?? DEFAULT_LAYOUT_SIZE;
    return width / (shares.get(origin) ?? 1);
  });
}

export function reconcileColumnWidths(
  previousColumns: string[][],
  previousWidths: number[] | undefined,
  nextColumns: string[][],
): number[] | undefined {
  if (nextColumns.length === 0) return undefined;
  const previousIndices = previousColumnIndicesForSurvivors(previousColumns, nextColumns);
  if (!previousIndices) {
    return splitColumnWidths(previousColumns, previousWidths, nextColumns);
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
