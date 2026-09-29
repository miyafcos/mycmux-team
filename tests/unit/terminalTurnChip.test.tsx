// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TerminalTurnChip } from "../../src/components/terminal/TerminalTurnChip";
import { terminalTurnStrings } from "../../src/components/terminal/terminalTurnStrings";

const rows = [
  { key: "mark-1", label: "current prompt", markIndex: 1, at: 200 },
  { key: "mark-0", label: "older prompt", markIndex: 0, at: 100 },
];

function chipProps() {
  return {
    index: 1,
    total: 2,
    label: "current prompt",
    onPrev: vi.fn(),
    onNext: vi.fn(),
    canPrev: true,
    canNext: false,
    rows,
    onJump: vi.fn(),
    onJumpLabel: vi.fn(),
    onListOpen: vi.fn(),
  };
}

describe("TerminalTurnChip", () => {
  it("renders the position, label, and localized controls", () => {
    const html = renderToStaticMarkup(<TerminalTurnChip {...chipProps()} />);
    expect(html).toContain(terminalTurnStrings.position(1, 2));
    expect(html).toContain("current prompt");
    expect(html).toContain(`aria-label="${terminalTurnStrings.prevTurn}"`);
    expect(html).toContain(`aria-label="${terminalTurnStrings.nextTurnOrTail}"`);
    expect(html).toContain(`title="${terminalTurnStrings.openList}"`);
    expect(html).not.toContain("is-leaving");
    expect(html).not.toContain("aria-hidden");
  });

  it("applies the leaving class and hides the chip from assistive tech", () => {
    const html = renderToStaticMarkup(<TerminalTurnChip {...chipProps()} leaving />);
    expect(html).toContain("terminal-turn-chip is-leaving");
    expect(html).toContain("aria-hidden=\"true\"");
  });

  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function renderChip(props = chipProps()): ReturnType<typeof chipProps> {
    act(() => root.render(<TerminalTurnChip {...props} />));
    return props;
  }

  function clickLabel(): HTMLButtonElement {
    const button = host.querySelector<HTMLButtonElement>(".terminal-turn-chip__label");
    if (!button) throw new Error("label button missing");
    act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    return button;
  }

  it("toggles the history list with aria-expanded", () => {
    const props = renderChip();
    const label = clickLabel();
    expect(label.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector(".terminal-turn-list")).not.toBeNull();
    expect(props.onListOpen).toHaveBeenCalledTimes(1);

    clickLabel();
    expect(label.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector(".terminal-turn-list")).toBeNull();
  });

  it("reports the full list-open lifetime so the parent can pin visibility", () => {
    const onListVisibilityChange = vi.fn();
    renderChip({ ...chipProps(), onListVisibilityChange });

    clickLabel();
    expect(onListVisibilityChange).toHaveBeenLastCalledWith(true);

    clickLabel();
    expect(onListVisibilityChange).toHaveBeenLastCalledWith(false);
  });

  it("closes the history list with Escape", () => {
    renderChip();
    const label = clickLabel();
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(label.getAttribute("aria-expanded")).toBe("false");
  });

  it("jumps to a reachable row and closes the list", () => {
    const props = renderChip();
    const label = clickLabel();
    const row = [...host.querySelectorAll<HTMLButtonElement>(".terminal-turn-list__row")]
      .find((button) => button.textContent === "older prompt");
    if (!row) throw new Error("reachable row missing");

    act(() => row.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(props.onJump).toHaveBeenCalledWith(0);
    expect(label.getAttribute("aria-expanded")).toBe("false");
  });

  it("does not jump for an unreachable row", () => {
    const props = renderChip({
      ...chipProps(),
      rows: [{ key: "trimmed", label: "trimmed prompt", markIndex: null }],
    });
    clickLabel();
    const row = host.querySelector<HTMLButtonElement>(".terminal-turn-list__row");
    if (!row) throw new Error("unreachable row missing");

    act(() => row.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(row.disabled).toBe(true);
    expect(props.onJump).not.toHaveBeenCalled();
  });

  it("offers the in-pane reader, not the dashboard, only in transcript mode", () => {
    // The chip used to hand agent panes a link out to the Dashboard. The
    // history is now read here, and the Dashboard link lives in the reader.
    const scroll = renderToStaticMarkup(<TerminalTurnChip {...chipProps()} />);
    expect(scroll).not.toContain(terminalTurnStrings.openPanel);
    const transcript = renderToStaticMarkup(
      <TerminalTurnChip {...chipProps()} mode="transcript" onOpenPanel={() => undefined} />,
    );
    expect(transcript).toContain(terminalTurnStrings.openPanel);
    expect(transcript).not.toContain(terminalTurnStrings.openInDashboard);
    expect(transcript).toContain("is-transcript");
    expect(transcript).toContain(terminalTurnStrings.conversationHistory);
    expect(transcript).not.toContain(terminalTurnStrings.position(1, 2));
  });

  it("keeps prev and next enabled in transcript mode even at the latest mark", () => {
    const html = renderToStaticMarkup(
      <TerminalTurnChip
        {...chipProps()}
        canPrev={false}
        canNext={false}
        mode="transcript"
        onOpenDashboard={() => undefined}
      />,
    );
    expect(html).not.toMatch(new RegExp(`aria-label="${terminalTurnStrings.prevTurn}"[^>]*disabled`));
    expect(html).not.toMatch(new RegExp(`aria-label="${terminalTurnStrings.nextTurnOrTail}"[^>]*disabled`));
  });

  it("jumps unmatched transcript rows by label instead of disabling them", () => {
    const props = renderChip({
      ...chipProps(),
      mode: "transcript",
      onJumpLabel: vi.fn(),
      rows: [{ key: "trimmed", label: "trimmed prompt", markIndex: null }],
    });
    clickLabel();
    const row = host.querySelector<HTMLButtonElement>(".terminal-turn-list__row");
    if (!row) throw new Error("transcript row missing");

    act(() => row.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(row.disabled).toBe(false);
    expect(props.onJump).not.toHaveBeenCalled();
    expect(props.onJumpLabel).toHaveBeenCalledWith("trimmed prompt");
  });
});
