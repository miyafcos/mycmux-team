import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SettingsDialog from "../../src/components/settings/SettingsDialog";

describe("AI とおまかせ", () => {
  it("renders background AI, delegation watch, and the reply-draft opt-in", () => {
    const html = renderToStaticMarkup(
      <SettingsDialog
        initialTab="ai"
        onClose={() => {}}
        onOpenOnlinePanel={() => {}}
      />,
    );

    expect(html).toContain("AI とおまかせ");
    expect(html).toContain("バックグラウンド AI");
    expect(html).toContain("委譲の見守り");
    expect(html).toContain("返信案の先回り");
    expect(html).toContain("AI に具体案を準備させる");
    expect(html).toContain("見守りを有効にする");
    expect(html).toContain('data-ai-reply-draft-placeholder="true"');
    expect(html).toMatch(/data-ai-reply-draft-placeholder="true"[^>]*>[\s\S]*<input/);
  });
});
