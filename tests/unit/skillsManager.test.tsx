// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SkillCatalog, SkillRow } from "../../src/lib/skillsApi";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), launch: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../../src/components/skills/skillLaunch", () => ({ startSkill: mocks.launch }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
import { SkillsView } from "../../src/components/skills/SkillsView";
import { SkillsPanel } from "../../src/components/skills/SkillsPanel";
import { SkillsButton } from "../../src/components/skills/SkillsButton";
import { skillsStrings as s } from "../../src/components/skills/skillsStrings";
import { symbolMap } from "../../src/components/skills/symbolMap";
import { searchSkills } from "../../src/components/skills/skillSearch";
import { skillsApi } from "../../src/lib/skillsApi";
import { createReadOnlySkillsApi } from "../../src/components/agentDesign/readOnlySkillsApi";

const row = (id: string, overrides: Partial<SkillRow> = {}): SkillRow => ({ id, label: id, description: "Sample description", line: "Sample line", kind: "own", plugin: null, category: "gate", symbol: "checkmark.shield", glyph: "S", agents: ["claude", "codex"], aliases: [], curation: "manual", isNew: false, docPath: `/sample/${id}/SKILL.md`, calls: { claude: `/${id}`, codex: `$${id}` }, usageCount: 4, usage: { claude: 2, codex: 2 }, lastUsedAt: null, body: "# Example\nThe body contains blueberry", triggers: ["special-trigger"], modifiedAt: 0, fileSize: 200, codexRecorded: true, ...overrides });
const catalog: SkillCatalog = { generatedAt: "2026-10-07T00:00:00Z", categories: [{ id: "gate", name: "Reviews", color: "#2FB36B", symbol: "checkmark.shield" }], skills: [row("alpha"), row("beta", { usageCount: 1, body: "# Other\n" })], hiddenCount: 0, newCount: 0 };
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  mocks.launch.mockReset(); mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string, args?: { action?: string }) => {
    if (command === "agent_design_skills") command = "skills_refresh";
    if (command === "agent_design_skill_read") command = "skills_" + args?.action;
    if (command === "skills_cached" || command === "skills_refresh") return catalog;
    if (command === "skills_document") return { frontmatter: { name: "alpha", description: "Sample", metadata: { triggers: ["review"], exclusions: ["publish"] }, "allowed-tools": ["Read"] }, body: "# Example", html: "<h1>Example</h1><p>blueberry</p>", toc: [{ level: 1, text: "Example" }], lines: 10, size: 200, modifiedAt: 0 };
    if (command === "skills_locations") return { id: "alpha", duplicateCodex: true, codexCount: 2, items: [{ path: "/sample/alpha/SKILL.md", relation: "source", lines: 10, modifiedAt: 0, fileCount: 2, allowImplicitInvocation: false, target: null, targetExists: null, descriptionSame: null, sameContent: null }] };
    if (command === "skills_folder") return { root: "/sample/alpha", rootName: "alpha", single: false, files: [{ path: "SKILL.md", name: "SKILL.md", depth: 0, dir: false, size: 200, reason: null }], entries: [{ path: "SKILL.md", name: "SKILL.md", depth: 0, dir: false, size: 200 }], selected: ["SKILL.md"], blocked: [{ path: ".env", name: ".env", reason: "private" }], limits: { bytes: 50 * 1024 * 1024, files: 5000 }, size: 200 };
    return null;
  });
  host = document.createElement("div"); host.dataset.cmuxThemedRoot = "true"; document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); document.body.replaceChildren(); });
async function panel() { await act(async () => root.render(<SkillsPanel open onClose={vi.fn()} initialCatalog={catalog} />)); }
function button(text: string): HTMLButtonElement { const result = [...document.querySelectorAll("button")].find(b => b.textContent === text); expect(result).toBeDefined(); return result!; }
async function click(text: string) { await act(async () => button(text).click()); }
function input(value: string) { const element = document.querySelector<HTMLInputElement>(`input[aria-label="${s.search}"]`)!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); }

