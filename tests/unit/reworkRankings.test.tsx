// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  REWORK_COMMAND_SCOPE_NOTE,
  REWORK_FILE_SCOPE_NOTE,
  REWORK_RANKINGS_CAP_NOTE,
  ReworkRankingsTables,
  truncateTailPath,
} from "../../src/components/ailog/ReworkRankings";
import { WorkTagTable, workTagCostLabel } from "../../src/components/ailog/WorkTagTable";
import type { ModelsReport, ReworkRankingsReport, ToolRankingRow, FileRankingRow } from "../../src/lib/ailog";

const priceCoverage = {
  priced: { models: [], tokens: 0 },
  local: { models: [], tokens: 0 },
  internal: { models: [], tokens: 0 },
  flat: { models: [], tokens: 0 },
  reported: { models: [], tokens: 0 },
  unknown: { models: [], tokens: 0 },
  coveredTokenRatio: 1,
};

const models = {
  range: { from: 0, to: 1, label: "test" },
  granularity: "raw",
  rows: [],
  series: [],
  mixedSessions: 0,
  handoffs: [],
  byWorkTag: [
    { workTag: "debug", perModel: [{ model: "gpt-5.6-terra", sessions: 2, turns: 4, costUsd: 12.4, ingestCost: 0, generateCost: 12.4, avgRework: 0 }], sessionCount: 2 },
  ],
  overlapping: true,
  totalSessions: 2,
  priceSource: "test",
  priceCoverage,
  costNote: "",
} satisfies ModelsReport;

function commandRow(index: number, overrides: Partial<ToolRankingRow> = {}): ToolRankingRow {
  return {
    name: `cmd-${index}`,
    target: `target-${index}`,
    executions: 10 + index,
    failures: index,
    failureRate: 0,
    ...overrides,
  };
}

function fileRow(index: number, overrides: Partial<FileRankingRow> = {}): FileRankingRow {
  return {
    path: `C:\\repo\\file-${index}.ts`,
    editCount: 20 - index,
    sessionCount: 1 + (index % 3),
    ...overrides,
  };
}

const rankings: ReworkRankingsReport = {
  failedCommands: [
    { name: "Bash", target: "cargo", executions: 120, failures: 3, failureRate: 0.025 },
    { name: "Bash", target: "npm", executions: 4, failures: 2, failureRate: 0.5 },
  ],
  rewrittenFiles: [
    { path: "C:\\Users\\miyaz\\cmux-for-linux-dev-master\\src\\stores\\ailogStore.ts", editCount: 18, sessionCount: 4 },
  ],
};

function markupOfRankings(report: ReworkRankingsReport = rankings) {
  return renderToStaticMarkup(<ReworkRankingsTables report={report} />);
}

