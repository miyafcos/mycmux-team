import { terminalTurnStrings } from "./terminalTurnStrings";
import type { TurnListRow } from "./terminalTurnChipState";

export type { TurnListRow } from "./terminalTurnChipState";

export interface TerminalTurnListProps {
  rows: readonly TurnListRow[];
  currentIndex: number;
  onJump: (markIndex: number) => void;
  onClose: () => void;
}

export function TerminalTurnList({
  rows,
  currentIndex,
  onJump,
  onClose,
}: TerminalTurnListProps) {
  return (
    <div className="terminal-turn-list" role="listbox" aria-label={terminalTurnStrings.listTitle}>
      {rows.length === 0 ? <div className="terminal-turn-list__empty">{terminalTurnStrings.listEmpty}</div> : null}
      {rows.map((row) => {
        const unreachable = row.markIndex === null;
        const current = row.markIndex === currentIndex;
        const className = [
          "terminal-turn-list__row",
          current ? "is-current" : "",
          unreachable ? "is-unreachable" : "",
        ].filter(Boolean).join(" ");
        return (
          <button
            key={row.key}
            type="button"
            className={className}
            role="option"
            aria-selected={current}
            disabled={unreachable}
            title={unreachable ? terminalTurnStrings.outOfScrollback : current ? terminalTurnStrings.currentRow : undefined}
            onClick={() => {
              if (row.markIndex === null) return;
              onJump(row.markIndex);
              onClose();
            }}
          >
            {row.label}
          </button>
        );
      })}
    </div>
  );
}
