import { expect, it } from "vitest";
import type { PaneTab, Workspace } from "../../src/types";
import { deriveAutoName, UNKNOWN_AUTO_NAME, type AutoNameMeaning } from "../../src/lib/autoNamePolicy";
import { namingBinding, type AutoNameEvidence } from "../../src/lib/autoNameMaterial";
import { aggregateWorkspaceName, createAutoWorkspaceNamePolicy } from "../../src/lib/autoWorkspaceNaming";
import { beginNamingRecovery, applyNamingPatches, undoNamingRecovery } from "../../src/lib/autoNameRecovery";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { buildWorkspaceRecord, normalizeWorkspaceLayout } from "../../src/stores/workspaceFactory";
import { structuralUndoSignature } from "./helpers/groupingTestEntrypoint";
import { persistentLayoutSignature } from "../../src/lib/persistentLayoutProjection";
import { resolvePaneIdentities } from "../../src/lib/paneIdentity";
import { holdRestoredNames, isPaneNameHeld, isWorkspaceNameHeld, clearNamingHolds, useAutoNameRuntimeStore } from "../../src/stores/autoNameRuntimeStore";

function tab(id: string, extra: Partial<PaneTab> = {}): PaneTab {
  return { id, sessionId: "pty-" + id, agentId: "shell-starter", agentKind: "codex", agentSessionId: "agent-" + id,
    cwd: "C:/sample/src", label: "old-label-" + id, labelSource: "launch", initialPrompt: "original", launchEnv: { RESUME: "same" }, commandArgv: ["codex", "resume", id], ...extra };
}
function workspace(tabs: PaneTab[], extra: Partial<Workspace> = {}): Workspace {
  return { id: "w", name: "昔の名前", nameSource: "auto", createdAt: 0, status: "running", gridTemplateId: "1x1",
    panes: [{ id: "p", agentId: tabs[0]?.agentId ?? "", sessionId: tabs[0]?.sessionId ?? "", activeTabId: tabs[0]?.id ?? "", tabs }], splitColumns: [["p"]], ...extra };
}
function meaning(tab: PaneTab, text: string): AutoNameMeaning {
  const evidence: AutoNameEvidence = { id: tab.id, workspaceId: "w", binding: namingBinding(tab), contentKey: text, instructions: [text], files: [], activity: [], taskTitle: "", cwd: "", evidenceRefs: ["u-" + tab.id] };
  return deriveAutoName(evidence);
}
function meanings(tabs: PaneTab[], instructions: string[]) { return new Map(tabs.map((tab, i) => [tab.id, meaning(tab, instructions[i] ?? "")])); }

