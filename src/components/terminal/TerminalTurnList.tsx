import { terminalTurnStrings } from "./terminalTurnStrings";
import type { TurnChipMode, TurnListRow } from "./terminalTurnChipState";

export type { TurnListRow } from "./terminalTurnChipState";

export interface TerminalTurnListProps {
  rows: readonly TurnListRow[];
  currentIndex: number;
  mode?: TurnChipMode;
  onJump: (markIndex: number) => void;
  onJumpLabel?: (label: string) => void;
  onClose: () => void;
}

export function TerminalTurnList({
  rows,
  currentIndex,
  mode = "scroll",
  onJump,
  onJumpLabel,
  onClose,
}: TerminalTurnListProps) {
  const transcript = mode === "transcript";
  return (
    <div className="terminal-turn-list" role="listbox" aria-label={terminalTurnStrings.listTitle}>
      {rows.length === 0 ? <div className="terminal-turn-list__empty">{terminalTurnStrings.listEmpty}</div> : null}
      {rows.map((row) => {
        // A row still present in the scrollback can be scrolled to in place,
        // whichever mode the chip is in. Only a row the scrollback has already
        // dropped needs the dashboard -- and outside transcript mode there is
        // no dashboard to fall back to, so it is simply unreachable.
        const inScrollback = row.markIndex !== null;
        const unreachable = !transcript && !inScrollback;
        const opensDashboard = transcript && !inScrollback;
        const current = row.markIndex === currentIndex;
        const className = [
          "terminal-turn-list__row",
          current ? "is-current" : "",
          unreachable ? "is-unreachable" : "",
          opensDashboard ? "is-elsewhere" : "",
        ].filter(Boolean).join(" ");
        return (
          <button
            key={row.key}
            type="button"
            className={className}
            role="option"
            aria-selected={current}
            disabled={unreachable}
            title={
              unreachable
                ? terminalTurnStrings.outOfScrollback
                : opensDashboard
                  ? terminalTurnStrings.openInDashboard
                  : current
                    ? terminalTurnStrings.currentRow
                    : undefined
            }
            onClick={() => {
              if (row.markIndex !== null) {
                onJump(row.markIndex);
                onClose();
                return;
              }
              if (!transcript) return;
              onJumpLabel?.(row.label);
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
