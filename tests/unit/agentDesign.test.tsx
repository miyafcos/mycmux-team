// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { agentDesignApi, type AgentDesignApi, type AgentDesignCatalog } from "../../src/lib/agentDesignApi";
import type { SkillCatalog, SkillRow } from "../../src/lib/skillsApi";
import { syntheticCatalog as fixture } from "../fixtures/agent_home/catalog";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), choose: vi.fn(), launch: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.choose, save: vi.fn() }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
vi.mock("../../src/components/skills/skillLaunch", () => ({ startSkill: mocks.launch }));
import { AgentDesignView } from "../../src/components/agentDesign/AgentDesignView";
import { AgentDesignPanel } from "../../src/components/agentDesign/AgentDesignPanel";
import { AgentDesignButton } from "../../src/components/agentDesign/AgentDesignButton";
import { agentDesignStrings as s } from "../../src/components/agentDesign/agentDesignStrings";
import { createReadOnlySkillsApi } from "../../src/components/agentDesign/readOnlySkillsApi";
import { skillsStrings } from "../../src/components/skills/skillsStrings";
import { SkillsView } from "../../src/components/skills/SkillsView";
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root, api: AgentDesignApi;
const shelf: SkillCatalog = { generatedAt: fixture.generatedAt, categories: [], skills: [], hiddenCount: 0, newCount: 0 };
beforeEach(() => {
  mocks.invoke.mockReset(); mocks.choose.mockReset(); mocks.launch.mockReset();
  mocks.invoke.mockImplementation(async (command: string) => command.startsWith("agent_design_skill") ? shelf : fixture);
  api = { peek: () => fixture, cached: vi.fn(async () => fixture), refresh: vi.fn(async () => fixture),
    document: vi.fn(async id => ({ id, body: "# Synthetic document", fields: [], size: fixture.items[0].size, status: "present" })),
    close: vi.fn(async () => ({ ...fixture, findings: [], closedCount: 1 })), scene: vi.fn(async () => ({ itemIds: [], chars: 0, evidence: "declaration" })),
    setHermesHome: vi.fn(async () => {}) };
  host = document.createElement("div"); host.dataset.cmuxThemedRoot = "true"; document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); document.body.replaceChildren(); });
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === text)!;
const key = async (value: string, target: Element | null = document.querySelector(".ad-view")) => { await act(async () => target!.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true }))); };
const click = async (text: string) => { const b = button(text); expect(b).toBeTruthy(); await act(async () => b.click()); };
async function view() { await act(async () => root.render(<AgentDesignView onClose={vi.fn()} api={api} initialCatalog={fixture} />)); }
function setInput(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}
describe("agent design stage A", () => {
  it("replaces the sole titlebar entry with the full agent design overlay", async () => {
    await act(async () => root.render(<AgentDesignButton />));
    const entry = document.querySelector<HTMLButtonElement>('button[aria-label="' + s.title + '"]')!;
    expect(entry.title).toBe(s.title); expect(entry.querySelector("svg")?.getAttribute("width")).toBe("12");
    await act(async () => entry.click()); expect(document.querySelector("#agent-design-panel .ad-view")).toBeTruthy();
    expect(document.querySelector(".skills-panel")).toBeNull(); expect(entry.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelectorAll(".ad-tabs button")).toHaveLength(4);
    await act(async () => document.querySelector<HTMLButtonElement>('.ad-header button[aria-label="' + s.close + '"]')!.click());
    expect(entry.getAttribute("aria-expanded")).toBe("false");
    const titlebar = readFileSync("src/components/layout/TitleBar.tsx", "utf8"); expect(titlebar).toMatch(/<AiLogButton\s*\/>\s*<AgentDesignButton\s*\/>\s*<DashboardButton\s*\/>/);
  });
  it("switches only the four implemented surfaces and preserves the service rail", async () => {
    await view();
    for (const [index, id] of ["overview", "reading", "compare", "inspection"].entries()) {
      await act(async () => document.querySelectorAll<HTMLButtonElement>(".ad-tabs button")[index].click());
      expect(document.querySelector('[data-ad-view="' + id + '"]')).toBeTruthy();
      expect(document.querySelectorAll(".ad-service")).toHaveLength(3);
    }
    expect(document.querySelector(".ad-tabs")?.textContent).not.toContain("履歴");
  });
  it("distinguishes commented MCP headers and absent Hermes files from present entries", async () => {
    const hermes = { ...fixture.services[2], state: "present" as const };
    const data: AgentDesignCatalog = { ...fixture, services: [fixture.services[0], { ...fixture.services[1], stats: { ...fixture.services[1].stats, mcp: 4, mcpDisabled: 0, mcpCommented: 2 } }, hermes],
      items: [...fixture.items, { ...fixture.items[0], id: "hermes:soul", service: "hermes", displayName: "SOUL.md", path: hermes.root + "/SOUL.md", active: false, status: "absent" }] };
    api.cached = async () => data; api.refresh = async () => data;
    await act(async () => root.render(<AgentDesignView onClose={vi.fn()} api={api} initialCatalog={data} />));
    await key("3");
    const mcp = document.querySelector('[data-ad-compare-row="10"]')!;
    expect(mcp.textContent).toContain(s.mcpCommented + " 2");
    expect(mcp.textContent).not.toContain(s.disabled + " 2");
    const soul = document.querySelector('[data-ad-compare-row="0"]')!.querySelectorAll("td")[2];
    expect(soul.querySelector("strong")?.textContent).toBe(s.absent);
    expect(soul.querySelector("small")?.textContent).toBe(hermes.root + "/SOUL.md");
  });
  it("shows the chosen session start and filename beneath the amount band on overview and reading", async () => {
    const startedAt = new Date(2026, 9, 7, 17, 16, 17).toISOString();
    const data: AgentDesignCatalog = { ...fixture, services: fixture.services.map(a => a.id === "claude" ? { ...a, session: { ...a.session, file: "latest-start.jsonl", startedAt } } : a) };
    api.cached = async () => data; api.refresh = async () => data;
    await act(async () => root.render(<AgentDesignView onClose={vi.fn()} api={api} initialCatalog={data} />));
    for (const surface of ["overview", "reading"]) {
      const origin = document.querySelector('[data-ad-view="' + surface + '"] .ad-amount .ad-session-origin');
      expect(origin?.textContent).toContain("10/7 17:16 " + s.sessionOrigin);
      expect(origin?.textContent).toContain("latest-start.jsonl");
      if (surface === "overview") await key("2");
    }
  });
  it("supports slash, number keys, layer arrows, Enter, and layered Escape", async () => {
    const close = vi.fn(); await act(async () => root.render(<AgentDesignPanel open onClose={close} api={api} initialCatalog={fixture} />));
    await key("/"); expect(document.activeElement?.getAttribute("aria-label")).toBe(s.search);
    await key("2", document.querySelector(".ad-view")); expect(document.querySelector('[data-ad-view="reading"]')).toBeTruthy();
    await key("3"); await key("ArrowDown"); expect(document.querySelector('tr[aria-selected="true"]')?.getAttribute("data-ad-compare-row")).toBe("1");
    await key("Enter", document.querySelector('tr[aria-selected="true"]')); expect(document.querySelector(".ad-compare-documents")).toBeTruthy();
    await key("Escape"); expect(document.querySelector(".ad-compare-documents")).toBeNull(); expect(close).not.toHaveBeenCalled();
    await key("1"); await key("ArrowUp"); expect(document.querySelector('[data-ad-layer="4"]')?.getAttribute("aria-selected")).toBe("true");
    await key("ArrowDown"); await key("Enter", document.querySelector('[data-ad-layer="3"]')); expect(document.querySelector(".ad-item-detail")).toBeTruthy();
    await key("Escape"); expect(document.querySelector(".ad-item-detail")).toBeNull(); await key("Escape"); expect(close).toHaveBeenCalledOnce();
  });
  it("keeps number shortcuts out of text inputs and filters by name", async () => {
    await view(); const input = document.querySelector<HTMLInputElement>('[aria-label="' + s.search + '"]')!;
    await act(async () => setInput(input, "reviewer")); await key("4", input); expect(document.querySelector('[data-ad-view="overview"]')).toBeTruthy();
    expect(document.querySelectorAll(".ad-layer")).toHaveLength(1); expect(document.querySelector(".ad-layer")?.getAttribute("data-ad-layer")).toBe("5"); await key("Escape", input); expect(input.value).toBe("");
  });
  it("opens stage1 SkillsView in place and returns to the overview in read-only mode", async () => {
    await view(); await click(s.openSkills); expect(document.querySelector(".skills-panel")).toBeTruthy();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0);
    expect(document.querySelector(".ad-rail")).toBeTruthy(); expect(mocks.invoke).toHaveBeenCalledWith("agent_design_skills", { cwd: fixture.cwd });
    await click(s.backOverview); expect(document.querySelector('[data-ad-view="overview"]')).toBeTruthy();
    expect(document.querySelector(".skills-panel")).toBeNull(); expect(mocks.launch).not.toHaveBeenCalled();
    expect(mocks.invoke.mock.calls.some(([command]) => command === "skills_refresh")).toBe(false);
  });
  it("closes a finding only after recording an inline reason and updates the count", async () => {
    await view(); await key("4"); const buttons = [...document.querySelectorAll<HTMLButtonElement>("button")].filter(b => b.textContent === s.closeIntentional);
    await act(async () => buttons[0].click()); const reason = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="' + s.reason + '"]')!;
    expect(button(s.saveClose).disabled).toBe(true);
    await act(async () => setInput(reason, "Intentional explicit invocation")); await click(s.saveClose);
    expect(api.close).toHaveBeenCalledWith("claude:unusedListing", "Intentional explicit invocation", "/synthetic/home");
    expect(document.body.textContent).toContain(s.noFindings); expect(document.body.textContent).toContain(s.closed);
  });
  it("shows stage C as an in-panel notice without changing source settings", async () => {
    await view(); await key("4"); await click(s.proposal); expect(document.querySelector('[role="status"]')?.textContent).toContain(s.stageC);
    expect(api.close).not.toHaveBeenCalled(); expect(mocks.launch).not.toHaveBeenCalled();
  });
  it("displays unsupported settings and allowed documents through the same detail shape", async () => {
    await view(); await act(async () => document.querySelector<HTMLElement>('[data-ad-layer="2"]')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>(".ad-item-list button")!.click()); expect(document.body.textContent).toContain(s.fieldNames.unsupported);
    await key("Escape"); await act(async () => document.querySelector<HTMLElement>('[data-ad-layer="3"]')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>(".ad-item-list button")!.click()); expect(document.querySelector(".ad-document")?.textContent).toContain("Synthetic document");
  });
  it("labels unsupported hook shapes in Japanese without showing command arguments", async () => {
    const data: AgentDesignCatalog = { ...fixture, services: fixture.services.map(a => a.id === "claude" ? { ...a, hooks: [{ event: "TaskCompleted", matcher: "", script: "unsupported", source: "/synthetic/settings.json", line: null }] } : a) };
    api.cached = async () => data; api.refresh = async () => data;
    await act(async () => root.render(<AgentDesignView onClose={vi.fn()} api={api} initialCatalog={data} />));
    await act(async () => document.querySelector<HTMLElement>('[data-ad-layer="6"]')!.click());
    expect(document.querySelector(".ad-hook-list")?.textContent).toContain(s.unsupported);
    expect(document.querySelector(".ad-hook-list")?.textContent).not.toContain("unsupported");
  });
  it("does not replace a fresh snapshot with a late disk cache", async () => {
    let resolve!: (c: AgentDesignCatalog) => void; api.cached = () => new Promise(r => { resolve = r; });
    api.refresh = async () => ({ ...fixture, closedCount: 3, findings: [] });
    await view(); await act(async () => resolve(fixture)); await key("4");
    expect(document.querySelectorAll(".ad-finding")).toHaveLength(0); expect(document.body.textContent).toContain("3");
  });
  it("changes the working folder and declared path scene without reading a conversation body", async () => {
    await view(); mocks.choose.mockResolvedValueOnce("/synthetic/project");
    api.refresh = vi.fn(async cwd => ({ ...fixture, cwd: cwd ?? fixture.home }));
    await click(s.chooseFolder); expect(api.refresh).toHaveBeenCalledWith("/synthetic/project");
    await key("2"); const input = document.querySelector<HTMLInputElement>('[aria-label="' + s.touchedPath + '"]')!;
    await act(async () => setInput(input, "src/example.tsx")); await click(s.checkScenario); expect(api.scene).toHaveBeenCalledWith("src/example.tsx", "/synthetic/project");
    expect(document.body.textContent).toContain(s.noConditional);
  });
  it("cancels the close form with Escape before closing the overlay", async () => {
    const close = vi.fn(); await act(async () => root.render(<AgentDesignPanel open onClose={close} api={api} initialCatalog={fixture} />));
    await key("4"); await click(s.closeIntentional); await key("Escape", document.querySelector("textarea"));
    expect(document.querySelector(".ad-close-form")).toBeNull(); expect(close).not.toHaveBeenCalled(); expect(api.close).not.toHaveBeenCalled();
  });
  it("navigates only the visible comparison rows after filtering", async () => {
    await view(); await key("3"); const input = document.querySelector<HTMLInputElement>('[aria-label="' + s.search + '"]')!;
    await act(async () => setInput(input, "MCP")); await key("ArrowDown");
    expect(document.querySelector('tr[aria-selected="true"]')?.getAttribute("data-ad-compare-row")).toBe("10");
    await key("Enter", document.querySelector('tr[aria-selected="true"]')); expect(document.querySelector(".ad-compare-documents")).toBeTruthy();
  });
  it("handles unavailable records and refresh failures with cached data still visible", async () => {
    api.refresh = vi.fn(async () => { throw new Error("unavailable"); });
    await view(); expect(document.querySelector('[data-ad-view="overview"]')).toBeTruthy(); expect(document.querySelector('[role="status"]')?.textContent).toContain(s.error);
  });
  it("keeps start, edit, repair, and sharing actions out of an embedded selected skill", async () => {
    const skill: SkillRow = { id: "sample", label: "Sample", description: "Synthetic", line: "Synthetic", kind: "own", plugin: null, category: "unsorted", symbol: null, glyph: "S", agents: ["claude", "codex"], aliases: [], curation: "manual", isNew: false, docPath: "/synthetic/sample/SKILL.md", calls: { claude: "/sample", codex: "$sample" }, usageCount: 0, usage: { claude: 0, codex: 0 }, lastUsedAt: null, body: "", triggers: null, modifiedAt: 0, fileSize: 100, codexRecorded: false };
    const data = { ...shelf, skills: [skill] };
    const readonly = { ...createReadOnlySkillsApi(), peek: () => data, cached: async () => data, refresh: async () => data,
      document: async () => ({ frontmatter: {}, body: "# Sample", html: "<h1>Sample</h1>", toc: [], lines: 1, size: 100, modifiedAt: 0 }),
      locations: async () => ({ id: "sample", duplicateCodex: false, codexCount: 1, items: [] }) };
    await act(async () => root.render(<SkillsView readOnly api={readonly} initialCatalog={data} onClose={vi.fn()} />));
    expect(document.querySelector(".skills-markdown h1")?.textContent).toBe("Sample");
    for (const label of [skillsStrings.startClaude, skillsStrings.startCodex, skillsStrings.share, skillsStrings.editor, skillsStrings.repair]) expect(button(label)).toBeUndefined();
    await act(async () => document.querySelector(".skills-panel")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })));
    expect(mocks.launch).not.toHaveBeenCalled(); expect(document.querySelector('[role="status"]')?.textContent).toContain(skillsStrings.readOnly);
  });
  it("updates the default-home cached view after closing through its explicit folder", async () => {
    await agentDesignApi.refresh(null);
    const closed = { ...fixture, findings: [], closedCount: 2 };
    mocks.invoke.mockResolvedValueOnce(closed);
    await agentDesignApi.close("claude:unusedListing", "Intentional", fixture.cwd);
    expect(agentDesignApi.peek(null)).toBe(closed);
    expect(agentDesignApi.peek(fixture.cwd)).toBe(closed);
  });
  it("keeps the embedded skill cache within the selected working folder", async () => {
    let folder = "/synthetic/home";
    const adapter = createReadOnlySkillsApi(() => folder);
    await adapter.refresh(); expect(adapter.peek()).toBe(shelf);
    folder = "/synthetic/project";
    expect(adapter.peek()).toBeNull(); expect(await adapter.cached()).toBeNull();
    const next = { ...shelf, generatedAt: "2026-10-07T01:01:00Z" };
    mocks.invoke.mockResolvedValueOnce(next);
    await adapter.refresh(); expect(adapter.peek()).toBe(next);
    expect(mocks.invoke).toHaveBeenLastCalledWith("agent_design_skills", { cwd: folder });
    folder = "/synthetic/home"; expect(adapter.peek()).toBe(shelf);
  });
  it("uses the read-only skill adapter and rejects export", async () => {
    const adapter = createReadOnlySkillsApi(); await adapter.refresh();
    expect(mocks.invoke).toHaveBeenCalledWith("agent_design_skills", { cwd: null }); expect(adapter.peek()).toBe(shelf);
    await expect(adapter.export("reviewer", [], "/synthetic/out.zip")).rejects.toThrow("readOnly");
    expect(mocks.invoke.mock.calls.some(([command]) => command === "skills_export")).toBe(false);
  });
});
