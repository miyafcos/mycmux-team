import { memo, type MouseEvent, useCallback, useEffect, useRef, useState } from "react";

import { TerminalTurnList, type TurnListRow } from "./TerminalTurnList";
import type { TurnChipMode } from "./terminalTurnChipState";
import { terminalTurnStrings } from "./terminalTurnStrings";
import { captureTemporaryFocusReturn } from "../../lib/focusController";

export interface TerminalTurnChipProps {
  index: number;
  total: number;
  label: string;
  onPrev: () => void;
  onNext: () => void;
  canPrev: boolean;
  canNext: boolean;
  rows: readonly TurnListRow[];
  onJump: (markIndex: number) => void;
  onJumpLabel?: (label: string) => void;
  onListOpen: () => void;
  onListVisibilityChange?: (open: boolean) => void;
  /** The wrapper's chip expires; completing its list must use the durable host. */
  returnFocusToOwner?: boolean;
  /** Pointer entered the chip; keeps it from auto-hiding while in use. */
  onHover?: () => void;
  leaving?: boolean;
  mode?: TurnChipMode;
  /** Opens the in-pane transcript reader (agent panes only). */
  onOpenPanel?: () => void;
}

function keepTerminalFocus(event: MouseEvent): void {
  event.preventDefault();
}

export const TerminalTurnChip = memo(function TerminalTurnChip({
  index,
  total,
  label,
  onPrev,
  onNext,
  canPrev,
  canNext,
  rows,
  onJump,
  onJumpLabel,
  onListOpen,
  onListVisibilityChange,
  returnFocusToOwner = false,
  onHover,
  leaving = false,
  mode = "scroll",
  onOpenPanel,
}: TerminalTurnChipProps) {
  const [isListOpen, setIsListOpen] = useState(false);
  const chipRef = useRef<HTMLDivElement>(null);
  const focusReturnRef = useRef<ReturnType<typeof captureTemporaryFocusReturn> | null>(null);

  const closeList = useCallback((restore = true): void => {
    if (restore) focusReturnRef.current?.(returnFocusToOwner ? chipRef.current : chipRef.current?.querySelector(".terminal-turn-list") ?? null);
    focusReturnRef.current?.cancel(); focusReturnRef.current = null;
    setIsListOpen(false);
    onListVisibilityChange?.(false);
  }, [onListVisibilityChange, returnFocusToOwner]);
  useEffect(() => () => focusReturnRef.current?.cancel(), []);

  useEffect(() => {
    if (!isListOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") closeList();
    };
    const onMouseDown = (event: globalThis.MouseEvent): void => {
      if (!chipRef.current?.contains(event.target as Node)) closeList(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [closeList, isListOpen]);

  useEffect(() => {
    if (leaving) closeList(false);
  }, [closeList, leaving]);

  const toggleList = (): void => {
    if (isListOpen) {
      closeList();
      return;
    }
    onListOpen();
    focusReturnRef.current = captureTemporaryFocusReturn(chipRef.current,
      returnFocusToOwner ? null : chipRef.current?.querySelector<HTMLButtonElement>(".terminal-turn-chip__label") ?? null,
      () => chipRef.current);
    onListVisibilityChange?.(true);
    setIsListOpen(true);
  };

  const className = [
    "terminal-turn-chip",
    mode === "transcript" ? "is-transcript" : "",
    leaving ? "is-leaving" : "",
  ].filter(Boolean).join(" ");
  const transcript = mode === "transcript";
  const meta = transcript ? terminalTurnStrings.conversationHistory : terminalTurnStrings.position(index, total);
  const prevEnabled = transcript || canPrev;
  const nextEnabled = transcript || canNext;

  return (
    <div
      ref={chipRef}
      className={className}
      aria-label={meta}
      aria-hidden={leaving || undefined}
      // @ts-expect-error React 19 types still declare inert as a string attribute.
      inert={leaving ? "" : undefined}
      onMouseDown={keepTerminalFocus}
      onMouseEnter={onHover}
    >
      <span className="terminal-turn-chip__meta">{meta}</span>
      <button
        type="button"
        className="terminal-turn-chip__label"
        aria-expanded={isListOpen}
        title={isListOpen ? terminalTurnStrings.closeList : terminalTurnStrings.openList}
        onClick={toggleList}
      >
        {label || terminalTurnStrings.openList}
      </button>
      <span className="terminal-turn-chip__nav">
        <button
          type="button"
          aria-label={terminalTurnStrings.prevTurn}
          title={terminalTurnStrings.prevTurn}
          disabled={!prevEnabled}
          onClick={onPrev}
        >
          ▲
        </button>
        <button
          type="button"
          aria-label={terminalTurnStrings.nextTurnOrTail}
          title={terminalTurnStrings.nextTurnOrTail}
          disabled={!nextEnabled}
          onClick={onNext}
        >
          ▼
        </button>
      </span>
      {mode === "transcript" && onOpenPanel ? (
        <button
          type="button"
          className="terminal-turn-chip__hint"
          title={terminalTurnStrings.openPanel}
          onClick={onOpenPanel}
        >
          {terminalTurnStrings.openPanel}
        </button>
      ) : null}
      {isListOpen ? <TerminalTurnList
        rows={rows}
        currentIndex={index}
        mode={mode}
        onJump={onJump}
        onJumpLabel={onJumpLabel}
        onClose={() => closeList()}
      /> : null}
    </div>
  );
});
