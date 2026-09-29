// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TerminalTurnList, type TurnListRow } from "../../src/components/terminal/TerminalTurnList";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function row(overrides: Partial<TurnListRow> & { key: string }): TurnListRow {
  return { label: overrides.key, markIndex: null, at: 0, ...overrides };
}

function render(props: {
  rows: TurnListRow[];
  mode?: "scroll" | "transcript";
  onJump?: (markIndex: number) => void;
  onJumpLabel?: (label: string) => void;
}) {
  const onJump = props.onJump ?? vi.fn();
  const onJumpLabel = props.onJumpLabel ?? vi.fn();
  const onClose = vi.fn();
  act(() => {
    root.render(
      <TerminalTurnList
        rows={props.rows}
        currentIndex={-1}
        mode={props.mode ?? "scroll"}
        onJump={onJump}
        onJumpLabel={onJumpLabel}
        onClose={onClose}
      />,
    );
  });
  const buttons = Array.from(host.querySelectorAll("button"));
  const click = (index: number): void => {
    act(() => {
      buttons[index]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };
  return { buttons, click, onJump, onJumpLabel, onClose };
}

// Agent panes sit permanently in transcript mode, and the old handler sent
// every click there to the dashboard -- including rows the scrollback could
// still reach. Reported as "the history feature throws me to the dashboard
// every time and I can't read the history".
describe("TerminalTurnList in transcript mode", () => {
  it("scrolls in place when the row is still in the scrollback", () => {
    const { click, onJump, onJumpLabel } = render({
      mode: "transcript",
      rows: [row({ key: "a", markIndex: 7 })],
    });

    click(0);

    expect(onJump).toHaveBeenCalledWith(7);
    expect(onJumpLabel).not.toHaveBeenCalled();
  });

  it("falls back to the dashboard only once the scrollback has dropped the row", () => {
    const { click, onJump, onJumpLabel } = render({
      mode: "transcript",
      rows: [row({ key: "gone", label: "older turn", markIndex: null })],
    });

    click(0);

    expect(onJump).not.toHaveBeenCalled();
    expect(onJumpLabel).toHaveBeenCalledWith("older turn");
  });

  it("marks the two kinds of row apart without disabling the dashboard one", () => {
    const { buttons } = render({
      mode: "transcript",
      rows: [row({ key: "here", markIndex: 3 }), row({ key: "gone", markIndex: null })],
    });

    expect(buttons[0]?.className).not.toContain("is-elsewhere");
    expect(buttons[1]?.className).toContain("is-elsewhere");
    expect(buttons[1]?.hasAttribute("disabled")).toBe(false);
    expect(buttons[1]?.getAttribute("title")).toBeTruthy();
  });
});

describe("TerminalTurnList in scroll mode", () => {
  it("still jumps to a reachable row", () => {
    const { click, onJump, onJumpLabel } = render({
      rows: [row({ key: "a", markIndex: 2 })],
    });

    click(0);

    expect(onJump).toHaveBeenCalledWith(2);
    expect(onJumpLabel).not.toHaveBeenCalled();
  });

  it("leaves an unreachable row disabled with no dashboard fallback", () => {
    const { buttons, click, onJump, onJumpLabel } = render({
      rows: [row({ key: "gone", markIndex: null })],
    });

    expect(buttons[0]?.hasAttribute("disabled")).toBe(true);
    expect(buttons[0]?.className).toContain("is-unreachable");

    click(0);

    expect(onJump).not.toHaveBeenCalled();
    expect(onJumpLabel).not.toHaveBeenCalled();
  });
});