it("aggregates inactive and manually named tabs from their content, not their labels", () => {
  const tabs = [tab("slides"), tab("estimate", { label: "動画編集", labelSource: "user" })];
  const summary = aggregateWorkspaceName(workspace(tabs), meanings(tabs, ["解説スライドを作る", "機材費の見積を作る"]));
  expect(summary.name).toContain("解説スライド制作"); expect(summary.name).toContain("機材費見積"); expect(summary.name).not.toContain("動画");
  expect(summary.description).toContain("機材費見積");
});
it("collapses children only for the same target and action; independent work votes equally", () => {
  const parent = tab("parent");
  const children = Array.from({ length: 5 }, (_, i) => tab("child" + i, { origin: { kind: "agent", parentTabId: parent.id } }));
  const rest = [tab("quote"), tab("desk")]; const tabs = [parent, ...children, ...rest];
  const instructions = tabs.map(t => t.id === "quote" ? "機材費の見積を作る" : t.id === "desk" ? "窓口のアップロード処理を修正する" : "解説スライドを作る");
  const summary = aggregateWorkspaceName(workspace(tabs), meanings(tabs, instructions));
  expect(summary.jobs).toBe(3); expect(summary.name?.split("・")).toHaveLength(3); expect(summary.name).toContain("ほか1");
  instructions[1] = "スライドの図版を調整する";
  expect(aggregateWorkspaceName(workspace(tabs), meanings(tabs, instructions)).jobs).toBe(4);
});
it("leaves an all-unknown workspace unchanged and exposes unknown jobs in mixed names", () => {
  const tabs = [tab("known"), tab("unknown1"), tab("unknown2")]; const map = meanings(tabs, ["解説スライドを作る"]);
  expect(aggregateWorkspaceName(workspace(tabs), new Map()).name).toBe(UNKNOWN_AUTO_NAME);
  const summary = aggregateWorkspaceName(workspace(tabs), map);
  expect(summary.name).toBe("解説スライド制作・ほか2"); expect(summary.unknown).toBe(2); expect(summary.description).toContain("未取得 2件");
  tabs[0].sessionId = "new-pty"; expect(aggregateWorkspaceName(workspace(tabs), map).name).toBe(UNKNOWN_AUTO_NAME);
});
it("requires stable observations, uses the clock, and cools down workspace renames", () => {
  let now = 200_000; const policy = createAutoWorkspaceNamePolicy(() => now); const tabs = [tab("t")]; const ws = workspace(tabs);
  const summary = aggregateWorkspaceName(ws, meanings(tabs, ["解説スライドを作る"]));
  expect(policy.candidate(ws, summary)).toBeNull();
  for (let i = 0; i < 100; i++) expect(policy.candidate(ws, summary)).toBeNull();
  now += 120_000; expect(policy.candidate(ws, summary)).toBe("解説スライド制作"); policy.committed(ws.id, summary);
  const changed = aggregateWorkspaceName(ws, meanings(tabs, ["機材費の見積を作る"]));
  policy.candidate(ws, changed); now += 120_000; expect(policy.candidate(ws, changed)).toBeNull();
  now += 180_000; expect(policy.candidate(ws, changed)).toBe("機材費見積");
  expect(policy.candidate({ ...ws, nameSource: undefined }, changed)).toBeNull();
});
it("allows a new generated workspace to settle after thirty seconds", () => {
  let now = 1_000; const policy = createAutoWorkspaceNamePolicy(() => now); const tabs = [tab("t")]; const ws = workspace(tabs);
  const summary = aggregateWorkspaceName(ws, meanings(tabs, ["解説スライドを作る"]));
  expect(policy.candidate(ws, summary)).toBeNull(); now += 30_000; expect(policy.candidate(ws, summary)).toBe("解説スライド制作");
});
it("preserves optional workspace provenance and detects manual same-name rename", () => {
  const ws = workspace([tab("t")]); expect(normalizeWorkspaceLayout(ws).nameSource).toBe("auto");
  expect(buildWorkspaceRecord(ws).nameSource).toBe("auto");
  const old = { ...ws, nameSource: undefined }; expect(normalizeWorkspaceLayout(old).nameSource).toBeUndefined();
  expect(structuralUndoSignature([ws])).toBe(structuralUndoSignature([{ ...ws, name: "新しい自動名" }]));
  expect(structuralUndoSignature([old])).not.toBe(structuralUndoSignature([{ ...old, name: "手動変更" }]));
  expect(structuralUndoSignature([ws])).not.toBe(structuralUndoSignature([old]));
  expect(persistentLayoutSignature([ws])).not.toBe(persistentLayoutSignature([old]));
  useWorkspaceListStore.setState({ workspaces: [ws], layoutRevision: 0 });
  useWorkspaceListStore.getState().renameWorkspace(ws.id, ws.name);
  expect(useWorkspaceListStore.getState().getWorkspace(ws.id)?.nameSource).toBeUndefined();
  expect(useWorkspaceListStore.getState().layoutRevision).toBe(1);
});
it("does not infer project homes from generated workspace names", () => {
  const input = { registry: [{ section: "sample", label: "toolx", path: "C:/sample/toolx" }, ...Array.from({ length: 18 }, (_, i) => ({ section: "sample", label: "架空事業" + i, path: "C:/other/" + i }))], tabs: [], workspaces: [{ id: "w", name: "toolx" }] };
  expect(resolvePaneIdentities(input).homes.size).toBe(1);
  expect(resolvePaneIdentities({ ...input, workspaces: [{ ...input.workspaces[0], nameSource: "auto" }] }).homes.size).toBe(0);
});
it("recovers legacy names explicitly while preserving control labels, manual tabs, and identity fields", () => {
  const tabs = [tab("legacy", { labelSource: undefined, label: "readable legacy name", displayName: "崩れた表示名", displayNameSource: undefined }), tab("human", { labelSource: "user", label: "手動名" })];
  const original = [workspace(tabs, { nameSource: undefined })];
  const { record, patches } = beginNamingRecovery(original);
  expect(record.beforeTabs.map(t => t.id)).toEqual(["legacy"]);
  const recovered = applyNamingPatches(original, patches);
  expect(recovered[0].nameSource).toBe("auto"); expect(recovered[0].panes[0].tabs[0].labelSource).toBe("launch");
  const protectedFields = (values: Workspace[]) => values.flatMap(w => w.panes.flatMap(p => p.tabs.map(({ labelSource: _source, displayName: _display, displayNameSource: _displaySource, ...fields }) => fields)));
  expect(protectedFields(recovered)).toEqual(protectedFields(original));
  recovered[0].name = "教材制作"; recovered[0].panes[0].tabs[0].displayName = "解説スライド制作";
  const restored = applyNamingPatches(recovered, undoNamingRecovery(recovered, record));
  expect(restored[0].name).toBe(original[0].name); expect(restored[0].nameSource).toBeUndefined();
  expect(restored[0].panes[0].tabs).toEqual(original[0].panes[0].tabs);
});
it("scopes recovery and never undoes later user renames or replaced owners", () => {
  const one = workspace([tab("one")]); const two = workspace([tab("two")], { id: "w2" });
  const { record, patches } = beginNamingRecovery([one, two], "w");
  expect(patches.workspaces.map(w => w.id)).toEqual(["w"]); expect(patches.tabs.map(t => t.id)).toEqual(["one"]);
  const recovered = applyNamingPatches([one, two], patches);
  recovered[0].nameSource = undefined; recovered[0].name = "手動ワークスペース";
  recovered[0].panes[0].tabs[0].labelSource = "user"; recovered[0].panes[0].tabs[0].label = "手動ペイン";
  expect(undoNamingRecovery(recovered, record)).toEqual({ tabs: [], workspaces: [] });
  const reused = applyNamingPatches([one], patches); reused[0].panes[0].tabs[0].sessionId = "replacement";
  expect(undoNamingRecovery(reused, record).tabs).toHaveLength(0);
  expect(applyNamingPatches(reused, patches)[0].panes[0].tabs[0].sessionId).toBe("replacement");
});
it("holds restored automatic names until their actual content changes", () => {
  const t = tab("hold"); const ws = workspace([t]); const { record } = beginNamingRecovery([ws]);
  const m = meaning(t, "解説スライドを作る"); useAutoNameRuntimeStore.setState({ meanings: new Map([[t.id, m]]) });
  holdRestoredNames(record);
  expect(isPaneNameHeld(t.id, namingBinding(t), m.contentKey)).toBe(true);
  expect(isWorkspaceNameHeld(ws.id, "composition")).toBe(true);
  expect(isPaneNameHeld(t.id, namingBinding(t), "changed")).toBe(false);
  expect(isWorkspaceNameHeld(ws.id, "changed")).toBe(false);
  clearNamingHolds([ws.id], [t.id]);
});

