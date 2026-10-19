// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import type { AgentDesignApi, AgentDesignExportApi } from "../../src/lib/agentDesignApi";
import type { SkillCatalog, SkillRow } from "../../src/lib/skillsApi";
import { syntheticCatalog as catalog } from "../fixtures/agent_home/catalog";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), launch: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
vi.mock("../../src/components/skills/skillLaunch", () => ({ startSkill: mocks.launch }));
import { AgentDesignView } from "../../src/components/agentDesign/AgentDesignView";
import { ComparisonView } from "../../src/components/agentDesign/ComparisonView";
import { ExportView } from "../../src/components/agentDesign/ExportView";
import { HistoryView } from "../../src/components/agentDesign/HistoryView";
import { InspectionView } from "../../src/components/agentDesign/InspectionView";
import { SkillsView } from "../../src/components/skills/SkillsView";
import { skillsStrings as skillStrings } from "../../src/components/skills/skillsStrings";
import { agentDesignStrings } from "../../src/components/agentDesign/agentDesignStrings";
import { agentServiceVisibilityStrings as T } from "../../src/lib/agentServiceVisibilityStrings";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useAgentServiceDetectionStore } from "../../src/stores/agentServiceDetectionStore";
import { skillsApi } from "../../src/lib/skillsApi";
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView = () => {};
const row = (id: string, agent: string): SkillRow => ({ id, label: id, description: "sample", line: "sample", kind: "own", plugin: null, category: "gate", symbol: null, glyph: "S", agents: [agent], aliases: [], curation: "manual", isNew: false, docPath: null, calls: { claude: "/" + id, codex: "$" + id }, usageCount: 4, usage: { claude: 2, codex: 2 }, lastUsedAt: null, body: "sample", triggers: [], modifiedAt: 0, fileSize: 200, codexRecorded: true });
const shelf: SkillCatalog = { generatedAt: catalog.generatedAt, categories: [], skills: [row("alpha", "codex"), row("beta", "claude")], hiddenCount: 0, newCount: 0 };
let host: HTMLDivElement, root: Root, api: AgentDesignApi, exportApi: AgentDesignExportApi;
beforeEach(() => {
  mocks.invoke.mockReset(); mocks.launch.mockReset();
  mocks.invoke.mockImplementation(async (command: string) => command === "skills_cached" || command === "skills_refresh" ? shelf : command === "skills_locations" ? { items: [], duplicateCodex: false, codexCount: 0 } : null);
  useSettingsStore.setState({ agentServiceVisibility: {} });
  useAgentServiceDetectionStore.setState({ detection: { status: "idle" } });
  api = { peek: () => catalog, cached: vi.fn(async () => catalog), refresh: vi.fn(async () => catalog),
    document: vi.fn(async id => ({ id, body: "", fields: [], size: catalog.items[0].size, status: "present" })),
    close: vi.fn(async () => catalog), scene: vi.fn(async () => ({ itemIds: [], chars: 0, evidence: "declaration" })), setHermesHome: vi.fn(async () => {}),
    history: vi.fn(async () => ({ schemaVersion: 1, snapshotCount: 0, capturedAt: catalog.generatedAt, writing: false, warnings: [], changes: [], snapshots: [] })),
  };
  const preview = { fingerprint: "fixture", omissions: [], hits: [], documentCount: 0, bytes: 10 };
  exportApi = { documents: vi.fn(async () => []), preview: vi.fn(async () => preview), save: vi.fn(async () => ({ saved: true, path: "/synthetic/report.html", preview })), names: vi.fn(async () => ({ path: "/synthetic/names", content: "" })), saveNames: vi.fn(async () => {}) };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });
async function render(node: ReactNode) { await act(async () => root.render(node)); }
async function hide(...targets: string[]) { await act(async () => { for (const target of targets) useSettingsStore.getState().setAgentServiceVisible(target, false); }); }
async function choose(selector: string, value: string) { await act(async () => { const field = host.querySelector<HTMLSelectElement>(selector)!; field.value = value; field.dispatchEvent(new Event("change", { bubbles: true })); }); }
async function key(shift = false) { await act(async () => host.querySelector(".skills-panel")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, shiftKey: shift, bubbles: true }))); }

