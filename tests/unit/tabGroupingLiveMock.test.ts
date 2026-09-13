import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// scripts/build_grouping_live_mock.ps1 writes the generated mock outside the
// repository, into the author's local report folder. That artifact exists on
// one machine only, so the checks that need it run only where it is present
// (MYCMUX_LIVE_MOCK_DIR overrides the folder). A hand-written fixture would
// only test itself and say nothing about what the build produces, so none is
// shipped; the repository is mirrored publicly and must not carry the real
// report either.
const outputParent = process.env.MYCMUX_LIVE_MOCK_DIR ?? "C:\\Users\\miyaz\\reports\\_quick\\2026-08";
const GUIDE_HEADINGS = ["① 案を比較する", "② 内容を編集する", "③ 適用前に確認する", "④ 適用して元に戻す"];

function latestGeneratedHtml(): string | null {
  if (!existsSync(outputParent)) return null;
  const directory = readdirSync(outputParent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("タブ再配置_動くモック_"))
    .sort((left, right) => right.name.localeCompare(left.name, "ja"))[0];
  if (!directory) return null;
  const indexPath = join(outputParent, directory.name, "index.html");
  return existsSync(indexPath) ? readFileSync(indexPath, "utf8") : null;
}

const generatedHtml = latestGeneratedHtml();

describe("Tab grouping live mock artifact", () => {
  it.skipIf(generatedHtml === null)(
    "is a self-contained HTML file with the real Panel bundle (skipped unless the generated mock is present locally)",
    () => {
      const html = generatedHtml ?? "";
      expect(html).not.toMatch(/<script\b[^>]*\bsrc=/i);
      expect(html).not.toMatch(/<link\b[^>]*\bhref=/i);
      expect(html).not.toMatch(/https?:\/\//i);
      expect(html).toContain("cmux-tab-grouping");
      expect(html).toContain("MYCMUX_GROUPING_LIVE_MOCK");
    },
  );

  it("defines the four contextual guide headings in the mock (and ships them when a build is present)", () => {
    const source = readFileSync("src/mock/tabGroupingLiveMock.tsx", "utf8");
    for (const heading of GUIDE_HEADINGS) {
      expect(source).toContain(`title: "${heading}"`);
      if (generatedHtml !== null) expect(generatedHtml).toContain(heading);
    }
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