it("does not count unused launchers; held topics remain candidates while stopped writes stay forbidden", () => {
  const tabs = [tab("live"), tab("launcher", { type: "launcher" }), tab("declared", { lifecycle: "declared" }), tab("login", { ephemeral: true })];
  const map = meanings(tabs, ["解説スライドを作る"]);
  expect(aggregateWorkspaceName(workspace(tabs), map).jobs).toBe(1);
  expect(aggregateWorkspaceName(workspace(tabs), map).name).toBe("解説スライド制作");
  const stopped = aggregateWorkspaceName(workspace(tabs, { status: "stopped" }), map);
  expect(stopped.name).toBeNull(); expect(stopped.description).toContain("前回の材料");
  map.get("live")!.fresh = false;
  expect(aggregateWorkspaceName(workspace(tabs), map).name).toBe("解説スライド制作");
});
it("keeps topic order independent of focus, iteration order, and same-job children", () => {
  const tabs = [tab("desk"), tab("slide"), tab("quote")];
  const map = meanings(tabs, ["アップロード処理を修正する", "解説スライドを作る", "機材費の見積を作る"]);
  const before = aggregateWorkspaceName(workspace(tabs), map);
  const after = aggregateWorkspaceName(workspace([...tabs].reverse()), map);
  expect(after.name).toBe(before.name); expect(after.key).toBe(before.key);
  const child = tab("delegated", { origin: { kind: "agent", parentTabId: "slide" } }); map.set(child.id, meaning(child, "解説スライドを作る"));
  expect(aggregateWorkspaceName(workspace([...tabs, child]), map).name).toBe(before.name);
});
it("round-trips auto and legacy workspace names and launch provenance twice", async () => {
  const { toConfig } = await import("../../src/components/layout/SocketListener");
  const { restoreWorkspaceConfigs } = await import("../../src/lib/workspaceRestore");
  for (const source of ["auto", undefined] as const) {
    let values = [workspace([tab("roundtrip")], { nameSource: source })];
    for (let boot = 0; boot < 2; boot++) {
      const saved = JSON.parse(JSON.stringify(toConfig(values[0])));
      expect(saved.name_source).toBe(source);
      useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null, lastActivePaneByWorkspace: {} });
      restoreWorkspaceConfigs([saved]); values = useWorkspaceListStore.getState().workspaces;
      expect(values[0].nameSource).toBe(source); expect(values[0].name).toBe("昔の名前");
      const restored = values[0].panes[0].tabs[0];
      expect(restored.labelSource).toBe("launch"); expect(restored.id).toBe("roundtrip");
      expect(restored.agentSessionId).toBe("agent-roundtrip"); expect(restored.launchEnv).toEqual({ RESUME: "same" });
    }
  }
});