describe("agent-design choices (T7)", () => {
  it("moves the selected service to the first visible service and has a usable all-hidden state", async () => {
    await render(<AgentDesignView api={api} initialCatalog={catalog} onClose={vi.fn()} skillApi={skillsApi} />);
    await hide("claude");
    expect(host.querySelector('.ad-service[aria-pressed="true"]')?.textContent).toContain("Codex");
    expect([...host.querySelectorAll(".ad-service")].some(node => node.textContent?.includes("Claude Code"))).toBe(false);
    await hide("codex", "hermes");
    expect(host.querySelectorAll(".ad-service")).toHaveLength(0);
    expect(host.textContent).toContain(T.agentDesignNone);
    const skills = [...host.querySelectorAll<HTMLButtonElement>(".ad-tabs button")].find(node => node.textContent === agentDesignStrings.skills)!;
    await act(async () => skills.click());
    expect(host.querySelectorAll('.skills-explorer [role="option"]')).toHaveLength(2);
  });
  it("preserves the original 29/29/17 comparison column widths with all services visible", async () => {
    await render(<ComparisonView catalog={catalog} api={api} query="" selectedRow={0} setSelectedRow={vi.fn()} opened={false} setOpened={vi.fn()} onSkill={vi.fn()} onOpen={vi.fn()} />);
    expect([...host.querySelectorAll<HTMLTableColElement>(".ad-compare-table col")].map(col => col.style.width)).toEqual(["14%", "29%", "29%", "17%", "11%"]);
  });
  it.each(["claude", "codex", "hermes"])("redistributes 75 percent by the original weights when %s is hidden", async (target) => {
    await hide(target);
    await render(<ComparisonView catalog={catalog} api={api} query="" selectedRow={0} setSelectedRow={vi.fn()} opened={false} setOpened={vi.fn()} onSkill={vi.fn()} onOpen={vi.fn()} />);
    const weights = { claude: 29, codex: 29, hermes: 17 };
    const services = catalog.services.filter(service => service.id !== target);
    const total = services.reduce((sum, service) => sum + weights[service.id], 0);
    const widths = [...host.querySelectorAll<HTMLTableColElement>(".ad-compare-table col")].slice(1, -1).map(col => parseFloat(col.style.width));
    expect(widths).toHaveLength(2);
    services.forEach((service, index) => expect(widths[index]).toBeCloseTo(75 * weights[service.id] / total, 8));
    expect(widths.reduce((sum, width) => sum + width, 0)).toBeCloseTo(75, 8);
  });
  it("removes comparison columns and export checks and excludes hidden export payloads", async () => {
    useSettingsStore.setState({ agentServiceVisibility: { codex: false, hermes: false } });
    await render(<ComparisonView catalog={catalog} api={api} query="" selectedRow={0} setSelectedRow={vi.fn()} opened={false} setOpened={vi.fn()} onSkill={vi.fn()} onOpen={vi.fn()} />);
    const header = host.querySelector(".ad-compare-table thead")!.textContent!;
    expect(header).toContain("Claude Code"); expect(header).not.toMatch(/Codex|Hermes/);
    expect(host.querySelectorAll(".ad-compare-table col")).toHaveLength(3);
    vi.useFakeTimers();
    await render(<ExportView catalog={catalog} api={exportApi} />);
    await act(async () => vi.advanceTimersByTimeAsync(220));
    const checks = host.querySelector(".ad-export-checks")!.textContent!;
    expect(checks).toContain("Claude Code"); expect(checks).not.toMatch(/Codex|Hermes/);
    expect(exportApi.preview).toHaveBeenLastCalledWith(expect.objectContaining({ services: ["claude"] }), catalog.cwd);
  });
  it("filters history and inspection choices while retaining all findings and history snapshots", async () => {
    await render(<HistoryView catalog={catalog} api={api} query="" />);
    await choose('select[aria-label="履歴のサービス"]', "codex");
    await hide("codex", "hermes");
    const field = host.querySelector<HTMLSelectElement>('select[aria-label="履歴のサービス"]')!;
    expect(field.value).toBe("claude");
    expect([...field.options].map(option => option.value)).toEqual(["all", "claude"]);
    await render(<InspectionView catalog={catalog} api={api} query="" selectedId={null} setSelectedId={vi.fn()} update={vi.fn()} notify={vi.fn()} openItem={vi.fn()} onSkill={vi.fn()} />);
    expect([...host.querySelectorAll('select[aria-label="点検するサービス"] option')].map(option => option.getAttribute("value"))).toEqual(["all", "claude"]);
    expect(host.querySelectorAll(".ad-findings tbody tr")).toHaveLength(catalog.findings.length);
    expect(catalog.services).toHaveLength(3);
    await act(async () => useSettingsStore.getState().setAgentServiceVisible("codex", true));
    await choose('select[aria-label="点検するサービス"]', "codex");
    await hide("codex");
    expect(host.querySelector<HTMLSelectElement>('select[aria-label="点検するサービス"]')!.value).toBe("claude");
  });
});

