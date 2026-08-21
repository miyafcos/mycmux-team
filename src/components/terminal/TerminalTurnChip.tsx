import { memo, type MouseEvent, useEffect, useRef, useState } from "react";

import { TerminalTurnList, type TurnListRow } from "./TerminalTurnList";
import { terminalTurnStrings } from "./terminalTurnStrings";

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
  onListOpen: () => void;
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
  onListOpen,
}: TerminalTurnChipProps) {
  const [isListOpen, setIsListOpen] = useState(false);
  const chipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isListOpen) return;
    const closeList = (): void => setIsListOpen(false);
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") closeList();
    };
    const onMouseDown = (event: globalThis.MouseEvent): void => {
      if (!chipRef.current?.contains(event.target as Node)) closeList();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [isListOpen]);

  const toggleList = (): void => {
    setIsListOpen((wasOpen) => {
      if (wasOpen) return false;
      onListOpen();
      return true;
    });
  };

  return (
    <div
      ref={chipRef}
      className="terminal-turn-chip"
      aria-label={terminalTurnStrings.position(index, total)}
      onMouseDown={keepTerminalFocus}
    >
      <span className="terminal-turn-chip__meta">{terminalTurnStrings.position(index, total)}</span>
      <button
        type="button"
        className="terminal-turn-chip__label"
        aria-expanded={isListOpen}
        title={isListOpen ? terminalTurnStrings.closeList : terminalTurnStrings.openList}
        onClick={toggleList}
      >
        {label}
      </button>
      <span className="terminal-turn-chip__nav">
        <button
          type="button"
          aria-label={terminalTurnStrings.prevTurn}
          title={terminalTurnStrings.prevTurn}
          disabled={!canPrev}
          onClick={onPrev}
        >
          ▲
        </button>
        <button
          type="button"
          aria-label={terminalTurnStrings.nextTurnOrTail}
          title={terminalTurnStrings.nextTurnOrTail}
          disabled={!canNext}
          onClick={onNext}
        >
          ▼
        </button>
      </span>
      {isListOpen ? <TerminalTurnList
        rows={rows}
        currentIndex={index}
        onJump={onJump}
        onClose={() => setIsListOpen(false)}
      /> : null}
    </div>
  );
});
