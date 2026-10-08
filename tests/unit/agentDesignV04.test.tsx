// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDesignView } from "../../src/components/agentDesign/AgentDesignView";
import type { AgentDesignApi, AgentDesignCatalog } from "../../src/lib/agentDesignApi";
import { syntheticCatalog as fixture, syntheticItem } from "../fixtures/agent_home/catalog";
import { agentDesignStrings as s } from "../../src/components/agentDesign/agentDesignStrings";
import { ReadingView } from "../../src/components/agentDesign/ReadingView";
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement, api: AgentDesignApi;
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  api = { peek: () => fixture, cached: vi.fn(async () => fixture), refresh: vi.fn(async () => fixture),
    document: vi.fn(async id => ({ id, body: "# Example\n\nReadable content", html: "<h1>Example</h1><p>Readable content</p>", fields: [], size: fixture.items[0].size, status: "present" })),
    close: vi.fn(async () => fixture), scene: vi.fn(async () => ({ itemIds: [], chars: null, evidence: "declaration" })), setHermesHome: vi.fn(async () => {}) };
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });
async function render(element: ReactNode) { await act(async () => root.render(element)); }
async function click(label: string) { const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(el => el.textContent === label || el.firstChild?.textContent === label); expect(button).toBeTruthy(); await act(async () => button!.click()); }
function withCatalog(catalog: AgentDesignCatalog) { api.cached = async () => catalog; api.refresh = async () => catalog; return catalog; }
describe("agent design v04", () => {
  it("opens the mechanism map first and retains the four established views", async () => {
    await render(<AgentDesignView api={api} onClose={vi.fn()} initialCatalog={fixture} />);
    expect(host.querySelector('[data-ad-view="mechanism"]')).toBeTruthy();
    expect(host.querySelectorAll(".ad-map-card")).toHaveLength(6);
    expect(host.querySelector('[data-ad-layer="1"]')).toBeTruthy();
    for (const [label, surface] of [["概要", "overview"], ["読み方", "reading"], ["比べる", "compare"], ["点検", "inspection"], ["しくみ", "mechanism"]]) {
      await click(label); expect(host.querySelector('[data-ad-view="' + surface + '"]')).toBeTruthy();
    }
  });
  it("opens full content from the map and returns with search, layer and scroll retained", async () => {
    await render(<AgentDesignView api={api} onClose={vi.fn()} initialCatalog={fixture} />);
    const map = host.querySelector<HTMLElement>(".ad-mechanism .ad-main")!; map.scrollTop = 123;
    await act(async () => host.querySelector<HTMLButtonElement>(".ad-rich-items article > button")!.click());
    expect(api.document).toHaveBeenCalledWith("instructions", fixture.cwd);
    expect(host.querySelector(".ad-item-page .skills-markdown h1")?.textContent).toBe("Example");
    expect(host.querySelector(".ad-page")?.hasAttribute("hidden")).toBe(true);
    await click(s.back);
    expect(host.querySelector(".ad-page")?.hasAttribute("hidden")).toBe(false);
    expect(map.scrollTop).toBe(123);
    expect(document.activeElement?.getAttribute("data-ad-open")).toBe("instructions");
    expect(host.querySelector('[data-ad-layer="3"]')?.getAttribute("aria-pressed")).toBe("true");
  });
  it("keeps unmeasured file sizes separate from the recorded initial amount", async () => {
    const catalog = withCatalog({ ...fixture, items: [...fixture.items, { ...syntheticItem("unknown-size", 7, "reference"), size: { bytes: 1024, chars: null, lines: null } }], services: fixture.services.map(service => service.id === "claude" ? { ...service, context: { ...service.context, total: null, startup: null } } : service) });
    await render(<AgentDesignView api={api} onClose={vi.fn()} initialCatalog={catalog} />);
    expect(host.querySelector(".ad-map-conversation")?.textContent).toContain("確認できた分");
    expect(host.querySelector('[data-ad-layer="7"]')?.textContent).toContain("1 KB");
    expect(host.querySelector('[data-ad-layer="7"]')?.textContent).not.toContain("不明");
    expect(host.querySelector(".ad-map-conversation")?.textContent).toContain("必要時の本文や処理の登録を、初期量へ足しません");
  });
  it("keeps conditional instructions out of the initial step and opens their bodies from the conditional step", async () => {
    const catalog = withCatalog({ ...fixture, items: [...fixture.items, { ...syntheticItem("conditional", 3, "rule"), displayName: "conditional.md", readTiming: "conditional", conditions: ["src/**"] }] });
    await render(<AgentDesignView api={api} onClose={vi.fn()} initialCatalog={catalog} />);
    await click("読み方");
    expect(host.querySelectorAll(".ad-reading-table tbody tr")).toHaveLength(12);
    expect(host.querySelector(".ad-detail .ad-rich-items")?.textContent).not.toContain("conditional.md");
    await click(s.flowNames[7]);
    expect(host.querySelector(".ad-detail .ad-rich-items")?.textContent).toContain("conditional.md");
    await act(async () => host.querySelector<HTMLButtonElement>(".ad-detail .ad-rich-items article > button")!.click());
    expect(api.document).toHaveBeenCalledWith("conditional", fixture.cwd);
    await click(s.back);
    expect(host.querySelector('[data-ad-step="conditional"]')?.getAttribute("aria-selected")).toBe("true");
  });
  it("separates registered processing from uncollected execution and preserves the initial total", async () => {
    await render(<ReadingView catalog={fixture} service={fixture.services[0]} api={api} query="" notify={vi.fn()} />);
    expect(host.querySelectorAll(".ad-timeflow button")).toHaveLength(6);
    const end = host.querySelector('[data-ad-step="response"]')!;
    expect(end.textContent).toContain("1 処理の登録");
    expect(end.textContent).toContain("実行した回数は未収集");
    expect(host.querySelector(".ad-amount-heading")?.textContent).toContain("148 字");
    expect(host.textContent).toContain("記録なしを未使用と断定しません");
  });
  it("discards a late conditional trial after the service changes", async () => {
    let resolve!: (scene: { itemIds: string[]; chars: number; evidence: string }) => void;
    api.scene = vi.fn(() => new Promise(done => { resolve = done; }));
    const element = (service: typeof fixture.services[number]) => <ReadingView catalog={fixture} service={service} api={api} query="" notify={vi.fn()} />;
    await render(element(fixture.services[0])); await click("画面を変更する例"); await click(s.checkScenario);
    await render(element(fixture.services[1]));
    await act(async () => resolve({ itemIds: ["instructions"], chars: 42, evidence: "declaration" }));
    expect(host.querySelector('[aria-label="' + s.touchedPath + '"]')?.getAttribute("value")).toBe("");
    expect(host.querySelector('[role="status"]')).toBeNull();
  });
});

