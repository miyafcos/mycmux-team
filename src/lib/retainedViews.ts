import { useState } from "react";

export interface RetainedView {
  id: string;
  cost: number;
}

/** Active views win; only previously visited, still eligible views consume the LRU. */
export function retainViews(
  previous: readonly string[], active: readonly string[], available: readonly RetainedView[],
  maxCount: number, maxCost: number,
): string[] {
  const costs = new Map(available.map(view => [view.id, view.cost]));
  const pinned = [...new Set(active)].filter(id => costs.has(id));
  const next = pinned.slice();
  let cost = next.reduce((total, id) => total + (costs.get(id) ?? 0), 0);
  for (const id of [...previous].reverse()) {
    if (!costs.has(id) || next.includes(id)) continue;
    const extra = costs.get(id) ?? 0;
    if (next.length >= maxCount || cost + extra > maxCost) continue;
    next.unshift(id);
    cost += extra;
  }
  return next;
}

export function useRetainedViews(
  active: readonly string[], available: readonly RetainedView[], maxCount: number, maxCost: number,
): string[] {
  const [previous, setPrevious] = useState<string[]>([]);
  const next = retainViews(previous, active, available, maxCount, maxCost);
  // React retries this component before committing. An effect would commit an
  // obsolete extra workspace first, then mount/unmount and notify twice.
  if (next.length !== previous.length || next.some((id, index) => id !== previous[index])) {
    setPrevious(next);
  }
  return next;
}
