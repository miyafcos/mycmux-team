import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AgentKindIcon } from "../../src/components/icons/AgentIcons";
import { launchItems } from "../../src/components/workspace/launcherModel";
import { resolveTabMark, tabMarkColor, WEB_PRESET_MARKS } from "../../src/lib/tabMark";
import type { PaneTab } from "../../src/types";

function webTab(presetId?: string): PaneTab {
  return { id: "t1", sessionId: "s1", agentId: "a1", type: "web", presetId };
}

describe("resolveTabMark", () => {
  it("gives a web tab the same mark its launcher row draws", () => {
    const items = launchItems();
    for (const presetId of Object.keys(WEB_PRESET_MARKS)) {
      const row = items.find((item) => item.target === `web-${presetId}`);
      expect(row, `no launcher row for ${presetId}`).toBeDefined();
      expect(resolveTabMark(webTab(presetId))?.kind, presetId).toBe(row?.iconKind);
    }
  });

  it("labels a web tab by its vendor, not by the mark it borrows", () => {
    // The ChatGPT preset draws the Codex mark; the badge must still say ChatGPT.
    expect(resolveTabMark(webTab("chatgpt"))).toMatchObject({ kind: "codex", label: "ChatGPT" });
    expect(resolveTabMark(webTab("notebooklm"))?.label).toBe("NotebookLM");
  });

  it("falls back to the globe for a preset it does not know", () => {
    expect(resolveTabMark(webTab("unreleased-service"))?.kind).toBe("browser");
    expect(resolveTabMark(webTab(undefined))?.kind).toBe("browser");
  });

  it("draws a mark for every web preset", () => {
    for (const [presetId, mark] of Object.entries(WEB_PRESET_MARKS)) {
      const markup = renderToStaticMarkup(createElement(AgentKindIcon, { kind: mark.kind, chip: false }));
      expect(markup, `${presetId} draws nothing`).toContain("<svg");
    }
  });

  it("carries a colour for every mark, so the tab never falls back to a bare chip", () => {
    for (const mark of Object.values(WEB_PRESET_MARKS)) {
      expect(tabMarkColor(mark.kind).fg, mark.label).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("keeps resolving agent tabs the way the tab bar always did", () => {
    const tab: PaneTab = { id: "t1", sessionId: "s1", agentId: "a1", agentKind: "claude" };
    expect(resolveTabMark(tab)).toMatchObject({ kind: "claude", label: "Claude" });
    // Live metadata outranks the persisted field.
    expect(resolveTabMark(tab, "codex")?.kind).toBe("codex");
    expect(resolveTabMark({ id: "t2", sessionId: "s2", agentId: "a2", commandArgv: ["agy"] })?.kind)
      .toBe("antigravity");
    expect(resolveTabMark({ id: "t3", sessionId: "s3", agentId: "a3" })).toBeNull();
  });
});
