import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChartHatchDefs, Num, RefreshingBlock, paintFill, paintSwatchBackground, tableStyle } from "../../src/components/ailog/ui";

describe("RefreshingBlock", () => {
  it("keeps the previous data visible but dimmed while a range refresh is busy", () => {
    const html = renderToStaticMarkup(
      <RefreshingBlock busy>
        <div>前回の集計</div>
      </RefreshingBlock>,
    );

    expect(html).toContain('data-ailog-refreshing="true"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("更新中…");
    expect(html).toContain("opacity:0.55");
    expect(html).toContain("前回の集計");
  });
});

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

describe("ailog table layout", () => {
  it("pins tableLayout to fixed so columns cannot outgrow the parent", () => {
    expect(tableStyle.tableLayout).toBe("fixed");
  });

  it("forbids overflowX except SessionTable and the existing panel clip", () => {
    const root = join(__dirname, "../../src/components/ailog");
    const allowed = new Set(["SessionTable.tsx", "AiLogPanel.tsx"]);
    for (const file of listFiles(root)) {
      const text = readFileSync(file, "utf8");
      if (!text.includes("overflowX")) continue;
      const name = file.split(/[/\\]/).pop() ?? file;
      expect(allowed.has(name), `${name} contains overflowX`).toBe(true);
      expect(text).toMatch(/overflowX:\s*"hidden"/);
    }
  });
});

describe("Num", () => {
  it("shows 万 notation and a full-digit title together", () => {
    const html = renderToStaticMarkup(<Num value={12345678} kind="tokens" />);
    expect(html).toContain("1,234.6万 tok");
    expect(html).toContain('title="12,345,678 tok"');
  });

  it("drops the tok suffix when bare", () => {
    const html = renderToStaticMarkup(<Num value={12345678} kind="tokens" bare />);
    const text = html.replace(/<[^>]+>/g, "");
    expect(text).toBe("1,234.6万");
    expect(text).not.toContain(" tok");
  });

  it("does not attach a title to unrounded counts", () => {
    const html = renderToStaticMarkup(<Num value={1234} kind="count" />);
    expect(html).toContain("1,234");
    expect(html).not.toContain("title=");
  });
});

describe("ailog chart paint helpers", () => {
  const solid = { color: "#123456", tone: "solid" } as const;
  const muted = { color: "#123456", tone: "muted" } as const;

  it("deduplicates colour-derived hatch pattern IDs and omits solid-only defs", () => {
    const html = renderToStaticMarkup(<svg><ChartHatchDefs paints={[muted, muted]} /></svg>);
    const ids = [...html.matchAll(/<pattern id="([^"]+)"/g)].map((match) => match[1]);

    expect(ids).toEqual(["ailog-hatch-123456"]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ChartHatchDefs({ paints: [solid] })).toBeNull();
  });

  it("uses SVG patterns only for muted paint and CSS gradients only for muted swatches", () => {
    expect(paintFill(solid)).toBe("#123456");
    expect(paintFill(muted)).toMatch(/^url\(#ailog-hatch-/);
    expect(paintSwatchBackground(muted)).toContain("repeating-linear-gradient");
    expect(paintSwatchBackground(muted)).not.toContain("url(#");
  });
});
