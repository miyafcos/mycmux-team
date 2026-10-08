// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { save as chooseFile } from "@tauri-apps/plugin-dialog";
import { AgentDesignView } from "../../src/components/agentDesign/AgentDesignView";
import { HistoryView } from "../../src/components/agentDesign/HistoryView";
import { ExportView } from "../../src/components/agentDesign/ExportView";
import type { AgentDesignApi, AgentDesignExportApi, AgentExportPreview, DesignHistoryChange } from "../../src/lib/agentDesignApi";
import { syntheticCatalog as catalog } from "../fixtures/agent_home/catalog";
import { agentDesignStrings as s } from "../../src/components/agentDesign/agentDesignStrings";
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root, api: AgentDesignApi, exportApi: AgentDesignExportApi;
const change: DesignHistoryChange = { id: "git-one", itemId: "instructions", service: "claude", layer: 3, displayName: "CLAUDE.md", path: catalog.items[0].path, kind: "changed", badge: "fileChanged", source: "git", at: "2026-10-08T01:00:00Z", beforeBytes: null, afterBytes: null, amountChanges: [], hash: "a".repeat(40), subject: "Update public rule", author: "Fixture Writer", linesAdded: 1, linesDeleted: 2 };
const preview: AgentExportPreview = { fingerprint: "fixture", omissions: [{ kind: "memory", label: "記憶と記録", reason: "いつも外す", count: 1 }], hits: [], documentCount: 0, bytes: 2048 };
beforeEach(() => {
  vi.useFakeTimers(); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  api = { peek: () => catalog, cached: vi.fn(async () => catalog), refresh: vi.fn(async () => catalog),
    document: vi.fn(async id => ({ id, body: "# Public document", html: "<h1>Public document</h1>", fields: [], size: catalog.items[0].size, status: "present" })),
    close: vi.fn(async () => catalog), scene: vi.fn(async () => ({ itemIds: [], chars: null, evidence: "declaration" })), setHermesHome: vi.fn(async () => {}),
    history: vi.fn(async () => ({ schemaVersion: 1, snapshotCount: 2, capturedAt: "2026-10-08T00:00:00Z", writing: false, warnings: [], changes: [], snapshots: [
      { id: "a", capturedAt: "2026-10-07T00:00:00Z", catalogGeneratedAt: "2026-10-07T00:00:00Z", itemCount: 12 },
      { id: "b", capturedAt: "2026-10-08T00:00:00Z", catalogGeneratedAt: "2026-10-08T00:00:00Z", itemCount: 14 } ] })),
    historyPair: vi.fn(async () => []), historyGit: vi.fn(async () => ({ status: "ready", changes: [change] })),
    historyDiff: vi.fn(async () => ({ mode: "text", status: "ready", beforeBytes: 100, afterBytes: 120, truncated: false, lines: [{ kind: "added", oldLine: null, newLine: 2, text: "Public added line" }] })),
  };
  exportApi = { documents: vi.fn(async () => [{ id: "instructions", service: "claude", layer: 3, label: "CLAUDE.md", path: "~/.claude/CLAUDE.md", sectioned: true, available: true, sections: [{ id: "section-1", label: "Public heading", chars: 12 }] }]),
    preview: vi.fn(async () => preview), save: vi.fn(async () => ({ saved: true, path: "/tmp/fixture.html", preview })), names: vi.fn(async () => ({ path: "/synthetic/export-names.txt", content: "fictional_person" })), saveNames: vi.fn(async () => {}) };
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });
async function render(element: ReactNode) { await act(async () => root.render(element)); }
async function click(label: string) { const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(el => el.textContent === label || el.firstChild?.textContent === label); expect(button).toBeTruthy(); await act(async () => button!.click()); }
async function settlePreview() { await act(async () => vi.advanceTimersByTimeAsync(220)); }
async function select(label: string, value: string) { await act(async () => { const field = host.querySelector<HTMLSelectElement>('[aria-label="' + label + '"]')!; field.value = value; field.dispatchEvent(new Event("change", { bubbles: true })); }); }
describe("v04 history", () => {
  it("compares exactly two snapshots with their times, counts and interval", async () => {
    await render(<HistoryView catalog={catalog} api={api} query="" onOpen={vi.fn()} />);
    expect(api.historyPair).toHaveBeenCalledWith("a", "b", catalog.cwd);
    expect(host.textContent).toContain("12 項目 → 比較先"); expect(host.textContent).toContain("14 項目");
    expect(host.textContent).toContain("86,400 秒"); expect(host.textContent).toContain("この二時点の間は変更 0 件");
    expect(host.textContent).toContain("現在まで変更がないという意味ではありません");
    await select("比較元", "b"); expect(api.historyPair).toHaveBeenLastCalledWith("b", "b", catalog.cwd);
  });
  it("explains ignored files without claiming unchanged and still opens current content", async () => {
    api.historyGit = vi.fn(async () => ({ status: "ignored", changes: [] }));
    await render(<AgentDesignView api={api} onClose={vi.fn()} initialCatalog={catalog} />); await click("履歴"); await click("ファイルの変更履歴"); await click("CLAUDE.md");
    expect(host.textContent).toContain("編集履歴の対象外"); expect(host.textContent).toContain("変更していないという意味ではありません");
    await click("現在の本文を開く"); expect(api.document).toHaveBeenCalledWith("instructions", catalog.cwd);
    await click(s.back); expect(host.querySelector('[data-ad-view="history"]')).toBeTruthy(); expect(host.textContent).toContain("編集履歴の対象外");
  });
  it("retains the original subject and adds Japanese line changes with a readable diff", async () => {
    await render(<HistoryView catalog={catalog} api={api} query="" onOpen={vi.fn()} />); await click("ファイルの変更履歴"); await click("CLAUDE.md");
    expect(host.textContent).toContain("原件名: Update public rule"); expect(host.textContent).toContain("1 行追加 · 2 行削除");
    await act(async () => host.querySelector<HTMLButtonElement>('[data-ad-change="git-one"]')!.click());
    expect(api.historyDiff).toHaveBeenCalledWith("instructions", change.hash, catalog.cwd);
    expect(host.querySelector(".ad-history-line.added span:nth-child(2)")?.textContent).toBe("2");
    expect(host.querySelector(".ad-history-line.added code")?.textContent).toBe("Public added line");
  });
  it("filters file choices by name and discards a late response from the old folder", async () => {
    let resolve!: (value: Awaited<ReturnType<NonNullable<AgentDesignApi["history"]>>>) => void;
    api.history = vi.fn(() => new Promise(done => { resolve = done; }));
    const filteredCatalog = { ...catalog, items: catalog.items.map(item => item.id === "instructions" ? item : { ...item, displayName: item.id, path: "/synthetic/" + item.id }) };
    await render(<HistoryView catalog={filteredCatalog} api={api} query="CLAUDE.md" onOpen={vi.fn()} />); const old = resolve;
    await click("ファイルの変更履歴"); expect(host.querySelectorAll(".ad-main .ad-dense-table:first-of-type tbody tr")).toHaveLength(1);
    await render(<HistoryView catalog={{ ...filteredCatalog, cwd: "/synthetic/other" }} api={api} query="CLAUDE.md" onOpen={vi.fn()} />);
    await act(async () => old({ schemaVersion: 1, snapshotCount: 99, capturedAt: "2026-10-08T00:00:00Z", writing: false, warnings: [], changes: [] }));
    expect(host.textContent).not.toContain("99 時点");
  });
});
describe("v04 export", () => {
  it("shows metadata and counts, keeps appendices off initially, and returns from body inspection", async () => {
    await render(<AgentDesignView api={api} exportApi={exportApi} onClose={vi.fn()} initialCatalog={catalog} />); await click("書き出し"); await settlePreview();
    expect(host.querySelector(".ad-export-documents")?.textContent).toContain("共通の作業方針");
    expect(host.textContent).toContain("本文を選べる対象1 本 / 候補 1 本");
    expect(exportApi.preview).toHaveBeenCalledWith(expect.objectContaining({ documents: [] }), catalog.cwd);
    await click("本文を開いて確認"); expect(api.document).toHaveBeenCalledWith("instructions", catalog.cwd); await click(s.back);
    expect(host.querySelector<HTMLInputElement>(".ad-export-documents input")?.checked).toBe(false);
    await act(async () => host.querySelector<HTMLInputElement>(".ad-export-documents input")!.click()); await settlePreview();
    expect(exportApi.preview).toHaveBeenLastCalledWith(expect.objectContaining({ documents: [{ id: "instructions", sections: ["section-1"] }] }), catalog.cwd);
  });
  it("disables save for a name hit and explains the inspection scope", async () => {
    exportApi.preview = vi.fn(async () => ({ ...preview, hits: [{ term: "fictional_person", kind: "list", line: 8 }] }));
    await render(<ExportView catalog={catalog} api={exportApi} />); await settlePreview();
    expect(host.textContent).toContain("保存を止める名前 1 件"); expect(host.textContent).toContain("検査の対象は生成した HTML");
    expect([...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "設計書を保存")?.disabled).toBe(true);
    expect(exportApi.save).not.toHaveBeenCalled();
  });
  it("saves only the latest inspected options and fingerprint after a native path is chosen", async () => {
    vi.mocked(chooseFile).mockResolvedValue("/tmp/fixture.html");
    await render(<ExportView catalog={catalog} api={exportApi} />); await settlePreview();
    expect(host.textContent).toContain("この検査条件では該当 0 件"); await click("設計書を保存");
    expect(exportApi.save).toHaveBeenCalledWith(expect.objectContaining({ documents: [] }), "fixture", "/tmp/fixture.html", catalog.cwd);
    expect(host.textContent).toContain("書き出しました");
  });
  it("keeps a failed inspection distinct from zero hits and offers availability retry", async () => {
    exportApi.preview = vi.fn(async () => { throw "unavailable"; }); exportApi.documents = vi.fn(async () => { throw "unavailable"; });
    await render(<ExportView catalog={catalog} api={exportApi} />); await settlePreview();
    expect(host.textContent).toContain("検査できません"); expect(host.textContent).not.toContain("該当 0 件");
    await click("本文の可否を再確認"); expect(exportApi.documents).toHaveBeenCalledTimes(2);
    expect(exportApi.save).not.toHaveBeenCalled();
  });
  it("discards a late preview after selection changes", async () => {
    let resolve!: (value: AgentExportPreview) => void;
    exportApi.preview = vi.fn(() => new Promise(done => { resolve = done; }));
    await render(<ExportView catalog={catalog} api={exportApi} />); await settlePreview(); const old = resolve;
    await act(async () => host.querySelector<HTMLInputElement>(".ad-export-checks input")!.click());
    await act(async () => old({ ...preview, bytes: 777777 }));
    expect(host.textContent).not.toContain("759.55 KB"); expect(host.querySelector(".ad-export-hits")?.textContent).toBe("検査中");
  });
  it("labels the names list as export inspection only and invalidates preview after an edit", async () => {
    await render(<ExportView catalog={catalog} api={exportApi} />); await settlePreview(); await click("書き出しの検査用の名前リストを編集");
    expect(host.textContent).toContain("このリストは書き出しの検査だけに使います");
    expect([...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "設計書を保存")?.disabled).toBe(true);
    await click("一覧を保存して検査"); expect(exportApi.saveNames).toHaveBeenCalledWith("fictional_person");
    expect(host.querySelector(".ad-export-hits")?.textContent).toBe("検査中"); await settlePreview(); expect(exportApi.preview).toHaveBeenCalledTimes(2);
  });
  it("rechecks one missing body without enabling an unreadable attachment", async () => {
    exportApi.documents = vi.fn(async () => [{ id: "instructions", service: "claude", layer: 3, label: "CLAUDE.md", path: "~/.claude/CLAUDE.md", sectioned: false, available: false, sections: [] }]);
    exportApi.recheck = vi.fn(async () => ({ id: "instructions", service: "claude", layer: 3, label: "CLAUDE.md", path: "~/.claude/CLAUDE.md", sectioned: false, available: false, reason: "fileUnreadable", sections: [] }));
    await render(<ExportView catalog={catalog} api={exportApi} />); await settlePreview();
    expect(host.querySelector<HTMLInputElement>(".ad-export-documents input")?.disabled).toBe(true);
    await click("この本文の可否を再確認"); expect(exportApi.recheck).toHaveBeenCalledWith("instructions", catalog.cwd);
    expect(host.textContent).toContain("ファイルを読む権限がないか");
    expect(host.querySelector<HTMLInputElement>(".ad-export-documents input")?.disabled).toBe(true);
  });
  it("abandons the save request when the folder changes while choosing a path", async () => {
    let resolve!: (path: string) => void;
    vi.mocked(chooseFile).mockImplementation(() => new Promise(done => { resolve = done; }));
    await render(<ExportView catalog={catalog} api={exportApi} />); await settlePreview(); await click("設計書を保存");
    await render(<ExportView catalog={{ ...catalog, cwd: "/synthetic/new-folder" }} api={exportApi} />);
    await act(async () => resolve("/tmp/fixture.html")); expect(exportApi.save).not.toHaveBeenCalled();
  });

});
