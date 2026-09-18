import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentKindIcon } from "../../src/components/icons/AgentIcons";
import { ARTIFACT_MARK_COLORS, resolveTabMark, tabMarkColor, type ArtifactMarkKind } from "../../src/lib/tabMark";
import type { ArtifactSourceKind, PaneTab } from "../../src/types";

function artifact(sourceKind: ArtifactSourceKind, sourcePath?: string): PaneTab {
  return { id: "artifact", sessionId: "session", agentId: "agent", type: "browser", sourceKind, sourcePath };
}

const cases: [ArtifactSourceKind, string, ArtifactMarkKind, string][] = [
  ["html", "report.html", "html", "HTML"],
  ["markdown", "report.md", "markdown", "Markdown"],
  ["text", "notes.txt", "text", "Text"],
  ["text", "run.log", "text", "Text"],
  ["pdf", "report.pdf", "pdf", "PDF"],
  ["office", "report.docx", "word", "Word"],
  ["office", "report.xlsx", "excel", "Excel"],
  ["office", "report.pptx", "powerpoint", "PowerPoint"],
  ["office", "report.unknown", "office", "Office"],
];

describe("artifact tab marks", () => {
  it.each(cases)("resolves %s %s to %s with label %s", (sourceKind, path, kind, label) => {
    expect(resolveTabMark(artifact(sourceKind, path))).toEqual({ kind, label, color: ARTIFACT_MARK_COLORS[kind] });
    expect(resolveTabMark(artifact(sourceKind, path), "codex")?.kind).toBe(kind);
  });

  it.each([
    ["word", "doc docx docm dot dotx dotm"],
    ["excel", "xls xlsx xlsm xlsb xlt xltx xltm"],
    ["powerpoint", "ppt pptx pptm pot potx potm pps ppsx ppsm"],
  ])("recognizes all %s extensions including uppercase Windows paths", (kind, extensions) => {
    for (const extension of extensions.split(" ")) {
      for (const ext of [extension, extension.toUpperCase()]) {
        expect(resolveTabMark(artifact("office", `C:\\reports\\report.${ext}`))?.kind).toBe(kind);
      }
    }
  });

  it("keeps unknown and missing Office extensions generic", () => {
    for (const path of [undefined, "report", "report.docx.bak", "report.odt", "C:/folder.docx/report"]) {
      expect(resolveTabMark(artifact("office", path))).toMatchObject({ kind: "office", label: "Office" });
    }
  });

  it("uses the declared source kind rather than a converted preview extension", () => {
    expect(resolveTabMark(artifact("markdown", "report.html"))?.kind).toBe("markdown");
    expect(resolveTabMark({ id: "a", sessionId: "s", agentId: "a", type: "browser" })).toBeNull();
  });

  it.each([
    ["browser", "browser"], ["chatgpt", "codex"], ["gemini", "gemini"],
    ["grok", "grok"], ["claude", "claude"], ["notebooklm", "notebooklm"],
  ])("preserves the %s Web preset even when artifact metadata is present", (presetId, kind) => {
    const plain: PaneTab = { id: "web", sessionId: "s", agentId: "a", type: "web", presetId };
    expect(resolveTabMark({ ...plain, sourceKind: "pdf", sourcePath: "report.pdf" }, "hermes")).toEqual(resolveTabMark(plain));
    expect(resolveTabMark(plain)?.kind).toBe(kind);
  });

  it.each([
    ["claude", "Claude"], ["codex", "Codex"], ["claude-codex", "Hybrid"],
    ["grok", "Grok"], ["antigravity", "Antigravity"], ["hermes", "Hermes"],
  ])("preserves the %s agent mark and label", (kind, label) => {
    const tab: PaneTab = { id: "t", sessionId: "s", agentId: "a", type: "terminal", agentKind: kind, commandArgv: [kind === "antigravity" ? "agy" : kind] };
    expect(resolveTabMark(tab)).toEqual({ kind, label, color: tabMarkColor(kind as Parameters<typeof tabMarkColor>[0]) });
    expect(resolveTabMark({ ...tab, sourceKind: "pdf" })).toEqual(resolveTabMark(tab));
    expect(resolveTabMark(tab, "codex")).toMatchObject({ kind: "codex", label: "Codex" });
  });

  it.each(Object.keys(ARTIFACT_MARK_COLORS) as ArtifactMarkKind[])("renders %s at 12px on a 24-unit grid with strokes at least 2", (kind) => {
    const markup = renderToStaticMarkup(createElement(AgentKindIcon, { kind, size: 12, chip: false }));
    expect(markup).toContain('width="12"');
    expect(markup).toContain('height="12"');
    expect(markup).toContain('viewBox="0 0 24 24"');
    expect(markup).toContain(`fill="${ARTIFACT_MARK_COLORS[kind].fg}"`);
    const strokes = [...markup.matchAll(/stroke-width="([\d.]+)"/g)];
    if (["html", "word", "excel"].includes(kind)) {
      expect(markup).toMatch(/<path[^>]*fill="#fff"/);
      expect(strokes).toHaveLength(0);
    } else {
      expect(strokes.length).toBeGreaterThan(0);
    }
    for (const stroke of strokes) expect(Number(stroke[1])).toBeGreaterThanOrEqual(2);
    const chip = renderToStaticMarkup(createElement(AgentKindIcon, { kind, size: 14 }));
    expect(chip).toContain("border-color:");
    expect(chip).toContain('width="11"');
  });
});
