export const DEFAULT_LAYOUT_SIZE = 1;

function positiveLayoutSizes(sizes: readonly number[] | undefined, itemCount: number): number[] | null {
  if (!sizes || sizes.length !== itemCount) return null;
  const cleaned = sizes.map((size) =>
    typeof size === "number" && Number.isFinite(size) && size > 0 ? size : null,
  );
  return cleaned.every((size): size is number => size !== null) ? cleaned : null;
}

/**
 * Sizes good enough to read divider positions off. A pane dragged shut is a
 * real state (minSize is 0), and where the dividers sit is still perfectly
 * well defined around it, so a zero is allowed here as long as the axis has
 * some width in total.
 */
function sizesForPositions(sizes: readonly number[] | undefined, itemCount: number): number[] | null {
  if (!sizes || sizes.length !== itemCount) return null;
  if (!sizes.every((size) => typeof size === "number" && Number.isFinite(size) && size >= 0)) {
    return null;
  }
  const total = sizes.reduce((sum, size) => sum + size, 0);
  return total > 0 ? [...sizes] : null;
}

export function fitLayoutSizes(
  sizes: number[] | undefined,
  availableSize: number,
  itemCount: number,
): number[] | undefined {
  const fitSize = Math.floor(availableSize);
  if (itemCount <= 0 || fitSize <= 0) return undefined;

  const source = positiveLayoutSizes(sizes, itemCount) ?? Array.from({ length: itemCount }, () => 1);
  const total = source.reduce((sum, size) => sum + size, 0);
  if (total <= 0) return undefined;

  const rawSizes = source.map((size) => (size / total) * fitSize);
  const fitted = rawSizes.map((size) => Math.floor(size));
  let remaining = fitSize - fitted.reduce((sum, size) => sum + size, 0);
  const order = rawSizes
    .map((size, index) => ({ index, fraction: size - Math.floor(size) }))
    .sort((a, b) => b.fraction - a.fraction);

  for (let idx = 0; remaining > 0 && order.length > 0; idx = (idx + 1) % order.length) {
    fitted[order[idx].index] += 1;
    remaining -= 1;
  }

  return fitted;
}

