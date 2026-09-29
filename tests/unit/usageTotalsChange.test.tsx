// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { UsageTotals } from "../../src/components/ailog/UsageTotals";
import type { SeriesReport, Totals } from "../../src/lib/ailog";

const report: SeriesReport = {
  range: { from: 0, to: 1, label: "test" },
  bucket: "day",
  groupBy: "model_raw",
  buckets: [],
  priceSource: "test",
  priceCoverage: { coveredTokenRatio: 1, unpricedModels: [], coveredCostUsd: 0, unpricedTokens: 0 },
  costNote: "test",
};

function totals(costUsd: number, userMessages: number): Totals {
  return { sessions: 1, turns: userMessages, userMessages, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd, wallMs: 10_000, activeMs: 8_000, projects: 1, models: 1 };
}

function render(current: Totals, previous: Totals | null, preset: "30d" | "all" = "30d") {
  const html = renderToStaticMarkup(
    <UsageTotals report={report} metric="costUsd" comparePrevious={null} preset={preset} totals={current} previousTotals={previous} />,
  );
  const host = document.createElement("div");
  host.innerHTML = html;
  return host;
}

function effect(host: HTMLElement, name: "volume" | "rate" | "interaction") {
  const node = host.querySelector(`[data-testid="cost-${name}-effect"]`);
  if (!(node instanceof HTMLElement)) throw new Error(`missing ${name}`);
  return node;
}

describe("UsageTotals cost change", () => {
  it("warns only an increasing cost per request, using the actual inline style", () => {
    const host = render(totals(30, 20), totals(10, 10));
    expect(effect(host, "rate").style.color).toBe("var(--cmux-usage-warn)");
    expect(effect(host, "volume").style.color).toBe("");
    expect(effect(host, "interaction").style.color).toBe("");
  });

  it("does not color a pure request-volume increase", () => {
    const host = render(totals(20, 20), totals(10, 10));
    expect(effect(host, "volume").style.color).toBe("");
    expect(effect(host, "rate").style.color).toBe("");
    expect(effect(host, "interaction").style.color).toBe("");
  });

  it("does not color any decrease-direction effect", () => {
    const host = render(totals(10, 10), totals(20, 10));
    expect(effect(host, "volume").style.color).toBe("");
    expect(effect(host, "rate").style.color).toBe("");
    expect(effect(host, "interaction").style.color).toBe("");
  });

  it("renders no breakdown for all time and never renders Infinity for zero requests", () => {
    const allTime = render(totals(10, 10), totals(5, 5), "all");
    expect(allTime.querySelector('[data-testid="cost-change-breakdown"]')).toBeNull();

    const noRequests = render(totals(0, 0), totals(5, 5));
    expect(noRequests.textContent).toContain("—");
    expect(noRequests.innerHTML).not.toMatch(/Infinity|NaN/);
  });
});