describe("skills manager stage 1", () => {
  it("embeds without an overlay or portal and accepts the requested skill and close handler", async () => {
    const close = vi.fn();
    await act(async () => root.render(<SkillsView initialSkillId="beta" onClose={close} initialCatalog={catalog} />));
    expect(host.querySelector(".skills-columns")).toBeTruthy();
    expect(document.querySelector(".cmux-overlay-panel")).toBeNull();
    expect(document.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain("beta");
    await act(async () => document.querySelector<HTMLInputElement>(`input[aria-label="${s.search}"]`)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(document.activeElement?.textContent).toBe(s.tabs.content);
    await act(async () => document.querySelector<HTMLButtonElement>(`button[aria-label="${s.close}"]`)!.click());
    expect(close).toHaveBeenCalledOnce();
    await act(async () => root.render(<SkillsView initialSkillId="alpha" onClose={close} initialCatalog={catalog} />));
    expect(document.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain("alpha");
  });
  it("opens and closes the read-only shelf from its own 12px title-bar button", async () => {
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args?: { action?: string }) =>
      command === "agent_design_cached" || command === "agent_design_refresh" ? { home: "/sample", cwd: "/sample" } : original(command, args));
    await act(async () => root.render(<SkillsButton />)); const entry = document.querySelector<HTMLButtonElement>(`button[aria-label="${s.title}"]`)!;
    expect(entry.querySelector("svg")?.getAttribute("width")).toBe("12"); expect(entry.querySelector("svg")?.getAttribute("stroke-width")).toBe("2");
    await act(async () => entry.click()); expect(document.querySelector("#skills-panel .skills-panel")).toBeTruthy(); expect(entry.getAttribute("aria-expanded")).toBe("true");
    await act(async () => document.querySelector<HTMLButtonElement>(`button[aria-label="${s.close}"]`)!.click()); expect(entry.getAttribute("aria-expanded")).toBe("false");
    expect(mocks.invoke.mock.calls.some(([command]) => command === "agent_design_skills")).toBe(true);
    expect(mocks.invoke.mock.calls.some(([command]) => command === "skills_refresh")).toBe(false);
  });
  it("shows live read-only usage and manual categories, then rereads on refresh and reopen", async () => {
    const original = mocks.invoke.getMockImplementation()!;
    let version = 0;
    const fresh = (): SkillCatalog => ({ ...catalog,
      categories: [{ id: "sample-manual", name: "Manual shelf", color: "#64748B", symbol: null }],
      skills: [row("alpha", { label: "Zulu sample", category: "sample-manual", usage: { claude: 11 + version, codex: 1 }, usageCount: 12 + version,
        usageRecords: { sampledAt: catalog.generatedAt,
          claude: { status: "available", count: 11 + version, lastAt: null, source: "skillUsage" },
          codex: { status: "available", count: 1, lastAt: null, source: "usage_codex.json", days: 90 } } }),
        row("beta", { label: "Alpha sample", category: "unsorted", usage: { claude: 0, codex: 0 }, usageCount: 0,
          usageRecords: { sampledAt: catalog.generatedAt,
            claude: { status: "available", count: 0, lastAt: null, source: "skillUsage" },
            codex: { status: "available", count: 0, lastAt: null, source: "usage_codex.json", days: 90 } } })],
    });
    mocks.invoke.mockImplementation(async (command: string, args?: { action?: string }) =>
      command === "agent_design_skills" ? fresh() : original(command, args));
    const api = createReadOnlySkillsApi();
    const mount = () => root.render(<SkillsView readOnly api={api} onClose={vi.fn()} />);
    const options = () => [...document.querySelectorAll<HTMLTableRowElement>('.skills-explorer-list [role="option"]')];
    const ids = () => options().map(option => option.querySelector("th small")?.textContent);
    const usage = (id = "alpha") => [...options().find(option => option.querySelector("th small")?.textContent === id)!.querySelectorAll("td")]
      .slice(3, 5).map(cell => cell.firstChild?.textContent);
    await act(async () => mount());
    expect(usage()).toEqual(["11 回の呼び出し", "1 会話"]);
    expect(usage("beta")).toEqual(["記録なし（0）", "記録なし（0）"]);
    expect(ids()).toEqual(["beta", "alpha"]);
    const sort = document.querySelector<HTMLSelectElement>('select[aria-label="スキルの並び順"]')!;
    await act(async () => { sort.value = "claude"; sort.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(ids()).toEqual(["alpha", "beta"]);
    const category = [...document.querySelectorAll<HTMLButtonElement>(".skills-shelves button")].find(button => button.textContent?.includes("Manual shelf"))!;
    await act(async () => category.click());
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
    expect(document.querySelector('[role="option"]')?.textContent).toContain("alpha");
    version = 1;
    await click("読み直す");
    expect(usage()).toEqual(["12 回の呼び出し", "1 会話"]);
    await act(async () => root.render(<div />));
    version = 2;
    await act(async () => mount());
    expect(usage()).toEqual(["13 回の呼び出し", "1 会話"]);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "agent_design_skills")).toHaveLength(3);
    expect(mocks.invoke.mock.calls.some(([command]) => command === "skills_refresh" || command === "skills_cached")).toBe(false);
  });
  it("renders three columns, frontmatter chips, safe content, and in-panel notices", async () => {
    await panel(); expect(document.querySelectorAll(".skills-columns>nav,.skills-columns>section")).toHaveLength(3);
    expect(document.querySelector(".skills-frontmatter")?.textContent).toContain("review"); expect(document.querySelector(".skills-frontmatter")?.textContent).toContain("Read");
    expect(document.querySelector(".skills-markdown h1")?.textContent).toBe("Example"); expect(document.body.textContent).toContain(s.duplicateWarning);
    expect(document.querySelector(".skills-toc")).toBeTruthy();
  });
  it("filters per character and groups body matches with a highlighted snippet", async () => {
    await panel(); await act(async () => input("blueberry")); expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
    expect(document.querySelector(".skills-match-group")?.textContent).toBe(s.groups.body); expect(document.querySelector(".skills-snippet")?.textContent).toContain("blueberry"); expect(document.querySelector(".skills-snippet mark")?.textContent).toBe("blueberry"); expect(document.querySelector(".skills-markdown mark")?.textContent).toBe("blueberry");
  });
  it("supports slash, arrows, Enter, and both start shortcuts", async () => {
    await panel(); const surface = document.querySelector<HTMLElement>(".skills-panel")!;
    await act(async () => surface.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true }))); expect(document.activeElement?.getAttribute("aria-label")).toBe(s.search);
    await act(async () => surface.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))); expect(document.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain("beta");
    await act(async () => document.querySelector<HTMLInputElement>(`input[aria-label="${s.search}"]`)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(document.activeElement?.textContent).toBe(s.tabs.content);
    await act(async () => surface.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }))); expect(mocks.launch).toHaveBeenCalledWith(expect.objectContaining({ id: "beta" }), "claude");
    await act(async () => surface.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, shiftKey: true, bubbles: true }))); expect(mocks.launch).toHaveBeenCalledWith(expect.objectContaining({ id: "beta" }), "codex");
  });
  it("shows read-only locations and collapses the list when expanded", async () => {
    await panel(); await click(s.tabs.places); expect(document.body.textContent).toContain(s.relations.source); expect(document.body.textContent).toContain(s.readOnly);
    await click(s.expand); expect(document.querySelector(".skills-rail")).toBeTruthy(); expect(document.querySelector(".skills-list")).toBeNull(); await click(s.collapse); expect(document.querySelector(".skills-rail")).toBeTruthy();
  });
  it("shows folder privacy labels and locks the shared document", async () => {
    await panel(); await click(s.share); const file = document.querySelector<HTMLInputElement>('.skills-share-row input')!; expect(file.checked).toBe(true); expect(file.disabled).toBe(true); expect(document.body.textContent).toContain(s.reasons.private);
  });
  it("does not lose a fresh snapshot to a slower disk cache", async () => {
    let resolveCache!: (value: SkillCatalog) => void; const api = { ...skillsApi, peek: () => null, cached: () => new Promise<SkillCatalog>(resolve => { resolveCache = resolve; }), refresh: async () => ({ ...catalog, skills: [row("fresh")] }) };
    await act(async () => root.render(<SkillsPanel open onClose={vi.fn()} api={api} />)); await act(async () => resolveCache(catalog)); expect(document.querySelector('[role="option"]')?.textContent).toContain("fresh");
  });
  it("refreshes the selected document after its source changes", async () => {
    let version = 0;
    const api = { ...skillsApi, peek: () => catalog, cached: async () => catalog,
      refresh: async () => ({ ...catalog, skills: catalog.skills.map(row => ({ ...row, modifiedAt: version })) }),
      document: async (id: string) => ({ ...await skillsApi.document(id), html: `<h1>Version ${version}</h1>` }),
    };
    await act(async () => root.render(<SkillsPanel open onClose={vi.fn()} api={api} />));
    expect(document.querySelector(".skills-markdown h1")?.textContent).toBe("Version 0");
    version = 1;
    await act(async () => document.querySelector<HTMLButtonElement>(`button[aria-label="${s.refresh}"]`)!.click());
    expect(document.querySelector(".skills-markdown h1")?.textContent).toBe("Version 1");
  });
  it("maps every catalogue symbol and keeps the entry between AI log and dashboard", () => {
    const symbols = JSON.parse(readFileSync(resolve("tests/fixtures/skills_home/symbols.json"), "utf8")) as string[];
    for (const symbol of symbols) expect(symbolMap[symbol], symbol).toBeDefined();
    const titlebar = readFileSync(resolve("src/components/layout/TitleBar.tsx"), "utf8"); expect(titlebar).toMatch(/<AiLogButton\s*\/>\s*<AgentDesignButton\s*\/>\s*<SkillsButton\s*\/>\s*<DashboardButton\s*\/>/);
  });
  it("searches names, descriptions, triggers, and full bodies in that order", () => {
    const result = searchSkills([row("one", { line: "needle" }), row("two", { triggers: ["needle"] }), row("three", { body: "needle" })], "needle");
    expect(result.map(match => match.group)).toEqual(["name", "trigger", "body"]);
  });
});