describe("rework ranking presentation", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  it("shows failure counts with the execution denominator, not a lone rate", () => {
    const html = markupOfRankings();
    expect(html).toContain("3 / 120");
    expect(html).toContain("2 / 4");
    expect(html).not.toContain("50%");
    expect(html).not.toContain("2.5%");
    expect(html).not.toContain("failureRate");
  });

  it("binds each command row's label to that row's counts", () => {
    const host = document.createElement("div");
    host.innerHTML = markupOfRankings();
    const rows = [...host.querySelectorAll('[data-testid="rework-command-row"]')];
    expect(rows).toHaveLength(2);
    const pairs = rows.map((row) => ({
      label: row.querySelector('[data-testid="rework-command-label"]')?.textContent,
      counts: row.querySelector('[data-testid="rework-command-counts"]')?.textContent,
    }));
    expect(pairs).toEqual([
      { label: "Bash · cargo", counts: "3 / 120" },
      { label: "Bash · npm", counts: "2 / 4" },
    ]);
  });

  it("caps each table at 10 rows, hides the 11th, and puts the cap note on both tables", () => {
    const report: ReworkRankingsReport = {
      failedCommands: Array.from({ length: 11 }, (_, index) => commandRow(index)),
      rewrittenFiles: Array.from({ length: 11 }, (_, index) => fileRow(index)),
    };
    const host = document.createElement("div");
    host.innerHTML = markupOfRankings(report);
    expect(host.querySelectorAll('[data-testid="rework-command-row"]')).toHaveLength(10);
    expect(host.querySelectorAll('[data-testid="rework-file-row"]')).toHaveLength(10);
    expect(host.textContent).not.toContain("cmd-10");
    expect(host.textContent).not.toContain("file-10.ts");
    expect(host.textContent).toContain("cmd-9");
    expect(host.textContent).toContain("file-9.ts");
    expect(host.querySelectorAll('[data-testid="rework-command-cap-note"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-testid="rework-file-cap-note"]')).toHaveLength(1);
    expect(host.querySelector('[data-testid="rework-command-cap-note"]')?.textContent).toBe(REWORK_RANKINGS_CAP_NOTE);
    expect(host.querySelector('[data-testid="rework-file-cap-note"]')?.textContent).toBe(REWORK_RANKINGS_CAP_NOTE);
  });

  it("keeps colliding name/target colon pairs as distinct rows across a rerender", async () => {
    const colliding: ReworkRankingsReport = {
      failedCommands: [
        { name: "a:b", target: "c", executions: 10, failures: 1, failureRate: 0.1 },
        { name: "a", target: "b:c", executions: 20, failures: 2, failureRate: 0.1 },
      ],
      rewrittenFiles: [],
    };
    const updated: ReworkRankingsReport = {
      failedCommands: [
        { name: "a:b", target: "c", executions: 10, failures: 9, failureRate: 0.9 },
        { name: "a", target: "b:c", executions: 20, failures: 2, failureRate: 0.1 },
      ],
      rewrittenFiles: [],
    };

    const container = document.createElement("div");
    document.body.append(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(<ReworkRankingsTables report={colliding} />);
    });
    const before = [...container.querySelectorAll('[data-testid="rework-command-row"]')].map((row) => ({
      label: row.querySelector('[data-testid="rework-command-label"]')?.textContent,
      counts: row.querySelector('[data-testid="rework-command-counts"]')?.textContent,
    }));
    expect(before).toEqual([
      { label: "a:b · c", counts: "1 / 10" },
      { label: "a · b:c", counts: "2 / 20" },
    ]);

    await act(async () => {
      root.render(<ReworkRankingsTables report={updated} />);
    });
    const after = [...container.querySelectorAll('[data-testid="rework-command-row"]')].map((row) => ({
      label: row.querySelector('[data-testid="rework-command-label"]')?.textContent,
      counts: row.querySelector('[data-testid="rework-command-counts"]')?.textContent,
    }));
    expect(after).toEqual([
      { label: "a:b · c", counts: "9 / 10" },
      { label: "a · b:c", counts: "2 / 20" },
    ]);
    await act(async () => root.unmount());
    container.remove();
  });

  it("does not paint work-tag cost or failed commands as good or bad", () => {
    const tags = renderToStaticMarkup(<WorkTagTable report={models} />);
    const commands = markupOfRankings();
    for (const html of [tags, commands]) {
      expect(html).not.toContain("--cmux-usage-warn");
      expect(html).not.toContain("--cmux-usage-danger");
      expect(html).not.toContain("--cmux-usage-ok");
    }
    const host = document.createElement("div");
    host.innerHTML = commands;
    const commandRows = host.querySelectorAll('[data-testid="rework-command-row"]');
    expect(commandRows.length).toBeGreaterThan(0);
    for (const row of commandRows) {
      expect((row as HTMLElement).style.color).toBe("");
    }
    host.innerHTML = tags;
    const tagRows = host.querySelectorAll('[data-testid="work-tag-row"]');
    expect(tagRows.length).toBeGreaterThan(0);
    for (const row of tagRows) {
      expect((row as HTMLElement).style.color).toBe("");
    }
  });

  it("shortens a long path in the cell and keeps the full path on title", () => {
    const path = "C:\\Users\\miyaz\\cmux-for-linux-dev-master\\src\\stores\\ailogStore.ts";
    const host = document.createElement("div");
    host.innerHTML = markupOfRankings();
    const cell = host.querySelector('[data-testid="rework-file-path"]') as HTMLElement | null;
    expect(cell).not.toBeNull();
    expect(cell!.getAttribute("title")).toBe(path);
    expect(cell!.textContent).toBe(truncateTailPath(path));
    expect(cell!.textContent).not.toContain("Users\\miyaz");
    expect(truncateTailPath("short.ts")).toBe("short.ts");
  });

  it("explains command vs file ranking at different grains", () => {
    const html = markupOfRankings();
    expect(html).toContain(REWORK_COMMAND_SCOPE_NOTE);
    expect(html).toContain(REWORK_FILE_SCOPE_NOTE);
    expect(html).not.toContain("期間指定に追随");
  });
});

describe("work-tag cost coverage copy", () => {
  it("pairs known tokens with the cost-bearing total when coverage is partial", () => {
    const partial = {
      ...models,
      priceCoverage: {
        ...priceCoverage,
        priced: { models: ["gpt-5.6-terra"], tokens: 600 },
        unknown: { models: ["mystery"], tokens: 400 },
        coveredTokenRatio: 0.6,
      },
    } satisfies ModelsReport;
    expect(workTagCostLabel(partial.priceCoverage)).toBe("コスト相当 (価格情報あり 600 / 1,000 tok)");
    const html = renderToStaticMarkup(<WorkTagTable report={partial} />);
    expect(html).toContain("価格情報あり 600 / 1,000 tok");
    expect(html).not.toContain("% 分");
    expect(html).not.toContain("全体の");
    expect(html).not.toContain("割合");
  });
});