it("includes the remaining-job count inside the twenty-grapheme workspace cap", () => {
  const tabs = [tab("known"), ...Array.from({ length: 100 }, (_, index) => tab("unknown" + index))];
  const map = meanings([tabs[0]], ["授業画面の日付表示とメニュー項目と印刷設定の表示位置を調整する"]);
  const summary = aggregateWorkspaceName(workspace(tabs), map);
  expect(summary.name).toContain("ほか100");
  expect([...new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(summary.name!)].length).toBeLessThanOrEqual(20);
  expect(summary.name).toContain("調整");
  expect(summary.description).toContain("未取得 100件");
});


it("K4 workspace support: held replacements retire committed jobs while weight-only changes stay held", () => {
  for (const change of ["same", "positive", "unknown", "removed", "owner"] as const) {
    let now = 0; const a = tab("a"), b = tab("b"), ws = workspace([a, b]);
    const map = meanings([a, b], ["動画を編集する", "日付表示を修正する"]);
    const policy = createAutoWorkspaceNamePolicy(() => now), first = aggregateWorkspaceName(ws, map);
    const commit: (id: string, summary: typeof first) => void = policy.committed;
    policy.candidate(ws, first); now = 30_000; ws.name = policy.candidate(ws, first)!; commit(ws.id, first);
    for (const m of map.values()) m.fresh = false;
    if (change === "positive") { const m = meaning(a, "解説スライドを作る"); m.fresh = false; map.set(a.id, m); }
    if (change === "unknown") map.delete(a.id);
    if (change === "removed") ws.panes[0].tabs = [b];
    if (change === "owner") a.sessionId = "replaced-owner";
    now = 60_000; const next = aggregateWorkspaceName(ws, map); expect(policy.candidate(ws, next)).toBeNull();
    now = 329_999; expect(policy.candidate(ws, next)).toBeNull();
    now = 330_000;
    const expected = change === "same" ? null : change === "positive" ? "日付表示修正・解説スライド制作" : change === "removed" ? "日付表示修正" : "日付表示修正・ほか1";
    console.log("K4 support case", change, JSON.stringify({ next, expected }));
    expect.soft(policy.candidate(ws, next), change).toBe(expected);
    expect([...map.values()].every(m => !m.fresh)).toBe(true);
  }
});