describe("skills choices and preserved records (T8)", () => {
  it("hides launch and repair buttons, blocks hidden keyboard launches, and preserves skill rows and calls", async () => {
    await render(<SkillsView api={skillsApi} initialCatalog={shelf} initialSkillId="alpha" onClose={vi.fn()} />);
    await key(true); expect(mocks.launch).toHaveBeenCalledWith(expect.objectContaining({ id: "alpha" }), "codex");
    mocks.launch.mockClear();
    await hide("codex");
    expect(host.querySelector('select[aria-label="' + skillStrings.filterAgent + '"] option[value="codex"]')).toBeNull();
    expect([...host.querySelectorAll("button")].some(button => button.textContent === skillStrings.startCodex)).toBe(false);
    expect(host.querySelector(".skills-calls")!.textContent).toContain("$alpha");
    expect(host.querySelectorAll('.skills-rows [role="option"]')).toHaveLength(2);
    await key(true); expect(mocks.launch).not.toHaveBeenCalled();
    await key(); expect(mocks.launch).toHaveBeenCalledWith(expect.objectContaining({ id: "alpha" }), "claude");
    mocks.launch.mockClear(); await hide("claude");
    await key(); await key(true); expect(mocks.launch).not.toHaveBeenCalled();
    expect([...host.querySelectorAll("button")].some(button => button.textContent === skillStrings.startClaude || button.textContent === skillStrings.repair)).toBe(false);
  });
  it("removes read-only filters, sorts and columns without removing service/call contents or rows", async () => {
    await render(<SkillsView api={skillsApi} initialCatalog={shelf} readOnly onClose={vi.fn()} />);
    await choose('select[aria-label="サービスで絞る"]', "codex");
    await choose('select[aria-label="スキルの並び順"]', "codex");
    expect(host.querySelectorAll('.skills-explorer-list [role="option"]')).toHaveLength(1);
    await hide("codex");
    expect(host.querySelector<HTMLSelectElement>('select[aria-label="サービスで絞る"]')!.value).toBe("all");
    expect(host.querySelector<HTMLSelectElement>('select[aria-label="スキルの並び順"]')!.value).toBe("name");
    expect(host.querySelectorAll('option[value="codex"]')).toHaveLength(0);
    expect(host.querySelector(".skills-dense-table thead")!.textContent).not.toContain("Codex 会話数");
    expect(host.querySelectorAll('.skills-explorer-list [role="option"]')).toHaveLength(2);
    expect(host.querySelector(".skills-dense-table tbody")!.textContent).toContain("codex");
    expect(host.querySelector(".skills-dense-table tbody")!.textContent).toContain("$alpha");
  });
});
