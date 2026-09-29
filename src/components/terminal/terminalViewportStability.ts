/**
 * Keeping an agent pane's conversation still while the pane changes size.
 *
 * On Windows a resize is confirmed locally before the shell repaints. xterm
 * reflows the buffer the moment `fit()` runs, but under the ConPTY backend a
 * taller terminal gets its new rows pushed in *below* the existing text --
 * conhost is expected to reprint rather than pull scrollback down -- and a width
 * change re-wraps every line. Either way what is on screen for the next frame or
 * two is neither the old layout nor the settled one.
 *
 * Measured against recorded conhost output for a real Claude Code session in a
 * 100x30 pane: growing to 100x40 left the prompt 12 rows above the bottom until
 * a 7 KB reprint arrived, and 100x45 left it 16 rows above until an 8 KB reprint
 * arrived; both settled back to the bottom row afterwards. Narrowing to 70
 * columns did not lift the prompt, but re-wrapped every line above it and drew
 * an 18 KB reprint over the result.
 *
 * The decisions live here, away from XTermWrapper, so they can be tested without
 * mounting a terminal.
 */

/**
 * How long output has to stay quiet before the repaint counts as finished. The
 * shell's answer to a resize is several kilobytes and arrives split across
 * writes, so revealing on the first one would show a half-drawn frame -- the
 * thing the hold exists to prevent. Roughly two frames: long enough to bridge
 * the pieces of one repaint, short enough not to read as lag.
 */
export const REPAINT_HOLD_SETTLE_MS = 32;

/**
 * How long the pane may stay hidden waiting for one repaint. A live agent
 * answers a resize within a frame or two; this is the backstop for a pane whose
 * process is gone, wedged, or streaming so steadily that output never falls
 * quiet.
 */
export const REPAINT_HOLD_MAX_MS = 180;

/**
 * A ceiling on the whole hold, however many resizes arrive back to back. Layout
 * animations and a fast series of switches each re-arm the wait, and a pane that
 * stayed hidden for all of them would read as broken rather than smooth.
 */
export const REPAINT_HOLD_TOTAL_MAX_MS = 360;

/**
 * A size change this soon after the previous one is part of a stream -- someone
 * dragging a divider -- rather than a discrete switch.
 *
 * This matters because the resize path is debounced: while a drag is in motion
 * no fit runs at all, and the moment it stutters one fit lands carrying the
 * whole accumulated delta. That delta looks exactly like a workspace switch, so
 * size thresholds alone cannot tell the two apart and a stuttering drag would
 * blink the pane at every pause. Elapsed time can.
 */
export const REPAINT_HOLD_STREAM_MS = 250;

export interface RepaintHoldDeadlineInput {
  now: number;
  /** When the outstanding hold was first taken. Ignored when there is none. */
  holdStartedAt: number;
  hasOutstandingHold: boolean;
}

/**
 * When the pane must be shown again, whatever the shell is doing.
 *
 * Every resize re-arms the wait for its own repaint, so a run of them would
 * otherwise keep pushing the reveal further out. The ceiling is measured from
 * the first hold of the run, not the latest resize, which bounds how long a pane
 * can stay hidden no matter how many arrive. A deadline already in the past
 * means reveal now.
 */
export function resolveRepaintHoldDeadline(input: RepaintHoldDeadlineInput): number {
  const startedAt = input.hasOutstandingHold ? input.holdStartedAt : input.now;
  return Math.min(
    input.now + REPAINT_HOLD_MAX_MS,
    startedAt + REPAINT_HOLD_TOTAL_MAX_MS,
  );
}

/**
 * A drag of a pane divider is direct manipulation: motion is the point, and
 * blanking the pane mid-drag would be worse than the reflow. A discrete jump --
 * switching workspaces, toggling zoom, applying a layout -- moves the geometry
 * far enough that the shell's answer is a whole new frame, and that is the
 * transition worth covering.
 *
 * The size thresholds are a heuristic, not a measurement: they only separate
 * "one notch" from "a different layout". The stream window is what actually
 * keeps drags out, since a stuttering drag can accumulate a large delta.
 */
