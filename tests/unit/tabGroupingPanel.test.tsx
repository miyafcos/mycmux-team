import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TabGroupingButton } from "../../src/components/layout/TabGroupingButton";
import { TabGroupingPanel } from "../../src/components/layout/TabGroupingPanel";
import { tabGroupingStrings } from "../../src/components/dashboard/dashboardStrings";

describe("TabGroupingPanel", () => {
  it("renders the three-mode header and Japanese copy", () => {
    const html = renderToStaticMarkup(
      <TabGroupingPanel open visible onClose={() => {}} />,
    );
    expect(html).toContain(tabGroupingStrings.title);
    expect(html).toContain(tabGroupingStrings.stepCompare);
    expect(html).toContain(tabGroupingStrings.stepEdit);
    expect(html).toContain(tabGroupingStrings.stepConfirm);
    expect(html).toContain(tabGroupingStrings.stepConfirm);
    expect(html).toContain(tabGroupingStrings.analyzeAgain);
    expect(html).toContain('aria-label="手順"');
  });
});

describe("TabGroupingButton", () => {
  it("exposes the dashboard entry in Japanese", () => {
    const html = renderToStaticMarkup(<TabGroupingButton />);
    expect(html).toContain(tabGroupingStrings.buttonLabel);
    expect(html).toContain("tab-grouping-panel");
  });
});
