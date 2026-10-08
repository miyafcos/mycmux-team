// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SkillsView } from "../../src/components/skills/SkillsView";
import { skillsApi, type SkillCatalog, type SkillRow } from "../../src/lib/skillsApi";
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
function row(id: string, claude: number, codex: number): SkillRow {
  return { id, label: id, description: "手順を確認する", line: "手順を確認する", kind: "own", plugin: null, category: "unsorted", symbol: null, glyph: "S", agents: ["claude", "codex"], aliases: [], curation: "manual", isNew: false, docPath: "/synthetic/" + id + "/SKILL.md", calls: { claude: "/" + id, codex: "$" + id }, usageCount: 999, usage: { claude, codex }, lastUsedAt: null, body: "", triggers: null, modifiedAt: 1, fileSize: 100, codexRecorded: true,
    usageRecords: { sampledAt: "2026-10-08T10:00:00Z", claude: { status: "available", count: claude, lastAt: null, source: "skillUsage" }, codex: { status: "available", count: codex, lastAt: 1, source: "usage_codex.json", days: 90 } } };
}
const catalog: SkillCatalog = { generatedAt: "2026-10-08T10:00:00Z", categories: [{ id: "unsorted", name: "未分類", color: "", symbol: null }], skills: [row("Alpha", 2, 8), row("Beta", 9, 1)], hiddenCount: 0, newCount: 0 };
const api = { ...skillsApi, peek: () => catalog, cached: async () => catalog, refresh: async () => catalog, document: async () => ({ frontmatter: {}, body: "# Synthetic", html: "<h1>Synthetic</h1>", toc: [], lines: 1, size: 20, modifiedAt: 1 }), locations: async () => ({ id: "Alpha", duplicateCodex: false, codexCount: 1, items: [] }) };
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
async function render(data = catalog) { await act(async () => root.render(<SkillsView readOnly api={{ ...api, peek: () => data, cached: async () => data, refresh: async () => data }} initialCatalog={data} onClose={vi.fn()} />)); }
async function change(selector: string, value: string) { const element = host.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!; await act(async () => { Object.getOwnPropertyDescriptor(element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); }); }
it("sorts by each service's own unit without the legacy aggregate", async () => {
  await render(); await change('[aria-label="スキルの並び順"]', "claude");
  expect(host.querySelector("tbody th")?.textContent).toContain("Beta");
  await change('[aria-label="スキルの並び順"]', "codex"); expect(host.querySelector("tbody th")?.textContent).toContain("Alpha");
  expect(host.textContent).toContain("8 会話"); expect(host.textContent).toContain("2 回の呼び出し"); expect(host.textContent).not.toContain("999");
});
it("opens a full skill page and restores the shelf's filter and scroll", async () => {
  await render(); await change('[aria-label="スキルを探す"]', "Alpha"); const list = host.querySelector<HTMLElement>(".skills-explorer-list")!; list.scrollTop = 90;
  await act(async () => host.querySelector<HTMLButtonElement>(".skills-row")!.click());
  expect(host.querySelector(".skills-full-page h1")?.textContent).toBe("Synthetic");
  expect(host.textContent).toContain("説明を先に読む"); expect(host.textContent).toContain("本文は必要なときに読む");
  expect(host.textContent).toContain("個別の最近の履歴は未収集");
  await act(async () => host.querySelector<HTMLButtonElement>(".skills-breadcrumb button")!.click());
  expect(host.querySelector<HTMLInputElement>('[aria-label="スキルを探す"]')?.value).toBe("Alpha"); expect(list.scrollTop).toBe(90); expect(host.querySelectorAll("tbody tr")).toHaveLength(1);
});
it("distinguishes zero records, collection failures and unavailable sources", async () => {
  const item = row("NoRecord", 0, 0); item.usageRecords!.codex = { status: "failed", count: null, lastAt: null, source: "usage_codex.json" };
  await render({ ...catalog, skills: [item, { ...row("Missing", 0, 0), usageRecords: undefined, codexRecorded: false }] });
  expect(host.textContent).toContain("記録なし（0）"); expect(host.textContent).toContain("集計に失敗"); expect(host.textContent).toContain("記録は未取得");
  expect(host.textContent).toContain("未取得の本文は検索していません");
});
it("keeps missing file metadata distinct from a measured empty file", async () => {
  const missing = { ...row("MissingFile", 0, 0), docPath: null, modifiedAt: 0, fileSize: 0, places: [] };
  const empty = { ...row("EmptyFile", 0, 0), modifiedAt: 0, fileSize: 0, places: [{ service: "claude", path: "/synthetic/EmptyFile/SKILL.md", bytes: 0, chars: 0, lines: 0, modifiedAt: null }] };
  await render({ ...catalog, skills: [missing, empty] });
  const rows = [...host.querySelectorAll("tbody tr")];
  const unknown = rows.find(value => value.textContent?.includes("MissingFile"))!.children[2];
  const known = rows.find(value => value.textContent?.includes("EmptyFile"))!.children[2];
  expect(unknown.textContent).toContain("大きさは未計測"); expect(unknown.textContent).toContain("日時は未取得");
  expect(unknown.textContent).not.toContain("1970"); expect(known.textContent).toContain("0 KB");
});
