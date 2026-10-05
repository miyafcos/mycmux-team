// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { clipIdentityName, displayNameForWorkspace, identityRomaji, isToolIdentifier, normalizeIdentityText, resolvePaneIdentities, type PaneEvidence, type ProjectRegistration } from "../../src/lib/paneIdentity";

const registry: ProjectRegistration[] = [
  ["教材", "北斗学院/ひかりスタ/数学", "C:/projects/math"],
  ["教材", "北斗学院/ひかりスタ/理科", "C:/projects/science"],
  ["教材", "北斗学院/ひかりスタ/00_資料", "C:/projects/docs"],
  ["教材", "みなとゼミ/数学", "C:/projects/minato"],
  ["書籍", "青葉出版/AIパスポート", "C:/projects/passport"],
  ["開発", "toolx (master)", "C:/dev/tool"],
  ["別環境", "toolx (branch)", "D:/dev/tool"],
  ...Array.from({ length: 18 }, (_, i) => ["別枠", "架空事業" + i, "D:/other/" + i]),
].map(([section, label, path]) => ({ section, label, path }));
const workspaces = [{ id: "today", name: "今日" }, { id: "math", name: "数学ひか" }, { id: "tool", name: "toolx" }, { id: "minato", name: "数学みなと" }];
const tab = (id: string, extra: Partial<PaneEvidence> = {}): PaneEvidence => ({ id, workspaceId: "today", cwd: "", labelSource: "ai", ...extra });
const resolve = (tabs: PaneEvidence[], ws = workspaces) => resolvePaneIdentities({ registry, tabs, workspaces: ws });
const get = (tabs: PaneEvidence[]) => resolve(tabs).tabs.get(tabs[0].id)!;

