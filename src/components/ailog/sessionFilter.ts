/**
 * Client-side sorting, filtering and paging for the session list.
 *
 * The list is driven from the single capped fetch the dashboard already makes
 * for the relation diagram, so changing sort or page never costs a round trip.
 * When the cap actually bites, the panel says how many rows are missing instead
 * of pretending the list is complete.
 */

import type { SessionRow } from "../../lib/ailog";
import type { AilogSelection, SessionSort } from "../../stores/ailogStore";
import { UNKNOWN_PROJECT, UNTITLED, type LeafDimension } from "./sankeyModel";
import { UNSUMMARIZED_KEY } from "./sankeyModel";

export function sortSessions(rows: SessionRow[], sort: SessionSort): SessionRow[] {
  const copy = [...rows];
  switch (sort) {
    case "rework":
      copy.sort((a, b) => b.reworkScore - a.reworkScore || b.costUsd - a.costUsd);
      break;
    case "recent":
      copy.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
      break;
    default:
      copy.sort((a, b) => b.costUsd - a.costUsd);
  }
  return copy;
}

/**
 * Apply the clicked node to the list. Model and project selections have already
 * narrowed the backend query, so re-filtering them here would be a no-op; only
 * the selections the backend cannot express are applied.
 */
export function filterSessions(
  rows: SessionRow[],
  selection: AilogSelection | null,
  leafDimension: LeafDimension,
): SessionRow[] {
  if (!selection) return rows;
  if (selection.type === "tag") {
    return rows.filter((row) => row.workTags.includes(selection.key));
  }
  if (selection.type === "topic") {
    return rows.filter((row) => (row.goalCluster?.trim() || UNSUMMARIZED_KEY) === selection.key);
  }
  if (selection.type === "leaf" && leafDimension === "title") {
    return rows.filter((row) => (row.title?.trim() || UNTITLED) === selection.key);
  }
  if (selection.type === "leaf" || selection.type === "project") {
    return rows.filter((row) => (row.projectLabel?.trim() || UNKNOWN_PROJECT) === selection.key);
  }
  return rows;
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