export function positiveSize(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function fallbackColumns(
  splitColumns: string[][] | undefined,
  paneIds: string[],
): string[][] {
  return splitColumns && splitColumns.length > 0 ? splitColumns : [paneIds];
}

export function columnWidthsMatch(
  columns: string[][],
  columnWidths: number[] | undefined,
): boolean {
  return Boolean(
    columnWidths
      && columnWidths.length === columns.length
      && columnWidths.every((size) => positiveSize(size) !== null),
  );
}

export function rowHeightsMatch(
  columns: string[][],
  rowHeightsPerCol: number[][] | undefined,
): boolean {
  return Boolean(
    rowHeightsPerCol
      && rowHeightsPerCol.length === columns.length
      && rowHeightsPerCol.every((row, index) =>
        row.length === columns[index].length
        && row.every((size) => positiveSize(size) !== null),
      ),
  );
}

/* -------------------------------------------------------------------------
 * Divider pins
 *
 * A layout axis is a row of columns (outer) or a stack of panes inside one
 * column (inner). Between two neighbours sits a divider. The user can drag a
 * divider, and only those dragged dividers remember where they are: their
 * position, as a fraction of the whole axis, is kept through every later
 * split and close. Every other divider owns no position at all and is spread
 * evenly between its pinned neighbours (or the ends of the axis) whenever the
 * axis gains or loses an item.
 *
 * Sizes stay relative, as they always were. The functions here normalise them
 * so one axis adds up to 1, which is what makes "the divider sits at 0.7"
 * meaningful; fitLayoutSizes turns that back into pixels for allotment.
 * ---------------------------------------------------------------------- */

/** Dividers sit between items, so an axis of n items owns n - 1 of them. */
function dividerCount(itemCount: number): number {
  return Math.max(0, itemCount - 1);
}

function dividerPinsMatch(itemCount: number, pins: readonly boolean[] | undefined): boolean {
  return Boolean(
    pins
      && pins.length === dividerCount(itemCount)
      && pins.every((pin) => typeof pin === "boolean"),
  );
}

export function columnDividerPinsMatch(
  columns: string[][],
  columnDividerPins: boolean[] | undefined,
): boolean {
  return dividerPinsMatch(columns.length, columnDividerPins);
}

export function rowDividerPinsMatch(
  columns: string[][],
  rowDividerPinsPerCol: boolean[][] | undefined,
): boolean {
  return Boolean(
    rowDividerPinsPerCol
      && rowDividerPinsPerCol.length === columns.length
      && rowDividerPinsPerCol.every((pins, index) => dividerPinsMatch(columns[index].length, pins)),
  );
}

/**
 * Saved pins are only believed when they describe exactly this many items.
 * Anything else — absent (every workspace saved before 2026-09-16), the wrong
 * length, a non-boolean — reads as "nothing was ever dragged here".
 */
export function normalizeDividerPins(
  pins: readonly boolean[] | undefined,
  itemCount: number,
): boolean[] {
  return dividerPinsMatch(itemCount, pins)
    ? [...(pins as readonly boolean[])]
    : new Array<boolean>(dividerCount(itemCount)).fill(false);
}

/** Relative sizes plus the pin state of every divider between them. */
export interface AxisMetrics {
  /** Relative sizes, normalised so the axis adds up to 1. */
  sizes: number[];
  /** One flag per divider, `true` once the user has dragged it. */
  pins: boolean[];
}

interface AxisState extends AxisMetrics {
  ids: string[];
}

/** Where a newly inserted item was cut from, when the caller knows it. */
export interface AxisInsertHint {
  insertedId: string;
  sourceId: string;
  side: "before" | "after";
}

/** The pane-level form of the same hint, threaded in from the split actions. */
export interface SplitInsertHint {
  insertedPaneId: string;
  sourcePaneId: string;
  side: "before" | "after";
}

/** Divider positions: the running share of the axis consumed before each one. */
function axisPositions(sizes: readonly number[]): number[] {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  const positions: number[] = [];
  let consumed = 0;
  for (let index = 0; index < sizes.length - 1; index += 1) {
    consumed += sizes[index] / total;
    positions.push(consumed);
  }
  return positions;
}

function sizesFromPositions(positions: readonly number[]): number[] {
  const sizes: number[] = [];
  let previous = 0;
  for (const position of positions) {
    sizes.push(position - previous);
    previous = position;
  }
  sizes.push(1 - previous);
  return sizes;
}

/** Pinned dividers stay put; the free ones divide each gap between them evenly. */
function spreadFreeDividers(
  pinnedPositions: readonly (number | null)[],
  pins: readonly boolean[],
): number[] {
  const count = pins.length;
  const positions = new Array<number>(count).fill(0);
  let start = 0;
  let startIndex = -1;
  for (let index = 0; index <= count; index += 1) {
    if (index !== count && !pins[index]) continue;
    const end = index === count ? 1 : (pinnedPositions[index] as number);
    const free = index - startIndex - 1;
    for (let step = 1; step <= free; step += 1) {
      positions[startIndex + step] = start + ((end - start) * step) / (free + 1);
    }
    if (index < count) positions[index] = end;
    start = end;
    startIndex = index;
  }
  return positions;
}

/** Unpin the nearest pinned divider on each side of an item that lost its room. */
function unpinAround(itemIndex: number, pins: boolean[]): boolean {
  let changed = false;
  for (let left = itemIndex - 1; left >= 0; left -= 1) {
    if (!pins[left]) continue;
    pins[left] = false;
    changed = true;
    break;
  }
  for (let right = itemIndex; right < pins.length; right += 1) {
    if (!pins[right]) continue;
    pins[right] = false;
    changed = true;
    break;
  }
  return changed;
}

/**
 * Lay the axis out from the positions the pinned dividers remember.
 *
 * A remembered position only survives while it is strictly inside the axis and
 * strictly after the pinned divider before it; a pin that breaks either rule is
 * dropped (it can only have come from data nobody can honour). Should the
 * result still leave an item with no room, the pins bounding that item are
 * dropped too and the axis is laid out again. Beyond that there is no minimum
 * size — dragging a divider to the very edge is allowed, and a double click
 * puts the axis back.
 */
export function settleAxis(
  positions: readonly (number | null)[],
  pins: readonly boolean[],
): AxisMetrics {
  const settledPins = [...pins];
  const pinned: (number | null)[] = settledPins.map((pin, index) => {
    const position = positions[index];
    return pin && typeof position === "number" && Number.isFinite(position) ? position : null;
  });

  let previous = 0;
  for (let index = 0; index < settledPins.length; index += 1) {
    if (!settledPins[index]) continue;
    const position = pinned[index];
    if (position === null || position <= previous || position >= 1) {
      settledPins[index] = false;
      pinned[index] = null;
      continue;
    }
    previous = position;
  }

  let sizes = sizesFromPositions(spreadFreeDividers(pinned, settledPins));
  for (let guard = 0; guard <= settledPins.length; guard += 1) {
    const starved = sizes.findIndex((size) => size <= 0);
    if (starved < 0) break;
    if (!unpinAround(starved, settledPins)) break;
    for (let index = 0; index < settledPins.length; index += 1) {
      if (!settledPins[index]) pinned[index] = null;
    }
    sizes = sizesFromPositions(spreadFreeDividers(pinned, settledPins));
  }

  return { sizes, pins: settledPins };
}

/** An axis nobody has dragged: every divider free, every item the same size. */
export function balancedAxis(itemCount: number): AxisMetrics {
  if (itemCount <= 0) return { sizes: [], pins: [] };
  const count = dividerCount(itemCount);
  return settleAxis(new Array<null>(count).fill(null), new Array<boolean>(count).fill(false));
}

function axisStateFrom(
  ids: readonly string[],
  sizes: readonly number[] | undefined,
  pins: readonly boolean[] | undefined,
): AxisState {
  const usable = positiveLayoutSizes(sizes, ids.length);
  // Without believable sizes there are no remembered positions either, so the
  // pins would point at nothing.
  if (!usable) return { ids: [...ids], ...balancedAxis(ids.length) };
  const total = usable.reduce((sum, size) => sum + size, 0);
  return {
    ids: [...ids],
    sizes: usable.map((size) => size / total),
    pins: normalizeDividerPins(pins, ids.length),
  };
}

function relayoutAxis(
  ids: string[],
  positions: readonly (number | null)[],
  pins: readonly boolean[],
): AxisState {
  if (ids.length === 0) return { ids, sizes: [], pins: [] };
  return { ids, ...settleAxis(positions, pins) };
}

/**
 * Insert `insertedId` next to `sourceId`. The divider that used to separate the
 * source from the neighbour on that side becomes the divider between the new
 * item and that same neighbour, keeping both its position and its pin; the
 * divider born between the source and the new item is free.
 */
function insertIntoAxis(
  axis: AxisState,
  sourceId: string,
  insertedId: string,
  side: "before" | "after",
): AxisState {
  const sourceIndex = axis.ids.indexOf(sourceId);
  if (sourceIndex < 0) return axis;
  const ids = [...axis.ids];
  ids.splice(side === "after" ? sourceIndex + 1 : sourceIndex, 0, insertedId);
  const pins = [...axis.pins];
  pins.splice(sourceIndex, 0, false);
  const positions: (number | null)[] = axisPositions(axis.sizes);
  positions.splice(sourceIndex, 0, null);
  return relayoutAxis(ids, positions, pins);
}

/**
 * Drop `removedId`. An end item takes its one divider with it. An item in the
 * middle leaves its two dividers to merge: the merged divider keeps the
 * position of whichever side was pinned, and is free when both sides agreed
 * (neither pinned, or both — two remembered positions cannot be merged into
 * one, so the axis forgets them).
 */
function removeFromAxis(axis: AxisState, removedId: string): AxisState {
  const removedIndex = axis.ids.indexOf(removedId);
  if (removedIndex < 0) return axis;
  const itemCount = axis.ids.length;
  const ids = axis.ids.filter((id) => id !== removedId);
  if (ids.length === 0) return { ids, sizes: [], pins: [] };
  const pins = [...axis.pins];
  const positions: (number | null)[] = axisPositions(axis.sizes);
  if (removedIndex === 0) {
    pins.splice(0, 1);
    positions.splice(0, 1);
  } else if (removedIndex === itemCount - 1) {
    pins.splice(removedIndex - 1, 1);
    positions.splice(removedIndex - 1, 1);
  } else {
    const leftPinned = axis.pins[removedIndex - 1];
    const rightPinned = axis.pins[removedIndex];
    const merged = leftPinned !== rightPinned;
    const position = leftPinned ? positions[removedIndex - 1] : positions[removedIndex];
    pins.splice(removedIndex - 1, 2, merged);
    positions.splice(removedIndex - 1, 2, merged ? position : null);
  }
  return relayoutAxis(ids, positions, pins);
}

function settleAxisState(axis: AxisState): AxisMetrics {
  const positions = axisPositions(axis.sizes);
  return settleAxis(positions.map((position, index) => (axis.pins[index] ? position : null)), axis.pins);
}

function resolveInsertPlacement(
  axis: AxisState,
  nextIds: readonly string[],
  index: number,
  hint: AxisInsertHint | undefined,
): { sourceId: string; side: "before" | "after" } | null {
  const insertedId = nextIds[index];
  if (hint && hint.insertedId === insertedId && axis.ids.includes(hint.sourceId)) {
    return { sourceId: hint.sourceId, side: hint.side };
  }
  // No hint: charge the new item to the neighbour before it, exactly as the
  // pre-2026-09-16 width guess did, and fall back to the one after it when the
  // new item leads the axis.
  for (let before = index - 1; before >= 0; before -= 1) {
    if (axis.ids.includes(nextIds[before])) return { sourceId: nextIds[before], side: "after" };
  }
  for (let after = index + 1; after < nextIds.length; after += 1) {
    if (axis.ids.includes(nextIds[after])) return { sourceId: nextIds[after], side: "before" };
  }
  return null;
}

/**
 * Carry one axis across a structural change by matching items by identity.
 *
 * Survivors whose relative order changed carry nothing — a remembered position
 * says where a divider is, and reordering the items around it makes that
 * meaningless. Otherwise the removals are replayed in the old order and the
 * insertions in the new one, so the pins land where the operations put them.
 */
export function reconcileAxisMetrics(
  previousIds: readonly string[],
  previousSizes: readonly number[] | undefined,
  previousPins: readonly boolean[] | undefined,
  nextIds: readonly string[],
  hint?: AxisInsertHint,
): AxisMetrics {
  if (nextIds.length === 0) return { sizes: [], pins: [] };
  // Nothing was added or dropped here, so nothing is rebalanced: an axis is
  // only evened out by a split, a close, a drag or a double click on one of its
  // own dividers. This is what lets a workspace saved before 2026-09-16 keep
  // its widths until the user next splits or closes along that axis.
  const unchanged = previousIds.length === nextIds.length
    && previousIds.every((id, index) => id === nextIds[index]);
  if (unchanged) {
    const usable = positiveLayoutSizes(previousSizes, nextIds.length);
    return usable
      ? { sizes: [...usable], pins: normalizeDividerPins(previousPins, nextIds.length) }
      : balancedAxis(nextIds.length);
  }
  const previousSet = new Set(previousIds);
  const nextSet = new Set(nextIds);
  const survivors = nextIds.filter((id) => previousSet.has(id));
  if (survivors.length === 0) return balancedAxis(nextIds.length);
  const survivorsInPreviousOrder = previousIds.filter((id) => nextSet.has(id));
  if (survivorsInPreviousOrder.join("\0") !== survivors.join("\0")) {
    return balancedAxis(nextIds.length);
  }

  let axis = axisStateFrom(previousIds, previousSizes, previousPins);
  for (const id of previousIds) {
    if (!nextSet.has(id)) axis = removeFromAxis(axis, id);
  }
  for (let index = 0; index < nextIds.length; index += 1) {
    if (previousSet.has(nextIds[index])) continue;
    const placement = resolveInsertPlacement(axis, nextIds, index, hint);
    if (!placement) continue;
    axis = insertIntoAxis(axis, placement.sourceId, nextIds[index], placement.side);
  }
  return settleAxisState(axis);
}

/**
 * The axis as the user just left it: every divider that moved by a pixel or
 * more is now pinned, and the free ones are immediately spread again.
 * `previousSizes` and `draggedSizes` may be in different units — only the
 * pixel total of `draggedSizes` decides what counts as movement.
 */
export function applyAxisDrag(
  previousSizes: readonly number[],
  draggedSizes: readonly number[],
  pins: readonly boolean[] | undefined,
): AxisMetrics {
  const dragged = sizesForPositions(draggedSizes, draggedSizes.length);
  if (!dragged) return balancedAxis(draggedSizes.length);
  const after = axisPositions(dragged);
  const previous = sizesForPositions(previousSizes, draggedSizes.length);
  const before = previous ? axisPositions(previous) : after;
  const total = dragged.reduce((sum, size) => sum + size, 0);
  const moved = after.map((position, index) =>
    Math.abs(position - before[index]) * total >= 1,
  );

  // Panes may be dragged shut (minSize is 0), and an axis holding a shut pane
  // has no room to spread anything into: evening out the free dividers would
  // move panes the pointer never touched, and re-opening the shut one is not
  // this function's call. So the axis is handed back exactly as the drag left
  // it, and only the dividers that both moved and still sit inside the axis
  // are remembered — a divider sitting on the very edge has no position worth
  // keeping.
  if (dragged.some((size) => size <= 0)) {
    return {
      sizes: dragged.map((size) => size / total),
      pins: after.map((position, index) => (
        (Boolean(pins?.[index]) || moved[index]) && position > 0 && position < 1
      )),
    };
  }

  const nextPins = after.map((_position, index) => Boolean(pins?.[index]) || moved[index]);
  return settleAxis(after.map((position, index) => (nextPins[index] ? position : null)), nextPins);
}

export function bestPreviousColumnIndex(
  nextColumn: string[],
  previousColumns: string[][],
  usedIndices: Set<number>,
): number {
  let bestIndex = -1;
  let bestOverlap = 0;
  for (let index = 0; index < previousColumns.length; index += 1) {
    if (usedIndices.has(index)) continue;
    const overlap = nextColumn.filter((paneId) => previousColumns[index].includes(paneId)).length;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestIndex = index;
    }
  }
  return bestIndex;
}