export const REPAINT_HOLD_MIN_ROW_DELTA = 2;
export const REPAINT_HOLD_MIN_COL_DELTA = 4;

export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface RepaintHoldInput {
  isAgentTuiPane: boolean;
  previous: TerminalSize;
  next: TerminalSize;
  /**
   * Milliseconds since this pane last changed size. `null` when it has not
   * changed size during this mount.
   */
  msSinceLastSizeChange: number | null;
}

/**
 * Whether to hide the pane until the shell has repainted at the new size.
 *
 * Only agent TUIs benefit: they paint a fixed bar on the bottom rows, so the gap
 * between the local reflow and the repaint is plainly visible. A plain shell
 * just has its last output line move, which nobody notices.
 */
export function shouldHoldRepaint(input: RepaintHoldInput): boolean {
  if (!input.isAgentTuiPane) return false;
  const { previous, next } = input;
  // An unmeasured terminal (-1) is a cold start, not a transition to cover.
  if (previous.cols <= 0 || previous.rows <= 0) return false;
  if (next.cols <= 0 || next.rows <= 0) return false;
  if (
    input.msSinceLastSizeChange !== null
    && input.msSinceLastSizeChange < REPAINT_HOLD_STREAM_MS
  ) {
    return false;
  }
  const rowDelta = Math.abs(next.rows - previous.rows);
  const colDelta = Math.abs(next.cols - previous.cols);
  return rowDelta >= REPAINT_HOLD_MIN_ROW_DELTA || colDelta >= REPAINT_HOLD_MIN_COL_DELTA;
}

export interface RepaintHoldController {
  /**
   * Hide `element` until every outstanding hold is released. Returns the release
   * for this caller; calling it more than once is harmless.
   *
   * Callers must release from a `finally`. A hold that leaks keeps the reference
   * count above zero for the rest of the mount, and every later hold and release
   * then becomes a no-op -- the pane stays hidden with output still flowing into
   * it. That failure mode is the reason this is one small tested object rather
   * than a pair of inline opacity assignments.
   */
  acquire(element: HTMLElement | null): () => void;
  /** Outstanding holds. For assertions; not part of the runtime contract. */
  readonly depth: number;
}

export interface RepaintHoldControllerOptions {
  /**
   * True once the owning mount is gone. A release arriving after that must not
   * touch the element: it now belongs to whichever mount took it over, and that
   * mount may be holding it for a repaint of its own.
   */
  isStale?: () => boolean;
}

/**
 * Reference-counted "hide this element while it is mid-repaint".
 *
 * Reference counted because a resize hold and a scrollback-replay hold overlap
 * -- a workspace switch takes both -- and neither may restore an opacity the
 * other still wants held.
 *
 * Opacity rather than visibility: the terminal's write path treats a
 * `visibility: hidden` ancestor as "not paintable" and would stop draining
 * output into a pane held this way.
 */
export function createRepaintHoldController(
  options: RepaintHoldControllerOptions = {},
): RepaintHoldController {
  let depth = 0;
  let heldElement: HTMLElement | null = null;
  let previousOpacity = "";

  return {
    get depth() {
      return depth;
    },
    acquire(element: HTMLElement | null): () => void {
      if (!element) return () => {};
      if (depth === 0) {
        heldElement = element;
        previousOpacity = element.style.opacity;
        element.style.opacity = "0";
      }
      depth += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        depth = Math.max(0, depth - 1);
        if (depth > 0) return;
        const held = heldElement;
        const restored = previousOpacity;
        heldElement = null;
        previousOpacity = "";
        if (!held) return;
        if (options.isStale?.()) return;
        held.style.opacity = restored;
      };
    },
  };
}
