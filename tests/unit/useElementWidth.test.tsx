// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { useElementWidth } from "../../src/hooks/useElementWidth";

function Probe({ onWidth }: { onWidth: (width: number) => void }) {
  const { width } = useElementWidth();
  onWidth(width);
  return <div />;
}

describe("useElementWidth", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("returns 0 and does not throw when ResizeObserver is undefined", () => {
    const saved = globalThis.ResizeObserver;
    // @ts-expect-error -- simulate SSR / jsdom without the observer
    delete globalThis.ResizeObserver;
    const widths: number[] = [];
    const host = document.createElement("div");
    document.body.appendChild(host);
    try {
      expect(() => {
        act(() => {
          createRoot(host).render(<Probe onWidth={(width) => widths.push(width)} />);
        });
      }).not.toThrow();
      expect(widths.at(-1)).toBe(0);
    } finally {
      if (saved) globalThis.ResizeObserver = saved;
    }
  });
});
