/**
 * Client-side sorting, filtering and paging for the session list.
 *
 * The list is driven from the single capped fetch the dashboard already makes
 * for the relation diagram, so changing sort or page never costs a round trip.
 * When the cap actually bites, the panel says how many rows are missing instead
 * of pretending the list is complete.
 */

import type { SessionRow } from "../../lib/ailog";

export interface SessionPage {
  rows: SessionRow[];
  total: number;
  pageCount: number;
  page: number;
  from: number;
  to: number;
}