function change(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}
it("opens an inspection evidence line in the source and returns to the selected finding", async () => {
  const catalog = withCatalog({ ...fixture, findings: [{ ...fixture.findings[0], evidence: [{ ...fixture.findings[0].evidence[0], path: fixture.items[0].path, line: 3 }] }] });
  await render(<AgentDesignView api={api} onClose={vi.fn()} initialCatalog={catalog} />); await click("点検"); await click("根拠の本文 3 行目を開く");
  expect(host.querySelector('.ad-evidence-line[data-source-line="3"]')?.textContent).toContain("Readable content");
  expect(host.querySelector('.ad-document-tools button[aria-pressed="true"]')?.textContent).toBe(s.sourceDocument);
  await click(s.back); expect(host.querySelector('[data-ad-finding="claude:unusedListing"]')?.getAttribute("aria-selected")).toBe("true");
});
it("shows closed reasons and handles older catalogues without pretending the details were retrieved", async () => {
  const catalog = withCatalog({ ...fixture, closedCount: 1, closedEntries: [{ id: "closed-one", workFolder: fixture.cwd, reason: "Intentional for this workspace", closedAt: "2026-10-08T10:00:00+09:00", closedFrom: "pc" }] });
  await render(<AgentDesignView api={api} onClose={vi.fn()} initialCatalog={catalog} />); await click("点検");
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.startsWith("閉じた指摘"))!.click());
  expect(host.textContent).toContain("Intentional for this workspace"); expect(host.textContent).toContain("2026/10/8");
  await render(null); withCatalog({ ...fixture, closedCount: 1 }); await render(<AgentDesignView api={api} onClose={vi.fn()} />); await click("点検");
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.startsWith("閉じた指摘"))!.click());
  expect(host.textContent).toContain("この目録には理由と日時がありません");
});
it("lists all comparison documents instead of choosing only one file per service", async () => {
  const extra = { ...fixture.items[0], id: "instructions-two", displayName: "Additional instruction", path: "/synthetic/home/.claude/additional.md" };
  const catalog = withCatalog({ ...fixture, items: [...fixture.items, extra] });
  await render(<AgentDesignView api={api} onClose={vi.fn()} initialCatalog={catalog} />); await click("比べる");
  await act(async () => host.querySelector<HTMLButtonElement>('[data-ad-compare-row="0"] th button')!.click());
  expect(host.querySelectorAll(".ad-compare-documents .ad-rich-items article")).toHaveLength(2);
  await act(async () => host.querySelectorAll<HTMLButtonElement>(".ad-compare-documents .ad-rich-items article > button")[1].click());
  expect(api.document).toHaveBeenCalledWith(extra.id, fixture.cwd);
});
it("keeps missing history separate from the current catalogue and offers current document inspection", async () => {
  await render(<AgentDesignView api={api} onClose={vi.fn()} initialCatalog={fixture} />); await click("履歴");
  expect(host.textContent).toContain("過去と現在の差は、まだ比較できません");
  expect(host.textContent).toContain("「記録がない」を「変更がない」とは判定しません");
  await act(async () => host.querySelector<HTMLButtonElement>(".ad-history .ad-rich-items article > button")!.click());
  expect(api.document).toHaveBeenCalledWith("instructions", fixture.cwd);
  await click(s.back); expect(host.querySelector('[data-ad-view="history"]')).toBeTruthy();
});
it("uses the export API and keeps every appendix off until explicitly selected", async () => {
  const exportApi = { documents: vi.fn(async () => [{ id: "instructions", service: "claude", layer: 3, label: "CLAUDE.md", path: fixture.items[0].path!, available: true, sectioned: false, sections: [] }]), preview: vi.fn(async () => ({ fingerprint: "fixture", omissions: [], hits: [], documentCount: 0, bytes: 1024 })), save: vi.fn(), names: vi.fn(), saveNames: vi.fn() };
  await render(<AgentDesignView api={api} exportApi={exportApi} onClose={vi.fn()} initialCatalog={fixture} />); await click("書き出し");
  expect(host.querySelector<HTMLInputElement>('[aria-label="CLAUDE.mdの本文を添付"]')?.checked).toBe(false);
  await click("本文を開いて確認"); expect(host.querySelector(".ad-item-page")).toBeTruthy(); await click(s.back);
  expect(host.querySelector<HTMLInputElement>('[aria-label="CLAUDE.mdの本文を添付"]')?.checked).toBe(false);
  expect(exportApi.save).not.toHaveBeenCalled();
});

it("avoids invented flows and zero registrations when service records are unavailable", async () => {
  await render(<ReadingView catalog={fixture} service={{ ...fixture.services[2], state: "present" }} api={api} query="" notify={vi.fn()} />);
  expect(host.querySelector(".ad-timeflow")).toBeNull(); expect(host.textContent).toContain("このサービスの読む順序は未取得");
  const codex = { ...fixture.services[1], hooks: [], stats: { ...fixture.services[1].stats, hookHandlers: null }, context: { instructions: null, memory: null, listing: null, startup: null, product: null, total: null, knownTotal: 0 } };
  await render(<ReadingView catalog={fixture} service={codex} api={api} query="" notify={vi.fn()} />);
  expect(host.querySelector('[data-ad-step="startup"]')?.textContent).toContain("登録の内訳は未取得");
  expect(host.querySelector('[data-ad-step="startup"]')?.textContent).not.toContain("0 処理");
  expect(host.querySelector('[data-ad-step="settings"]')?.textContent).toContain("アプリが使う設定");
  expect(host.querySelector(".ad-amount-heading")?.textContent).toBe("初期の量は未取得");
});
