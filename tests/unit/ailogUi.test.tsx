import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Num, RefreshingBlock, tableStyle } from "../../src/components/ailog/ui";

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
