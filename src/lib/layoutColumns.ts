function cleanSplitColumns(columns: string[][]): string[][] {
  return columns
    .map((col) => col.filter(Boolean))
    .filter((col) => col.length > 0);
}

export function normalizeReadableSplitColumns(columns: string[][]): string[][] {
  return cleanSplitColumns(columns);
}
