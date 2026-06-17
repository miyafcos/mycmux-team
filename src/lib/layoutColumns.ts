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
