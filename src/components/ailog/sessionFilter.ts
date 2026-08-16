/**
 * Client-side sorting, filtering and paging for the session list.
 *
 * The list is driven from the single capped fetch the dashboard already makes
 * for the relation diagram, so changing sort or page never costs a round trip.
 * When the cap actually bites, the panel says how many rows are missing instead
 * of pretending the list is complete.
 */

import type { SessionRow } from "../../lib/ailog";
import type { SessionSort } from "../../stores/ailogStore";

export type LeafDimension = "project" | "title";
export const UNKNOWN_PROJECT = "(unknown)";
export const UNTITLED = "(untitled)";
export const UNSUMMARIZED_KEY = "__unsummarized__";

export function sortSessions(rows: SessionRow[], sort: SessionSort): SessionRow[] {
  const copy = [...rows];
  switch (sort) {
    case "rework":
      copy.sort((a, b) => b.reworkScore - a.reworkScore || b.costUsd - a.costUsd);
      break;
    case "recent":
      copy.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
      break;
    case "turns":
      copy.sort((a, b) => b.turnCount - a.turnCount || b.costUsd - a.costUsd);
      break;
    default:
      copy.sort((a, b) => b.costUsd - a.costUsd);
  }
  return copy;
}

export interface SessionPage {
  rows: SessionRow[];
  total: number;
  pageCount: number;
  page: number;
  from: number;
  to: number;
}

export function pageSessions(rows: SessionRow[], page: number, pageSize: number): SessionPage {
  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const clamped = Math.min(Math.max(0, page), pageCount - 1);
  const start = clamped * pageSize;
  const slice = rows.slice(start, start + pageSize);
  return {
    rows: slice,
    total,
    pageCount,
    page: clamped,
    from: total === 0 ? 0 : start + 1,
    to: start + slice.length,
  };
}
