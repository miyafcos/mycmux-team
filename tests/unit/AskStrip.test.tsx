import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AskStrip } from "../../src/components/dashboard/AskStrip";

describe("AskStrip", () => {
  it("keeps the full prompt reachable from a truncated button", () => {
    const prompt = "This is the complete question that may be visually truncated.";
    const html = renderToStaticMarkup(<AskStrip items={[{
      tabId: "tab-1",
      sessionId: "session-1",
      label: "Worker",
      prompt,
    }]} onSelect={vi.fn()} />);

    expect(html).toContain(`title="${prompt}"`);
  });
});
