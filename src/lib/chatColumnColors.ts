/** Slot colors for dashboard chat columns (index 0–4). */

export const CHAT_COLUMN_COLORS = [
  "#e8c547",
  "#2ec4b6",
  "#9b7ef0",
  "#e85a4f",
  "#d65fd0",
] as const;

export function chatColumnColor(index: number): string | undefined {
  if (!Number.isInteger(index) || index < 0 || index >= CHAT_COLUMN_COLORS.length) {
    return undefined;
  }
  return CHAT_COLUMN_COLORS[index];
}
