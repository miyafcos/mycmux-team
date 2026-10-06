import type { ProfileUsage } from "./ipc";
import { orderAccountRows, USAGE_DANGER_PCT } from "./accountRows";

export type AccountGroupId = "active" | "available" | "near_limit" | "limited" | "unverified";
export type AccountPanelGroup = {
  id: AccountGroupId;
  label: string;
  collapsible: boolean;
  rows: ProfileUsage[];
};

function percentage(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function generalLimits(row: ProfileUsage): number[] {
  return [percentage(row.five_hour?.pct), percentage(row.seven_day?.pct)]
    .filter((pct): pct is number => pct !== null);
}

export function accountLimitLabel(row: ProfileUsage): string | null {
  if (row.needs_relogin || (row.state !== "ok" && row.state !== "cooldown")) return null;
  const limits: string[] = [];
  if ((percentage(row.five_hour?.pct) ?? 0) >= 100) limits.push("5h制限");
  if ((percentage(row.seven_day?.pct) ?? 0) >= 100) limits.push("週間制限");
  let label = limits.join("・");
  if (!label && generalLimits(row).some((pct) => pct >= USAGE_DANGER_PCT)) label = "残量わずか";
  if (!label && [row.seven_day_sonnet?.pct, row.seven_day_opus?.pct,
    ...row.model_windows.map((model) => model.window.pct)]
    .some((pct) => (percentage(pct) ?? 0) >= 100)) label = "一部モデル制限";
  return label ? `${row.state === "cooldown" ? "前回値：" : ""}${label}` : null;
}

export function accountPanelGroup(row: ProfileUsage): AccountGroupId {
  if (row.is_active) return "active";
  if (row.needs_relogin || (row.state !== "ok" && row.state !== "cooldown")) return "unverified";
  const limits = generalLimits(row);
  if (limits.some((pct) => pct >= 100)) return "limited";
  // Last-known values during a failed refresh cannot establish availability.
  if (row.state !== "ok" || limits.length === 0) return "unverified";
  if (limits.some((pct) => pct >= USAGE_DANGER_PCT)) return "near_limit";
  return "available";
}

/** Stable provider/label order inside each group; never sort by changing percentages. */
export function groupAccountRows(rows: ProfileUsage[]): AccountPanelGroup[] {
  const groups: AccountPanelGroup[] = [
    { id: "active", label: "使用中", collapsible: false, rows: [] },
    { id: "available", label: "切替候補", collapsible: false, rows: [] },
    { id: "near_limit", label: "残量わずか", collapsible: true, rows: [] },
    { id: "limited", label: "制限中", collapsible: true, rows: [] },
    { id: "unverified", label: "確認が必要", collapsible: false, rows: [] },
  ];
  for (const row of orderAccountRows(rows)) {
    groups.find((group) => group.id === accountPanelGroup(row))!.rows.push(row);
  }
  return groups.filter((group) => group.rows.length > 0);
}
