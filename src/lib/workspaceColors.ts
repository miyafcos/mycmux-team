export const WORKSPACE_COLORS = [
  "#4f8cff",
  "#28b487",
  "#d39b2f",
  "#d95f7b",
  "#20a7b7",
  "#a56de2",
  "#e36f3f",
  "#6f9b2f",
] as const;

export function getWorkspaceColor(index: number): string {
  return WORKSPACE_COLORS[index % WORKSPACE_COLORS.length];
}
