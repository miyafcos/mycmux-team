import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SettingsDialog from "../../src/components/settings/SettingsDialog";

describe("AI とおまかせ", () => {
  it("renders background AI, delegation watch, and the inactive reply-draft placeholder", () => {
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
    expect(html).toContain("返信案の先回り (準備中)");
    expect(html).toContain("見守りを有効にする");
    expect(html).toContain('data-ai-reply-draft-placeholder="true"');
    expect(html).not.toMatch(/data-ai-reply-draft-placeholder="true"[^>]*>.*<(?:input|button)/);
  });
});
