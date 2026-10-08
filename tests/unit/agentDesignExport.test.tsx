// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExportView } from "../../src/components/agentDesign/ExportView";
import { AgentDesignView } from "../../src/components/agentDesign/AgentDesignView";
import { agentDesignExportApi, type AgentDesignExportApi, type AgentExportPreview, type AgentDesignApi, type ExportDocument } from "../../src/lib/agentDesignApi";
import { syntheticCatalog as catalog } from "../fixtures/agent_home/catalog";
const mocks = vi.hoisted(() => ({ save: vi.fn(), invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: mocks.save, open: vi.fn() }));
vi.mock("@tauri-apps/api/core", async importOriginal => ({ ...await importOriginal<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("../../src/components/skills/skillLaunch", () => ({ startSkill: vi.fn() }));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const docs: ExportDocument[] = [
  { id: "rule", service: "claude", layer: 3, label: "public-rule.md", path: "~/.claude/rules/public-rule.md", sectioned: false, available: true, sections: [] },
  { id: "instruction", service: "claude", layer: 3, label: "CLAUDE.md", path: "~/.claude/CLAUDE.md", sectioned: true, available: true, sections: [{ id: "section-1", label: "Public heading", chars: 20 }, { id: "section-3", label: "Private heading", chars: 15 }] },
];
const clean: AgentExportPreview = { fingerprint: "fixture-hash", hits: [], bytes: 1200, documentCount: 0,
  omissions: [{ kind: "memory", label: "記憶と記録", reason: "いつも外す。", count: 2 }, { kind: "secret", label: "秘密", reason: "いつも外す。", count: 0 }, { kind: "document", label: "public-rule.md", reason: "本文を選んでいない。", count: 1 }] };
let root: Root, host: HTMLDivElement, api: AgentDesignExportApi;
beforeEach(() => {
  vi.useFakeTimers(); mocks.save.mockReset(); mocks.invoke.mockReset();
  mocks.save.mockResolvedValue("/synthetic/evidence/book.html");
  api = { documents: vi.fn(async () => docs), preview: vi.fn(async () => clean),
    save: vi.fn(async () => ({ saved: true, path: "/synthetic/evidence/book.html", preview: clean })),
    names: vi.fn(async () => ({ path: "~/.mycmux/agent_design/export-names.txt", content: "fictional_person" })), saveNames: vi.fn(async () => {}) };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); document.body.replaceChildren(); vi.useRealTimers(); });
const button = (label: string) => Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(b => b.textContent === label)!;
async function settle() { await act(async () => { await vi.advanceTimersByTimeAsync(250); }); }
async function render() { await act(async () => root.render(<ExportView catalog={catalog} api={api} />)); await settle(); }
async function click(label: string) { await act(async () => button(label).click()); await settle(); }
async function check(label: string) {
  const input = Array.from(host.querySelectorAll<HTMLInputElement>("input[type=checkbox]")).find(i => (i.getAttribute("aria-label")?.startsWith(label) || i.parentElement?.textContent?.trim().startsWith(label)))!;
  expect(input).toBeTruthy(); await act(async () => input.click()); await settle();
}
describe("agent design export", () => {
  it("keeps the export surface and key 6 beside the mechanism and four established views", async () => {
    const base: AgentDesignApi = { peek: () => catalog, cached: async () => catalog, refresh: async () => catalog, document: vi.fn(), close: vi.fn(), scene: vi.fn(), setHermesHome: vi.fn() };
    await act(async () => root.render(<AgentDesignView onClose={vi.fn()} api={base} exportApi={api} initialCatalog={catalog} />));
    expect(host.querySelectorAll(".ad-tabs button")).toHaveLength(8);
    expect(host.querySelectorAll(".ad-tabs button")[7].textContent).toBe("書き出し");
    await act(async () => host.querySelector(".ad-view")!.dispatchEvent(new KeyboardEvent("keydown", { key: "6", bubbles: true }))); await settle();
    expect(host.querySelector('[data-ad-view="export"]')).toBeTruthy();
    await act(async () => host.querySelector<HTMLInputElement>(".ad-search input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true })));
    expect(host.querySelector('[data-ad-view="export"]')).toBeTruthy();
  });
  it("starts with every body and heading excluded and shows omissions before save", async () => {
    await render();
    const checkboxes = host.querySelectorAll<HTMLInputElement>(".ad-export-documents input");
    expect(Array.from(checkboxes).every(i => !i.checked)).toBe(true);
    expect(api.preview).toHaveBeenLastCalledWith(expect.objectContaining({ documents: [] }), catalog.cwd);
    const omissions = host.querySelector(".ad-export-omissions")!;
    expect(omissions.textContent).toContain("記憶と記録"); expect(omissions.textContent).toContain("本文を選んでいない");
    expect(omissions.compareDocumentPosition(button("設計書を保存")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(button("設計書を保存").disabled).toBe(false);
  });
  it("distinguishes repeated omission names by home-relative paths and shows the memory count", async () => {
    api.preview = vi.fn(async () => ({ ...clean, omissions: [
      { kind: "memory", label: "記憶と記録", reason: "いつも外す。", count: 0 },
      { kind: "document", label: "CLAUDE.md", reason: "本文を選んでいない。", count: 1, path: "~/.claude/CLAUDE.md" },
      { kind: "document", label: "CLAUDE.md", reason: "本文を選んでいない。", count: 1, path: "~/project/CLAUDE.md" },
      { kind: "document", label: "unique.md", reason: "本文を選んでいない。", count: 1, path: "~/.claude/rules/unique.md" },
    ] }));
    await render();
    const rows = Array.from(host.querySelectorAll(".ad-export-omissions li"));
    const sameNames = rows.filter(row => row.querySelector("strong")?.textContent === "CLAUDE.md");
    expect(sameNames.map(row => row.querySelector(".ad-path")?.textContent)).toEqual(["~/.claude/CLAUDE.md", "~/project/CLAUDE.md"]);
    const memory = rows.filter(row => row.querySelector("strong")?.textContent === "記憶と記録");
    expect(memory).toHaveLength(1); expect(memory[0].textContent).toContain("0 件"); expect(memory[0].textContent).toContain("いつも外す");
    expect(rows.find(row => row.querySelector("strong")?.textContent === "unique.md")?.querySelector(".ad-path")).toBeNull();
  });
  it("selects one body and one explicit heading and deselects them", async () => {
    await render(); await check("public-rule.md"); await check("Public heading");
    expect(api.preview).toHaveBeenLastCalledWith(expect.objectContaining({ documents: [{ id: "rule", sections: null }, { id: "instruction", sections: ["section-1"] }] }), catalog.cwd);
    await check("public-rule.md"); await check("Public heading");
    expect(api.preview).toHaveBeenLastCalledWith(expect.objectContaining({ documents: [] }), catalog.cwd);
  });
  it("filters service and layer choices and always disables memory", async () => {
    await render(); await check("public-rule.md"); await check("Claude Code");
    expect(api.preview).toHaveBeenLastCalledWith(expect.objectContaining({ services: ["codex", "hermes"], documents: [] }), catalog.cwd);
    const memory = Array.from(host.querySelectorAll<HTMLInputElement>("input")).find(i => i.parentElement?.textContent?.includes("いつも外す"))!;
    expect(memory.disabled).toBe(true); expect(memory.checked).toBe(false);
    await check("3 "); expect(api.preview).toHaveBeenLastCalledWith(expect.objectContaining({ layers: [1, 2, 5, 6, 7] }), catalog.cwd);
  });
  it("shows a matched term and location and blocks the save dialog", async () => {
    api.preview = vi.fn(async () => ({ ...clean, hits: [{ kind: "list", term: "fictional_person", line: 42 }] }));
    await render(); expect(host.textContent).toContain("保存を止める名前 1 件"); expect(host.textContent).toContain("HTML 42 行");
    expect(button("設計書を保存").disabled).toBe(true); await click("設計書を保存"); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("disables save until confirmation completes and ignores old replies", async () => {
    let finish!: (value: AgentExportPreview) => void;
    api.preview = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    await render(); expect(button("設計書を保存").disabled).toBe(true);
    const first = finish;
    await check("public-rule.md");
    await act(async () => first(clean)); expect(button("設計書を保存").disabled).toBe(true);
    await act(async () => finish(clean)); expect(button("設計書を保存").disabled).toBe(false);
  });
  it("saves through a native chosen path and reports success", async () => {
    await render(); await click("設計書を保存");
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ filters: [{ name: "HTML", extensions: ["html"] }] }));
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ documents: [] }), clean.fingerprint, "/synthetic/evidence/book.html", catalog.cwd);
    expect(host.textContent).toContain("書き出しました");
  });
  it("reports a save failure while preserving the current selection", async () => {
    api.save = vi.fn(async () => { throw new Error("disk full"); });
    await render(); await check("public-rule.md"); await click("設計書を保存");
    expect(host.textContent).toContain("保存に失敗しました");
    expect(host.querySelector<HTMLInputElement>(".ad-export-documents input")?.checked).toBe(true);
  });
  it("treats dialog cancellation as no write", async () => {
    mocks.save.mockResolvedValue(null); await render(); await click("設計書を保存"); expect(api.save).not.toHaveBeenCalled();
  });
  it("shows a new final-gate hit returned by the backend", async () => {
    api.save = vi.fn(async () => ({ saved: false, path: null, preview: { ...clean, hits: [{ kind: "email", term: "user@example.test", line: 8 }] } }));
    await render(); await click("設計書を保存"); expect(host.textContent).toContain("名前の検査で保存を止めました"); expect(button("設計書を保存").disabled).toBe(true);
  });
  it("opens and edits the local list and reruns confirmation after saving", async () => {
    await render(); const before = vi.mocked(api.preview).mock.calls.length;
    await click("書き出しの検査用の名前リストを編集"); expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("fictional_person");
    expect(button("設計書を保存").disabled).toBe(true);
    await click("一覧を保存して検査");
    expect(api.saveNames).toHaveBeenCalledWith("fictional_person");
    expect(vi.mocked(api.preview).mock.calls.length).toBeGreaterThan(before);
  });
  it("keeps save disabled when the preview fails", async () => {
    api.preview = vi.fn(async () => { throw "exportNamesUnavailable"; });
    await render(); expect(button("設計書を保存").disabled).toBe(true); expect(host.textContent).toContain("名前の一覧を読めません");
  });
  it("wires all five export commands without refreshing source settings", async () => {
    mocks.invoke.mockResolvedValue(clean);
    await agentDesignExportApi.documents("folder"); await agentDesignExportApi.preview({ services: ["claude"], layers: [3], documents: [] }, "folder");
    await agentDesignExportApi.save({ services: ["claude"], layers: [3], documents: [] }, "hash", "book.html", "folder");
    await agentDesignExportApi.names(); await agentDesignExportApi.saveNames("fictional_person");
    expect(mocks.invoke.mock.calls.map(c => c[0])).toEqual(["agent_design_export_documents", "agent_design_export_preview", "agent_design_export_save", "agent_design_export_names", "agent_design_export_save_names"]);
  });
});