it("K4 workspace support: unproven saved automatic names settle to unknown without touching protected owners", () => {
  for (const source of ["auto", undefined] as const) for (const status of ["running", "stopped"] as const) {
    let now = 200_000; const policy = createAutoWorkspaceNamePolicy(() => now), ws = workspace([tab("empty")], { name: "動画編集", nameSource: source, status });
    const summary = aggregateWorkspaceName(ws, new Map());
    expect(policy.candidate(ws, summary)).toBeNull(); now += 120_000;
    expect.soft(policy.candidate(ws, summary)).toBe(source === "auto" && status === "running" ? UNKNOWN_AUTO_NAME : null);
  }
});

it("K4 workspace support: weight-only coverage loss preserves the last successful support", () => {
  let now = 0; const tabs = Array.from({ length: 5 }, (_, i) => tab("weight-" + i)), ws = workspace(tabs);
  const map = meanings(tabs, tabs.map((_, i) => i < 4 ? "動画を編集する" : "日付表示を修正する"));
  const policy = createAutoWorkspaceNamePolicy(() => now), first = aggregateWorkspaceName(ws, map);
  const commit: (id: string, summary: typeof first) => void = policy.committed;
  expect(first.name).toBe("動画編集・ほか1"); policy.candidate(ws, first);
  now = 30_000; ws.name = policy.candidate(ws, first)!; commit(ws.id, first);
  for (const m of map.values()) m.fresh = false;
  now = 60_000; const held = aggregateWorkspaceName(ws, map);
  expect.soft(held.name).toBe("動画編集・日付表示修正"); expect(held.jobs).toBe(5);
  expect(policy.candidate(ws, held)).toBeNull(); now = 330_000;
  expect(policy.candidate(ws, held)).toBeNull(); expect(ws.name).toBe("動画編集・ほか1");
  console.log("K4 weight-only support", JSON.stringify({ first, held, retained: ws.name }));
});

it.each(["add", "remove"] as const)("K4-FIX-1 policy: held known jobs recompose when an unknown member is %s", change => {
  let now = 0;
  const a = tab("known"), u = tab("unknown");
  const ws = workspace(change === "add" ? [a] : [a, u], { name: UNKNOWN_AUTO_NAME, createdAt: -200_000 });
  const map = meanings([a], ["動画を編集する"]), policy = createAutoWorkspaceNamePolicy(() => now);
  const first = aggregateWorkspaceName(ws, map);
  expect(first.name).toBe(change === "add" ? "動画編集" : "動画編集・ほか1");
  expect(policy.candidate(ws, first)).toBeNull();
  now = 120_000; ws.name = policy.candidate(ws, first)!; expect(ws.name).toBe(first.name); policy.committed(ws.id, first);

  map.get(a.id)!.fresh = false;
  ws.panes[0].tabs = change === "add" ? [a, u] : [a];
  const next = aggregateWorkspaceName(ws, map), expected = change === "add" ? "動画編集・ほか1" : "動画編集";
  expect(next).toMatchObject({ name: expected, onlyHeld: true, jobs: change === "add" ? 2 : 1, unknown: change === "add" ? 1 : 0 });
  expect(next.support.find(([id]) => id === a.id)).toEqual(first.support.find(([id]) => id === a.id));
  for (now of [150_000, 179_999, 180_000, 269_999, 270_000, 419_999]) expect(policy.candidate(ws, next)).toBeNull();
  now = 420_000; expect(policy.candidate(ws, next)).toBe(expected);
  ws.name = expected; policy.committed(ws.id, next);
  now = 900_000; expect(policy.candidate(ws, aggregateWorkspaceName(ws, map))).toBeNull();
});

