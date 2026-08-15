import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RefreshingBlock } from "../../src/components/ailog/ui";

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
