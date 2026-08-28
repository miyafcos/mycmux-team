import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SettingsDialog from "../../src/components/settings/SettingsDialog";

function renderSettingsTab(initialTab: "ai" | "automation") {
  return renderToStaticMarkup(
    <SettingsDialog
      initialTab={initialTab}
      onClose={() => {}}
      onOpenOnlinePanel={() => {}}
    />,
  );
}

describe("AI と自動化の設定", () => {
  it("renders the AI-only feature list with provider-bound model selects", () => {
    const html = renderSettingsTab("ai");

    for (const text of [
      "AI機能を有効にする",
      "オフにすると下の機能がすべて止まります",
      "使用する AI",
      "モデル",
      "カスタム…",
      "この設定で動く機能",
      "タブの自動命名",
      "返信案の準備",
      "報告インボックスの要約",
      "タブ整理のAI判定",
      "ailog セッション要約",
      "ailog 一括要約",
      "タブ再配置（準備中）",
      "画面末尾14行・作業フォルダ・ペイン構成を送ります",
      "セッションログ全文を送ります（トークン消費が大きい機能です）",
    ]) {
      expect(html).toContain(text);
    }

    expect(html).toContain("自動");
    expect(html).toContain("ボタンで実行");
    expect(html.match(/<select/g)).toHaveLength(2);
    expect(html).not.toContain("委譲の見守り");
  });

  it("renders the separated automation tab", () => {
    const html = renderSettingsTab("automation");

    expect(html).toContain("自動化");
    expect(html).toContain("委譲の見守り");
    expect(html).toContain("見守りを有効にする");
    expect(html).toContain("自律モード");
    expect(html).toContain("休眠セッションの整理");
    expect(html).not.toContain("この設定で動く機能");
  });
});
