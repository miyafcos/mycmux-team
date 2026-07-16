function cleanSplitColumns(columns: string[][]): string[][] {
  return columns
    .map((col) => col.filter(Boolean))
    .filter((col) => col.length > 0);
}

export function normalizeReadableSplitColumns(columns: string[][]): string[][] {
  return cleanSplitColumns(columns);
}

export function reconcileSplitColumnsForPanes(
  columns: string[][] | undefined,
  paneIds: string[],
): string[][] {
  const allowedPaneIds = new Set(paneIds);
  const usedPaneIds = new Set<string>();
  const cleaned = cleanSplitColumns(columns ?? [])
    .map((col) => col.filter((paneId) => {
      if (!allowedPaneIds.has(paneId) || usedPaneIds.has(paneId)) return false;
      usedPaneIds.add(paneId);
      return true;
    }))
    .filter((col) => col.length > 0);

  const missingPaneIds = paneIds.filter((paneId) => !usedPaneIds.has(paneId));
  if (cleaned.length === 0) {
    return missingPaneIds.length > 0 ? [missingPaneIds] : [];
  }
  if (missingPaneIds.length > 0) {
    cleaned[cleaned.length - 1] = [...cleaned[cleaned.length - 1], ...missingPaneIds];
  }
  return cleaned;
}

export interface StableLayoutColumnIdentity {
  id: string;
  paneIds: string[];
}

/** Keep a column's React identity when its first pane is closed or moved. */
export function reconcileStableLayoutColumnIdentities(
  previous: StableLayoutColumnIdentity[],
  columns: string[][],
): StableLayoutColumnIdentity[] {
  const candidates: Array<{
    currentIndex: number;
    previousIndex: number;
    overlap: number;
    previousRetention: number;
    currentRetention: number;
  }> = [];

  columns.forEach((column, currentIndex) => {
    const currentPaneIds = new Set(column);
    previous.forEach((entry, previousIndex) => {
      const overlap = entry.paneIds.reduce(
        (count, paneId) => count + Number(currentPaneIds.has(paneId)),
        0,
      );
      if (overlap === 0) return;
      candidates.push({
        currentIndex,
        previousIndex,
        overlap,
        previousRetention: overlap / Math.max(1, entry.paneIds.length),
        currentRetention: overlap / Math.max(1, column.length),
      });
    });
  });

  candidates.sort((left, right) => (
    right.overlap - left.overlap
    || right.previousRetention - left.previousRetention
    || right.currentRetention - left.currentRetention
    || left.currentIndex - right.currentIndex
    || left.previousIndex - right.previousIndex
  ));

  const assignedCurrent = new Map<number, number>();
  const assignedPrevious = new Set<number>();
  for (const candidate of candidates) {
    if (assignedCurrent.has(candidate.currentIndex) || assignedPrevious.has(candidate.previousIndex)) {
      continue;
    }
    assignedCurrent.set(candidate.currentIndex, candidate.previousIndex);
    assignedPrevious.add(candidate.previousIndex);
  }

  const reservedIds = new Set(previous.map((entry) => entry.id));
  const usedIds = new Set<string>();
  return columns.map((paneIds, currentIndex) => {
    const previousIndex = assignedCurrent.get(currentIndex);
    if (previousIndex !== undefined) {
      const id = previous[previousIndex].id;
      usedIds.add(id);
      return { id, paneIds: [...paneIds] };
    }

    const base = `column-${paneIds[0] ?? currentIndex}`;
    let id = base;
    let suffix = 2;
    while (reservedIds.has(id) || usedIds.has(id)) {
      id = `${base}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(id);
    return { id, paneIds: [...paneIds] };
  });
}