describe("pure pane identities", () => {
  it("normalizes labels across sections, merges paths and drops storage-only display segments", () => {
    expect(normalizeIdentityText("ひかり ＡＩ")).toBe("ヒカリ ai");
    const a = get([tab("a", { cwd: "D:\\DEV\\TOOL\\src" })]);
    expect(a.project).toMatchObject({ display: "toolx", short: "toolx" });
    expect(a.subject).toBe("src");
    expect(get([tab("b", { cwd: "C:/projects/docs" })]).project?.display).toBe("北斗学院 ひかりスタ");
  });
  it("keeps a dropped edition segment out of the prefix as well as the display name", () => {
    const withEdition = [...registry, { section: "教材", label: "つばさ模試/標準版", path: "C:/projects/tsubasa" }];
    const result = resolvePaneIdentities({ registry: withEdition, workspaces, tabs: [
      tab("a", { cwd: "C:/projects/tsubasa/第1回", taskTitle: "つばさ模試 第1回 校正" }),
    ] });
    const identity = result.tabs.get("a")!;
    expect(identity.project).toMatchObject({ display: "つばさ模試", short: "つばさ模試" });
    expect(identity.displayName).toBe("つばさ模試 第1回");
  });
  it("uses the longest registered folder on path boundaries", () => {
    const input = { registry: [...registry, { section: "子", label: "subtool", path: "C:/dev/tool/child" }], workspaces, tabs: [tab("a", { cwd: "c:/DEV/tool/child/src" }), tab("b", { cwd: "c:/dev/toolbox" })] };
    const result = resolvePaneIdentities(input);
    expect(result.tabs.get("a")?.project?.display).toBe("subtool");
    expect(result.tabs.get("b")?.projectReason).not.toBe("folder_registry");
  });
  it("requires identity evidence, adds facets and refuses tied scores", () => {
    expect(get([tab("a", { sessionTitle: "数学 校正" })]).project).toBeNull();
    expect(get([tab("a", { taskTitle: "ひかりスタ 数学 校正" })]).project?.display).toBe("ひかりスタ 数学");
    expect(get([tab("a", { taskTitle: "ひかりスタ" })]).project).toBeNull();
  });
  it("matches romaji and ignores drives, Users and user names", () => {
    expect(identityRomaji("みなとゼミ")).toBe("minatozemi");
    expect(identityRomaji("シャトウ")).toBe("shato");
    expect(identityRomaji("あお")).toBeNull();
    expect(get([tab("a", { cwd: "C:/Users/minatozemi/_work/minatozemi_rev/findings/sol" })]).projectReason).toBe("folder_words");
    expect(get([tab("a", { cwd: "C:/Users/minatozemi" })]).project).toBeNull();
  });
  it("checks folder, task and session evidence in that order without using readable labels as projects", () => {
    expect(get([tab("a", { cwd: "C:/work/toolx", taskTitle: "みなとゼミ", sessionTitle: "ひかりスタ 数学" })]).projectReason).toBe("folder_words");
    expect(get([tab("a", { taskTitle: "toolx", sessionTitle: "みなとゼミ" })]).projectReason).toBe("task_title");
    expect(get([tab("a", { labelSource: "user", label: "toolx" })]).project).toBeNull();
  });
  it("propagates parents and unanimous children but not conflicting families or cycles", () => {
    const r = resolve([tab("parent"), tab("child", { parentTabId: "parent", cwd: "C:/dev/tool" }), tab("grandchild", { parentTabId: "child" }),
      tab("mixed"), tab("one", { parentTabId: "mixed", cwd: "C:/dev/tool" }), tab("two", { parentTabId: "mixed", cwd: "C:/projects/math" }),
      tab("cycle-a", { parentTabId: "cycle-b" }), tab("cycle-b", { parentTabId: "cycle-a", cwd: "C:/dev/tool" })]);
    expect(r.tabs.get("parent")?.projectReason).toBe("lineage");
    expect(r.tabs.get("grandchild")?.projectReason).toBe("lineage");
    expect(r.tabs.get("mixed")?.project).toBeNull();
    expect(r.tabs.get("cycle-a")?.project).toBeNull();
  });
  it("learns aliases only from three distinct panes of one project", () => {
    const known = [0, 1, 2].map(i => tab("known" + i, { cwd: "C:/dev/tool", label: "alpha-alpha-sol-" + i }));
    expect(resolve([...known, tab("unknown", { label: "alpha-fix-9" })]).tabs.get("unknown")?.projectReason).toBe("alias");
    expect(resolve([known[0], tab("unknown", { label: "alpha-fix-9" })]).tabs.get("unknown")?.project).toBeNull();
    expect(resolve([...known, tab("other", { cwd: "C:/projects/math", label: "alpha-sol-9" }), tab("unknown", { label: "alpha-fix-9" })]).tabs.get("unknown")?.project).toBeNull();
    expect(isToolIdentifier({ label: "alpha-test-1", labelSource: "user" })).toBe(false);
  });
  it("uses unique prefix homes, excludes equal home scores and controls contextual prefixes", () => {
    const r = resolve([tab("a", { cwd: "C:/projects/math/chapter" })]);
    const value = r.tabs.get("a")!;
    expect(r.homes.get(value.project!.key)).toBe("math");
    expect(value.displayName).toBe("ひかりスタ chapter");
    expect(displayNameForWorkspace(value, "math", r.homes)).toBe("chapter");
    expect(resolve([tab("a", { cwd: "C:/dev/tool" })], [{ id: "x", name: "toolx" }, { id: "y", name: "toolx" }]).homes.size).toBe(0);
  });
  it("uses a unique home only with title evidence and keeps the weak session subject intact", () => {
    const r = resolve([tab("a", { workspaceId: "math", sessionTitle: "数学 検査" }), tab("b", { workspaceId: "math" })]);
    expect(r.tabs.get("a")?.projectReason).toBe("workspace_name");
    expect(r.tabs.get("a")?.subject).toBe("数学 検査");
    expect(r.tabs.get("b")?.project).toBeNull();
  });
  it("avoids other first candidates but always preserves manual and readable labels", () => {
    const r = resolve([tab("a", { cwd: "C:/dev/tool/shared", taskTitle: "toolx 実装" }), tab("b", { cwd: "C:/dev/tool/shared", taskTitle: "toolx 検査" }),
      tab("c", { cwd: "C:/dev/tool", label: "shared", labelSource: "user" }), tab("d", { cwd: "C:/dev/tool", label: "shared", labelSource: undefined })]);
    expect(r.tabs.get("a")?.subject).toBe("実装");
    expect(r.tabs.get("b")?.subject).toBe("検査");
    expect(r.tabs.get("c")?.displayName).toBe("shared");
    expect(r.tabs.get("d")?.displayName).toBe("shared");
  });
  it("strips folder dates, hidden descendants, title particles and only spaced hyphens", () => {
    expect(get([tab("a", { cwd: "C:/dev/tool/01_260927_job/_private/hidden" })]).subject).toBe("job");
    expect(get([tab("a", { cwd: "C:/dev/tool", taskTitle: "TOOLX の — G6-PA (draft)" })]).subject).toBe("G6-PA");
    expect(get([tab("a")])).toMatchObject({ subject: null, displayName: null });
    expect([...clipIdentityName("あ".repeat(21))]).toHaveLength(20);
    expect(clipIdentityName("名前 (master)")).toBe("名前");
    expect([...clipIdentityName("😀".repeat(21))]).toHaveLength(20);
  });
  it("is deterministic and resolves 100 panes within ten milliseconds", () => {
    const tabs = Array.from({ length: 100 }, (_, i) => tab("p" + i, { cwd: "C:/dev/tool/task_" + i, taskTitle: "toolx 検査 " + i }));
    const a = resolve(tabs); const start = performance.now(); const b = resolve(tabs); const elapsed = performance.now() - start;
    expect(b).toEqual(a);
    expect(elapsed).toBeLessThan(10);
  });
});

describe("numeric registry evidence", () => {
  it("does not resolve a project or its home from years embedded in dates", () => {
    const registry = Array.from({ length: 12 }, (_, index) => ({
      section: "案件", label: index === 0 ? "北斗大学/2026" : "サンプル" + index,
      path: "C:/registry/" + index,
    }));
    const result = resolvePaneIdentities({ registry, workspaces: [{ id: "w", name: "20261001" }],
      tabs: [{ id: "t", workspaceId: "w", cwd: "C:/reports/instructor_sourcing_20261001", label: "調達" }] });
    expect(result.tabs.get("t")?.project).toBeNull();
    expect(result.homes.size).toBe(0);
  });
});
