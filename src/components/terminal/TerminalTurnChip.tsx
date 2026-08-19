import { memo, type MouseEvent } from "react";

export interface TerminalTurnChipProps {
  index: number;
  total: number;
  label: string;
  onPrev: () => void;
  onNext: () => void;
  canPrev: boolean;
  canNext: boolean;
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
}: TerminalTurnChipProps) {
  return (
    <div
      className="terminal-turn-chip"
      aria-label={`ターン ${index + 1}/${total}`}
    >
      <span className="terminal-turn-chip__meta">{`ターン ${index + 1}/${total}`}</span>
      <span className="terminal-turn-chip__label">{label}</span>
      <span className="terminal-turn-chip__nav">
        <button
          type="button"
          aria-label="前のターン"
          disabled={!canPrev}
          onMouseDown={keepTerminalFocus}
          onClick={onPrev}
        >
          ▲
        </button>
        <button
          type="button"
          aria-label="次のターン"
          disabled={!canNext}
          onMouseDown={keepTerminalFocus}
          onClick={onNext}
        >
          ▼
        </button>
      </span>
    </div>
  );
});