it.each(["member", "owner"] as const)("K4-FIX-1 policy: an unknown %s replacement is semantic even when its count stays equal", change => {
  let now = 0;
  const known = Array.from({ length: 5 }, (_, i) => tab("known-" + i)), u = tab("unknown");
  const ws = workspace([...known, u], { createdAt: -200_000 });
  const map = meanings(known, known.map((_, i) => i < 4 ? "動画を編集する" : "日付表示を修正する"));
  const policy = createAutoWorkspaceNamePolicy(() => now), first = aggregateWorkspaceName(ws, map);
  expect(first.name).toBe("動画編集・ほか2"); policy.candidate(ws, first);
  now = 120_000; ws.name = policy.candidate(ws, first)!; policy.committed(ws.id, first);
  for (const m of map.values()) m.fresh = false;
  const held = aggregateWorkspaceName(ws, map);
  expect(held.name).toBe("動画編集・日付表示修正・ほか1");
  now = 150_000; expect(policy.candidate(ws, held)).toBeNull();
  now = 450_000; expect(policy.candidate(ws, held)).toBeNull();

  ws.panes[0].tabs = [...known, { ...u, ...(change === "member" ? { id: "replacement" } : { agentSessionId: "replacement-owner" }) }];
  const next = aggregateWorkspaceName(ws, map);
  expect(next).toMatchObject({ name: held.name, onlyHeld: true, jobs: 6, unknown: 1 });
  now = 480_000; expect(policy.candidate(ws, next)).toBeNull();
  now = 599_999; expect(policy.candidate(ws, next)).toBeNull();
  now = 600_000; expect(policy.candidate(ws, next)).toBe("動画編集・日付表示修正・ほか1");
});

it("K4 workspace support: reset and prune remove only the selected workspace support and cooldown", () => {
  for (const reset of ["reset", "prune"] as const) {
    let now = 0; const policy = createAutoWorkspaceNamePolicy(() => now), a = tab("a"), b = tab("b");
    const ws = workspace([a]), other = workspace([b], { id: "other" }), first = aggregateWorkspaceName(ws, meanings([a], ["動画を編集する"]));
    const second = aggregateWorkspaceName(other, meanings([b], ["動画を編集する"]));
    const commit: (id: string, summary: typeof first) => void = policy.committed;
    policy.candidate(ws, first); policy.candidate(other, second); now = 30_000;
    ws.name = policy.candidate(ws, first)!; other.name = policy.candidate(other, second)!; commit(ws.id, first); commit(other.id, second);
    if (reset === "reset") policy.reset([ws.id]); else policy.prune(new Set([other.id]));
    const ma = meaning(a, "解説スライドを作る"), mb = meaning(b, "解説スライドを作る"); ma.fresh = mb.fresh = false;
    const next = aggregateWorkspaceName(ws, new Map([[a.id, ma]])), retained = aggregateWorkspaceName(other, new Map([[b.id, mb]]));
    now = 60_000; policy.candidate(ws, next); policy.candidate(other, retained); now = 90_000;
    expect.soft(policy.candidate(ws, next), reset).toBe("解説スライド制作");
    expect(policy.candidate(other, retained)).toBeNull(); now = 330_000;
    expect.soft(policy.candidate(other, retained), reset + " other").toBe("解説スライド制作");
  }
});