/** Columns have no stable id, so each one is matched by the panes it kept. */
function previousColumnOrigins(
  previousColumns: string[][],
  nextColumns: string[][],
): (number | null)[] {
  const usedIndices = new Set<number>();
  return nextColumns.map((column) => {
    const index = bestPreviousColumnIndex(column, previousColumns, usedIndices);
    if (index < 0) return null;
    usedIndices.add(index);
    return index;
  });
}

function columnInsertHint(
  nextColumns: string[][],
  nextIds: readonly string[],
  hint: SplitInsertHint | undefined,
): AxisInsertHint | undefined {
  if (!hint) return undefined;
  const insertedIndex = nextColumns.findIndex((column) => column.includes(hint.insertedPaneId));
  const sourceIndex = nextColumns.findIndex((column) => column.includes(hint.sourcePaneId));
  if (insertedIndex < 0 || sourceIndex < 0 || insertedIndex === sourceIndex) return undefined;
  return { insertedId: nextIds[insertedIndex], sourceId: nextIds[sourceIndex], side: hint.side };
}

function rowInsertHint(
  nextColumn: string[],
  hint: SplitInsertHint | undefined,
): AxisInsertHint | undefined {
  if (!hint) return undefined;
  if (!nextColumn.includes(hint.insertedPaneId) || !nextColumn.includes(hint.sourcePaneId)) {
    return undefined;
  }
  return { insertedId: hint.insertedPaneId, sourceId: hint.sourcePaneId, side: hint.side };
}

