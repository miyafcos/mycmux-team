import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const outputParent = "C:\\Users\\miyaz\\reports\\_quick\\2026-08";

function latestGeneratedHtml(): string {
  const directory = readdirSync(outputParent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("タブ再配置_動くモック_"))
    .sort((left, right) => right.name.localeCompare(left.name, "ja"))[0];
  if (!directory) throw new Error("生成済みの live mock がありません。");
  return readFileSync(join(outputParent, directory.name, "index.html"), "utf8");
}

describe("Tab grouping live mock artifact", () => {
  it("is a self-contained HTML file with the real Panel bundle", () => {
    const html = latestGeneratedHtml();
    expect(html).not.toMatch(/<script\b[^>]*\bsrc=/i);
    expect(html).not.toMatch(/<link\b[^>]*\bhref=/i);
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).toContain("cmux-tab-grouping");
    expect(html).toContain("MYCMUX_GROUPING_LIVE_MOCK");
  });

  it("contains the four contextual guide headings", () => {
    const html = latestGeneratedHtml();
    expect(html).toContain("① 案を比較する");
    expect(html).toContain("② 内容を編集する");
    expect(html).toContain("③ 適用前に確認する");
    expect(html).toContain("④ 適用して元に戻す");
  });

  it("documents and captures the edit-map step", () => {
    const source = readFileSync("src/mock/tabGroupingLiveMock.tsx", "utf8");
    const buildScript = readFileSync("scripts/build_grouping_live_mock.ps1", "utf8");
    expect(source).toContain("左のグループで「再配置する」「現状維持」を選びます。");
    expect(source).toContain("タブを選び、右の配置図の移動先ペインをクリックします。");
    expect(source).toContain("「変更対象のみ表示」で動くタブだけに絞れます。");
    expect(source).toContain("tabGroupingStrings.editPlan");
    expect(source).toContain('params.get("step") !== "2"');
    expect(buildScript).toContain("preview_step2.png");
    expect(buildScript).toContain("preview_step2_light.png");
    expect(buildScript).toContain('data-mock-step="2"');
  });

  it("anchors the portal overlay beside the mock chrome", () => {
    const css = readFileSync("src/mock/tabGroupingLiveMock.css", "utf8");
    expect(css).toContain(
      'html[data-live-mock="MYCMUX_GROUPING_LIVE_MOCK"] > body > .cmux-overlay-backdrop',
    );
    expect(css).not.toMatch(/\.grouping-live-mock\s+\.cmux-overlay-(?:backdrop|panel)/);
  });

  it("does not route the Tauri stub through the production Vite config", () => {
    const productionConfig = readFileSync("vite.config.ts", "utf8");
    const diff = execFileSync("git", ["diff", "--", "vite.config.ts"], { encoding: "utf8" });
    expect(productionConfig).not.toContain("tauriStub");
    expect(productionConfig).not.toContain("MYCMUX_GROUPING_LIVE_MOCK");
    expect(diff).toBe("");
  });
});
