import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TerminalTurnChip } from "../../src/components/terminal/TerminalTurnChip";

describe("TerminalTurnChip", () => {
  it("renders the Japanese turn count and label", () => {
    const html = renderToStaticMarkup(
      <TerminalTurnChip
        index={2}
        total={12}
        label="実装して確認して"
        onPrev={vi.fn()}
        onNext={vi.fn()}
        canPrev
        canNext
      />,
    );
    expect(html).toContain("ターン 3/12");
    expect(html).toContain("実装して確認して");
    expect(html).toContain('aria-label="前のターン"');
    expect(html).toContain('aria-label="次のターン / 最新に戻る"');
  });

  it("keeps the down arrow pressable on the only turn so it can return to the tail", () => {
    const html = renderToStaticMarkup(
      <TerminalTurnChip
        index={0}
        total={1}
        label="only"
        onPrev={vi.fn()}
        onNext={vi.fn()}
        canPrev={false}
        canNext
      />,
    );
    expect(html).toContain("ターン 1/1");
    expect(html.match(/disabled/g)?.length).toBe(1);
    expect(html).toContain('title="次のターン / 最新に戻る"');
  });

  it("exposes Japanese aria-labels on the chip and buttons", () => {
    const html = renderToStaticMarkup(
      <TerminalTurnChip
        index={0}
        total={3}
        label="hello"
        onPrev={vi.fn()}
        onNext={vi.fn()}
        canPrev={false}
        canNext
      />,
    );
    expect(html).toContain('aria-label="ターン 1/3"');
    expect(html).toContain('aria-label="前のターン"');
    expect(html).toContain('aria-label="次のターン / 最新に戻る"');
  });

  it("keeps a long label as a single DOM element", () => {
    const label = "あ".repeat(80);
    const html = renderToStaticMarkup(
      <TerminalTurnChip
        index={0}
        total={2}
        label={label}
        onPrev={vi.fn()}
        onNext={vi.fn()}
        canPrev={false}
        canNext
      />,
    );
    expect(html.split("terminal-turn-chip__label").length - 1).toBe(1);
    expect(html).toContain(label);
  });
});