export interface SplitLayoutMetricsSource {
  columnWidths?: number[];
  rowHeightsPerCol?: number[][];
  columnDividerPins?: boolean[];
  rowDividerPinsPerCol?: boolean[][];
}

export interface ReconciledLayoutMetrics {
  columnWidths: number[] | undefined;
  rowHeightsPerCol: number[][] | undefined;
  columnDividerPins: boolean[] | undefined;
  rowDividerPinsPerCol: boolean[][] | undefined;
}

/**
 * Carry both axes of a workspace across a structural change. Columns are
 * matched to their predecessor by overlapping panes; rows are matched inside
 * each of those pairs by pane id. A column with no predecessor is brand new, so
 * its rows start balanced with nothing remembered.
 */
export function reconcileSplitLayoutMetrics(
  previousColumns: string[][],
  previous: SplitLayoutMetricsSource,
  nextColumns: string[][],
  hint?: SplitInsertHint,
): ReconciledLayoutMetrics {
  if (nextColumns.length === 0) {
    return {
      columnWidths: undefined,
      rowHeightsPerCol: undefined,
      columnDividerPins: undefined,
      rowDividerPinsPerCol: undefined,
    };
  }

  const origins = previousColumnOrigins(previousColumns, nextColumns);
  const previousIds = previousColumns.map((_column, index) => `column:${index}`);
  const nextIds = origins.map((origin, index) =>
    origin === null ? `inserted:${index}` : `column:${origin}`,
  );
  const columns = reconcileAxisMetrics(
    previousIds,
    previous.columnWidths,
    previous.columnDividerPins,
    nextIds,
    columnInsertHint(nextColumns, nextIds, hint),
  );

  const rows = nextColumns.map((nextColumn, index) => {
    const origin = origins[index];
    return reconcileAxisMetrics(
      origin === null ? [] : previousColumns[origin],
      origin === null ? undefined : previous.rowHeightsPerCol?.[origin],
      origin === null ? undefined : previous.rowDividerPinsPerCol?.[origin],
      nextColumn,
      rowInsertHint(nextColumn, hint),
    );
  });

  return {
    columnWidths: columns.sizes,
    rowHeightsPerCol: rows.map((row) => row.sizes),
    columnDividerPins: columns.pins,
    rowDividerPinsPerCol: rows.map((row) => row.pins),
  };
}

export function reconcileLayoutMetrics(
  previousColumns: string[][],
  previous: SplitLayoutMetricsSource,
  nextColumns: string[][] | undefined,
  resetLayoutMetrics: boolean,
  hint?: SplitInsertHint,
): ReconciledLayoutMetrics | undefined {
  if (!resetLayoutMetrics) return undefined;
  if (!nextColumns || nextColumns.length === 0) {
    return {
      columnWidths: undefined,
      rowHeightsPerCol: undefined,
      columnDividerPins: undefined,
      rowDividerPinsPerCol: undefined,
    };
  }
  return reconcileSplitLayoutMetrics(previousColumns, previous, nextColumns, hint);
}
