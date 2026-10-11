// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAutoPaneNamingScheduler } from "../../src/lib/autoPaneNaming";
import { recoverNamesFromContent, undoRecoveredNames } from "../../src/lib/nameRecoveryAction";
import { readAutoNameScan, liveNamingBinding } from "../../src/lib/autoNameEvidence";
import { createAutoNamePolicy, deriveAutoName } from "../../src/lib/autoNamePolicy";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useAutoNameRuntimeStore, clearNamingHolds, resetNamingPolicies } from "../../src/stores/autoNameRuntimeStore";
import { useLiveBriefStore } from "../../src/stores/liveBriefStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useAiSettingsStore } from "../../src/stores/aiSettingsStore";
import type { LiveSessionBrief } from "../../src/lib/livebrief";
import type { Workspace } from "../../src/types";
import { materialFor, fixtureEvents } from "./helpers/autoNamingInvariants";
const fake = vi.hoisted(() => ({ invoke: vi.fn(), confirm: vi.fn() }));
vi.mock("@tauri-apps/api/core", async importOriginal => ({ ...await importOriginal<typeof import("@tauri-apps/api/core")>(), invoke: fake.invoke }));
vi.mock("../../src/lib/appConfirmation", () => ({ confirm: fake.confirm }));
const schedulers: ReturnType<typeof createAutoPaneNamingScheduler>[] = [];
function workspace(id: string): Workspace {
  return { id, name: "以前の名前", nameSource: "auto", createdAt: 0, gridTemplateId: "1x1", status: "running", splitColumns: [["p-" + id]],
    panes: [{ id: "p-" + id, sessionId: "s-" + id, activeTabId: id, agentId: "shell-starter",
      tabs: [{ id, sessionId: "s-" + id, agentId: "shell-starter", label: "runner-" + id, labelSource: "launch",
        cwd: "/project", agentKind: "codex", agentSessionId: "agent-" + id,
        initialPrompt: "original", commandArgv: ["codex", "resume", id], launchEnv: { ORIGINAL: id } }] }] };
}
function currentInstruction(id: string, text: string, occurrence = 0) {
  const tab = useWorkspaceListStore.getState().workspaces.flatMap(w => w.panes.flatMap(p => p.tabs)).find(t => t.id === id)!;
  const meta = usePaneMetadataStore.getState().metadata[tab.sessionId];
  const material = materialFor(tab, text, occurrence);
  useLiveBriefStore.setState(state => ({ eventsBySession: {...state.eventsBySession, [tab.sessionId]: fixtureEvents(material)}, briefsBySession: { ...state.briefsBySession, [tab.sessionId]: {
    ptySessionId: tab.sessionId, agentSessionId: meta?.agentSessionId ?? tab.agentSessionId,
    agentKind: meta?.agentKind ?? tab.agentKind, telemetryHealth: "live", updatedAt: Date.now(),
    latestInstruction: text, taskSourceEventIds: [], checkpointEvidenceEventIds: [], activitySourceEventId: null,
    namingPlan: material.naming_plan,
  } as LiveSessionBrief } }));
}
function visible(id: string) { return useWorkspaceListStore.getState().workspaces.flatMap(w => w.panes.flatMap(p => p.tabs)).find(t => t.id === id)!.displayName; }
function scheduler() { const value = createAutoPaneNamingScheduler(); schedulers.push(value); return value; }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} });
  useLiveBriefStore.getState().reset();
  useAutoNameRuntimeStore.setState({ recovery: null, revision: 0, meanings: new Map(), descriptions: new Map(), invalidatedTabs: new Map(), invalidatedWorkspaces: new Map() });
  useSettingsStore.setState({ autoPaneNamingEnabled: true, autoWorkspaceNamingEnabled: false });
  useAiSettingsStore.setState({ aiEnabled: false });
  fake.confirm.mockReset().mockResolvedValue(true);
  fake.invoke.mockReset().mockImplementation(async command => {
    if (command === "get_pty_metadata_snapshot") return Object.fromEntries(useWorkspaceListStore.getState().workspaces.flatMap(w => w.panes.flatMap(p => p.tabs.map(t => [t.sessionId, { process_status: "working" }]))));
    if (command === "get_session_output_snapshot") return {};
    if (command === "auto_name_materials") return [];
    throw new Error("Unexpected IPC: " + command);
  });
});
afterEach(() => {
  schedulers.splice(0).forEach(value => value.stop());
  const ws = useWorkspaceListStore.getState().workspaces;
  clearNamingHolds(ws.map(w => w.id), ws.flatMap(w => w.panes.flatMap(p => p.tabs.map(t => t.id))));
  vi.clearAllTimers(); vi.useRealTimers();
});
it.each(["cwd", "identity", "pane"] as const)("R1: recovery → undo → production scan keeps the hold with %s overlay", async kind => {
  const ws = workspace("r1-" + kind);
  const tab = ws.panes[0].tabs[0];
  tab.displayName = "日付表示修正"; tab.displayNameSource = "auto";
  if (kind === "cwd") usePaneMetadataStore.setState({ metadata: { [tab.sessionId]: { cwd: "/project/subdir" } } });
  if (kind === "identity") usePaneMetadataStore.setState({ metadata: { [tab.sessionId]: { agentKind: "claude", agentSessionId: "live-agent" } } });
  if (kind === "pane") { ws.panes[0].cwd = "/project/subdir"; tab.cwd = undefined; }
  useWorkspaceListStore.setState({ workspaces: [ws], activeWorkspaceId: ws.id });
  const before = structuredClone(tab);
  currentInstruction(tab.id, "字幕位置を直してください");
  await recoverNamesFromContent(ws.id);
  expect(visible(tab.id)).toBe("字幕位置修正");
  undoRecoveredNames(); expect(visible(tab.id)).toBe("日付表示修正");
  await scheduler().runNow();
  expect(visible(tab.id)).toBe("日付表示修正");
  expect(useWorkspaceListStore.getState().workspaces[0].panes[0].tabs[0]).toEqual(before);
});
it.each(["stopped", "read-loss"] as const)("R2: abandons pending deadlines after %s", async kind => {
  const ws = workspace("r2-" + kind);
  useWorkspaceListStore.setState({ workspaces: [ws] });
  const policy = createAutoNamePolicy(Date.now);
  currentInstruction(ws.id, "解説スライドを作ってください");
  policy.identify(await readAutoNameScan());
  vi.setSystemTime(1_001_000); currentInstruction(ws.id, "字幕位置を直してください", 1);
  const nextScan = await readAutoNameScan(), next = deriveAutoName(nextScan.naming.get(ws.id)!);
  expect(next.fullName).toBe("字幕位置修正"); expect(nextScan.naming.get(ws.id)?.latestInput?.sourceByteStart).toBe(100);
  console.log("K3 R2 positive precondition", kind, JSON.stringify({ fullName: next.fullName, mark: nextScan.naming.get(ws.id)?.latestInput }));
  policy.identify(nextScan); expect(policy.nextCheckMs()).toBeDefined();
  if (kind === "stopped") useWorkspaceListStore.setState({ workspaces: [{ ...ws, status: "stopped" }] });
  else useLiveBriefStore.getState().reset();
  policy.identify(await readAutoNameScan());
  vi.setSystemTime(1_030_000);
  policy.identify(await readAutoNameScan());
  console.log("K4 R2 real scan", kind, JSON.stringify({ strength: policy.meanings().get(ws.id)?.strength, nextCheck: policy.nextCheckMs() }));
  if (kind === "read-loss") expect(policy.meanings().get(ws.id)?.strength).toBe("unknown");
  expect(policy.nextCheckMs()).toBeUndefined();
});
it.each(["recover", "undo"] as const)("R13: %s in A preserves B's accepted meaning and pending deadline", async action => {
  const a = workspace("r13-a-" + action), b = workspace("r13-b-" + action);
  useWorkspaceListStore.setState({ workspaces: [a, b], activeWorkspaceId: a.id });
  currentInstruction(a.id, "日付表示を修正する"); currentInstruction(b.id, "解説スライドを作る");
  const s = scheduler(); await s.runNow();
  if (action === "undo") { await recoverNamesFromContent(a.id); await s.runNow(); }
  vi.setSystemTime(1_001_000); currentInstruction(b.id, "字幕位置を直す", 1);
  await s.runNow(); expect(visible(b.id)).toBe("解説スライド制作");
  if (action === "recover") await recoverNamesFromContent(a.id); else undoRecoveredNames();
  await s.runNow(); expect(visible(b.id)).toBe("解説スライド制作");
  vi.setSystemTime(1_010_999); await s.runNow(); expect(visible(b.id)).toBe("解説スライド制作");
  vi.setSystemTime(1_011_000); currentInstruction(b.id, "字幕位置を直す", 1); await s.runNow();
  expect(visible(b.id)).toBe("字幕位置修正");
});

it("R2: stopped pending work does not spin production metadata IPC every 350 ms", async () => {
  const ws = workspace("r2-timer");
  useWorkspaceListStore.setState({ workspaces: [ws] });
  currentInstruction(ws.id, "解説スライドを作る"); const s = scheduler(); await s.runNow();
  vi.setSystemTime(1_001_000); currentInstruction(ws.id, "字幕位置を直す", 1); await s.runNow();
  fake.invoke.mockClear();
  useWorkspaceListStore.setState({ workspaces: [{ ...useWorkspaceListStore.getState().workspaces[0], status: "stopped" }] });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(fake.invoke.mock.calls.filter(([command]) => command === "get_pty_metadata_snapshot").length).toBeLessThanOrEqual(2);
});


it.each(["member", "owner", "metadata", "stopped", "off", "reset", "manual", "unchanged"] as const)("K4 composition CAS: %s is checked inside the atomic workspace write", async kind => {
  const ws = workspace("k4-cas-" + kind);
  useWorkspaceListStore.setState({ workspaces: [ws] }); useSettingsStore.setState({ autoWorkspaceNamingEnabled: true });
  currentInstruction(ws.id, "解説スライドを作る"); const s = scheduler(); await s.runNow();
  const originalApply = useWorkspaceListStore.getState().applyNamePatches;
  type GuardedApply = (patches: Parameters<typeof originalApply>[0], guard?: (workspace: Workspace) => boolean) => ReadonlySet<string>;
  let receipt: unknown, attempted = 0;
  useWorkspaceListStore.setState({ applyNamePatches: ((patches, guard) => {
    if (patches.workspaces.length) {
      attempted++;
      if (kind === "metadata") usePaneMetadataStore.setState({ metadata: { [ws.panes[0].tabs[0].sessionId]: { cwd: "/different-live-owner" } } });
      else if (kind === "off") useSettingsStore.setState({ autoWorkspaceNamingEnabled: false });
      else if (kind === "reset") resetNamingPolicies([ws.id], [ws.id]);
      else if (kind !== "unchanged") {
        const changed = structuredClone(useWorkspaceListStore.getState().workspaces);
        if (kind === "member") changed[0].panes[0].tabs.push({ ...changed[0].panes[0].tabs[0], id: "new-member", sessionId: "new-pty" });
        if (kind === "owner") changed[0].panes[0].tabs[0].sessionId = "new-owner";
        if (kind === "stopped") changed[0].status = "stopped";
        if (kind === "manual") changed[0].nameSource = undefined;
        useWorkspaceListStore.setState({ workspaces: changed });
      }
    }
    const applied = (originalApply as unknown as GuardedApply)(patches, guard);
    if (patches.workspaces.length) receipt = applied;
    return applied;
  }) as typeof originalApply });
  try {
    vi.setSystemTime(1_120_000); currentInstruction(ws.id, "解説スライドを作る"); await s.runNow();
    console.log("K4 CAS case", kind, JSON.stringify({ attempted, receipt: receipt instanceof Set ? [...receipt] : receipt, workspace: useWorkspaceListStore.getState().workspaces[0].name }));
    expect(attempted).toBe(1);
    expect.soft(useWorkspaceListStore.getState().workspaces[0].name).toBe(kind === "unchanged" ? "解説スライド制作" : "以前の名前");
    expect.soft(receipt).toEqual(new Set(kind === "unchanged" ? [ws.id] : []));
  } finally { useWorkspaceListStore.setState({ applyNamePatches: originalApply }); }
});

it("K4 composition CAS: a coincident automatic name cannot forge a commit cooldown", async () => {
  const ws = workspace("k4-coincident"); useWorkspaceListStore.setState({ workspaces: [ws] });
  useSettingsStore.setState({ autoWorkspaceNamingEnabled: true });
  currentInstruction(ws.id, "解説スライドを作る"); const s = scheduler(); await s.runNow();
  const originalApply = useWorkspaceListStore.getState().applyNamePatches; let receipt: unknown;
  useWorkspaceListStore.setState({ applyNamePatches: ((patches, guard) => {
    if (patches.workspaces.length) useWorkspaceListStore.setState(state => ({ workspaces: state.workspaces.map(w => w.id === ws.id ? { ...w, name: patches.workspaces[0].name, nameSource: "auto" } : w) }));
    receipt = (originalApply as unknown as (p: typeof patches, g?: typeof guard) => ReadonlySet<string>)(patches, guard);
    return receipt;
  }) as typeof originalApply });
  try {
    vi.setSystemTime(1_120_000); await s.runNow();
    expect.soft(receipt).toEqual(new Set()); expect(useWorkspaceListStore.getState().workspaces[0].name).toBe("解説スライド制作");
  } finally { useWorkspaceListStore.setState({ applyNamePatches: originalApply }); }
  vi.setSystemTime(1_130_000); currentInstruction(ws.id, "字幕位置を直してください", 1); await s.runNow();
  vi.setSystemTime(1_140_000); await s.runNow(); expect(visible(ws.id)).toBe("字幕位置修正");
  expect(useLiveBriefStore.getState().briefsBySession[ws.panes[0].tabs[0].sessionId]?.namingPlan?.latestInput?.sourceByteStart).toBe(100);
  vi.setSystemTime(1_260_000); await s.runNow();
  console.log("K4 coincident-name recovery", JSON.stringify({ receipt: receipt instanceof Set ? [...receipt] : receipt, workspace: useWorkspaceListStore.getState().workspaces[0].name }));
  expect(useWorkspaceListStore.getState().workspaces[0].name).toBe("字幕位置修正");
});

it.each(["add", "remove"] as const)("K4-FIX-1 scheduler: held known jobs recompose when an unknown member is %s", async change => {
  const ws = workspace("k4-fix-known-" + change), a = ws.panes[0].tabs[0];
  const u = workspace("k4-fix-unknown-" + change).panes[0].tabs[0];
  ws.name = "作業内容未取得";
  if (change === "remove") ws.panes[0].tabs.push(u);
  useWorkspaceListStore.setState({ workspaces: [ws] });
  currentInstruction(a.id, "動画を編集する");
  const s = scheduler(); await s.runNow();
  expect(visible(a.id)).toBe("動画編集");
  const accepted = useAutoNameRuntimeStore.getState().meanings.get(a.id)!;
  expect(accepted).toMatchObject({ fullName: "動画編集", strength: "strong", fresh: true });

  const originalApply = useWorkspaceListStore.getState().applyNamePatches;
  const writes: Array<{ at: number; ids: string[]; name: string }> = [];
  useWorkspaceListStore.setState({ applyNamePatches: (...args: Parameters<typeof originalApply>) => {
    const receipt = originalApply(...args);
    if (receipt.size) writes.push({ at: Date.now() - 1_000_000, ids: [...receipt], name: useWorkspaceListStore.getState().workspaces[0].name });
    return receipt;
  } });
  try {
    useSettingsStore.setState({ autoWorkspaceNamingEnabled: true }); await s.runNow();
    const firstName = change === "add" ? "動画編集" : "動画編集・ほか1";
    expect(useWorkspaceListStore.getState().workspaces[0].name).toBe("作業内容未取得");
    vi.setSystemTime(1_120_000); await s.runNow();
    expect(writes).toEqual([{ at: 120_000, ids: [ws.id], name: firstName }]);

    vi.setSystemTime(1_150_000);
    useWorkspaceListStore.setState(state => ({ workspaces: state.workspaces.map(w => ({ ...w,
      panes: w.panes.map(p => ({ ...p, tabs: change === "add" ? [...p.tabs, u] : p.tabs.filter(t => t.id !== u.id) })) })) }));
    const originalInvoke = fake.invoke.getMockImplementation()!;
    fake.invoke.mockImplementation(async command => command === "get_pty_metadata_snapshot"
      ? Object.fromEntries(useWorkspaceListStore.getState().workspaces.flatMap(w => w.panes.flatMap(p => p.tabs
        .filter(t => t.id !== a.id).map(t => [t.sessionId, { process_status: "working" }]))))
      : originalInvoke(command));
    // The real scan excludes a's missing PTY; the pane policy retains its accepted meaning as held.
    expect((await readAutoNameScan()).tabs.map(t => t.id)).toEqual(change === "add" ? [u.id] : []);
    await s.runNow();
    expect(useAutoNameRuntimeStore.getState().meanings.get(a.id)).toMatchObject({
      binding: accepted.binding, meaningKey: accepted.meaningKey, fullName: "動画編集", strength: "strong", fresh: false,
    });
    expect(useAutoNameRuntimeStore.getState().invalidatedWorkspaces.size).toBe(0);
    expect(useAutoNameRuntimeStore.getState().descriptions.get(ws.id)).toContain("前回の材料");
    if (change === "add") expect(useAutoNameRuntimeStore.getState().descriptions.get(ws.id)).toContain("未取得 1件");
    for (const at of [1_270_000, 1_419_999]) {
      vi.setSystemTime(at); await s.runNow();
      expect(useWorkspaceListStore.getState().workspaces[0].name).toBe(firstName); expect(writes).toHaveLength(1);
    }
    const expected = change === "add" ? "動画編集・ほか1" : "動画編集";
    vi.setSystemTime(1_420_000); await s.runNow();
    expect.soft(useWorkspaceListStore.getState().workspaces[0].name).toBe(expected);
    expect.soft(writes).toEqual([{ at: 120_000, ids: [ws.id], name: firstName }, { at: 420_000, ids: [ws.id], name: expected }]);
    vi.setSystemTime(1_900_000); await s.runNow();
    expect(useWorkspaceListStore.getState().workspaces[0].name).toBe(expected); expect(writes).toHaveLength(2);
    expect(useWorkspaceListStore.getState().workspaces[0].nameSource).toBe("auto");
    expect(visible(a.id)).toBe("動画編集");
  } finally { useWorkspaceListStore.setState({ applyNamePatches: originalApply }); }
});

it("K4-FIX-2 scheduler: an unknown live binding change retires held support after the normal wait", async () => {
  const ws = workspace("k4-fix2-live-binding");
  const known = Array.from({ length: 5 }, (_, i) => workspace("k4-fix2-known-" + i).panes[0].tabs[0]);
  const u = workspace("k4-fix2-unknown").panes[0].tabs[0];
  ws.panes[0].tabs = [...known, u]; ws.panes[0].activeTabId = known[0].id; ws.name = "作業内容未取得";
  useWorkspaceListStore.setState({ workspaces: [ws] });
  useSettingsStore.setState({ autoWorkspaceNamingEnabled: true });
  usePaneMetadataStore.getState().setMetadata(u.sessionId, { cwd: "/project" });
  const refresh = () => known.forEach((t, i) => currentInstruction(t.id, i < 4 ? "動画を編集する" : "日付表示を修正する"));
  const originalApply = useWorkspaceListStore.getState().applyNamePatches;
  const writes: Array<{ at: number; ids: string[]; name: string }> = [];
  useWorkspaceListStore.setState({ applyNamePatches: (...args: Parameters<typeof originalApply>) => {
    const receipt = originalApply(...args);
    if (receipt.size) writes.push({ at: Date.now() - 1_000_000, ids: [...receipt], name: useWorkspaceListStore.getState().workspaces[0].name });
    return receipt;
  } });
  try {
    const s = scheduler(); refresh(); await s.runNow();
    const accepted = known.map(t => useAutoNameRuntimeStore.getState().meanings.get(t.id)!);
    expect(accepted.every(m => m.strength === "strong" && m.fresh)).toBe(true);
    expect(writes).toEqual([]);
    vi.setSystemTime(1_120_000); refresh(); await s.runNow();
    const first = { at: 120_000, ids: [ws.id], name: "動画編集・ほか2" };
    expect(writes).toEqual([first]);
    const rawTabs = structuredClone(useWorkspaceListStore.getState().workspaces[0].panes[0].tabs);
    const oldBinding = liveNamingBinding(u, ws.panes[0]);

    vi.setSystemTime(1_150_000);
    const originalInvoke = fake.invoke.getMockImplementation()!;
    fake.invoke.mockImplementation(async command => command === "get_pty_metadata_snapshot"
      ? { [u.sessionId]: { process_status: "working" } } : originalInvoke(command));
    expect((await readAutoNameScan()).tabs.map(t => t.id)).toEqual([u.id]);
    await s.runNow();
    for (const [i, t] of known.entries()) expect(useAutoNameRuntimeStore.getState().meanings.get(t.id)).toMatchObject({
      binding: accepted[i].binding, meaningKey: accepted[i].meaningKey, strength: "strong", fresh: false,
    });
    expect(useAutoNameRuntimeStore.getState().descriptions.get(ws.id)).toContain("前回の材料");
    vi.setSystemTime(1_450_000); await s.runNow();
    expect(useWorkspaceListStore.getState().workspaces[0].name).toBe(first.name); expect(writes).toEqual([first]);

    vi.setSystemTime(1_480_000);
    usePaneMetadataStore.getState().setMetadata(u.sessionId, { cwd: "/different-live-owner" });
    const scan = await readAutoNameScan(), binding = liveNamingBinding(u, ws.panes[0]);
    expect(binding).not.toBe(oldBinding);
    expect(scan.tabs).toHaveLength(1); expect(scan.tabs[0].cwd).toBe("/different-live-owner");
    expect(scan.naming.get(u.id)).toMatchObject({ binding });
    expect(deriveAutoName(scan.naming.get(u.id)!).strength).toBe("unknown");
    for (const at of [1_480_000, 1_509_999, 1_510_000, 1_599_999]) {
      vi.setSystemTime(at); await s.runNow();
      expect(useWorkspaceListStore.getState().workspaces[0].name).toBe(first.name); expect(writes).toEqual([first]);
    }
    for (const at of [1_600_000, 1_900_000]) {
      vi.setSystemTime(at); await s.runNow();
      console.log("K4-FIX-2 live binding", JSON.stringify({ at: at - 1_000_000, writes, binding, name: useWorkspaceListStore.getState().workspaces[0].name }));
      expect.soft(useWorkspaceListStore.getState().workspaces[0].name).toBe("動画編集・日付表示修正・ほか1");
    }
    expect.soft(writes).toEqual([first, { at: 600_000, ids: [ws.id], name: "動画編集・日付表示修正・ほか1" }]);
    expect(useWorkspaceListStore.getState().workspaces[0].panes[0].tabs).toEqual(rawTabs);
    expect(useWorkspaceListStore.getState().workspaces[0].nameSource).toBe("auto");
    expect(useAutoNameRuntimeStore.getState()).toMatchObject({ revision: 0, invalidatedTabs: new Map(), invalidatedWorkspaces: new Map() });
  } finally { useWorkspaceListStore.setState({ applyNamePatches: originalApply }); }
});

it("K4-FIX-2 composition CAS: an unknown live binding without accepted evidence is rechecked inside the write", async () => {
  const ws = workspace("k4-fix2-unknown-cas"), a = ws.panes[0].tabs[0];
  const u = workspace("k4-fix2-unscanned").panes[0].tabs[0]; ws.panes[0].tabs.push(u);
  useWorkspaceListStore.setState({ workspaces: [ws] }); useSettingsStore.setState({ autoWorkspaceNamingEnabled: true });
  usePaneMetadataStore.getState().setMetadata(u.sessionId, { cwd: "/project" });
  const originalInvoke = fake.invoke.getMockImplementation()!;
  fake.invoke.mockImplementation(async command => command === "get_pty_metadata_snapshot"
    ? { [a.sessionId]: { process_status: "working" } } : originalInvoke(command));
  currentInstruction(a.id, "解説スライドを作る"); const s = scheduler(); await s.runNow();
  expect(useAutoNameRuntimeStore.getState().meanings.has(u.id)).toBe(false);
  const raw = structuredClone(useWorkspaceListStore.getState().workspaces[0].panes[0].tabs[1]);
  const oldBinding = liveNamingBinding(u, ws.panes[0]);
  const originalApply = useWorkspaceListStore.getState().applyNamePatches;
  let attempted = 0; const receipts: string[][] = [];
  useWorkspaceListStore.setState({ applyNamePatches: (...args: Parameters<typeof originalApply>) => {
    if (args[0].workspaces.length && attempted++ === 0)
      usePaneMetadataStore.getState().setMetadata(u.sessionId, { cwd: "/different-live-owner" });
    const receipt = originalApply(...args);
    if (args[0].workspaces.length) receipts.push([...receipt]);
    return receipt;
  } });
  try {
    vi.setSystemTime(1_120_000); currentInstruction(a.id, "解説スライドを作る"); await s.runNow();
    expect(attempted).toBe(1); expect(liveNamingBinding(u, ws.panes[0])).not.toBe(oldBinding);
    expect.soft(useWorkspaceListStore.getState().workspaces[0].name).toBe("以前の名前");
    expect.soft(receipts).toEqual([[]]);
    for (const at of [1_150_000, 1_269_999]) {
      vi.setSystemTime(at); currentInstruction(a.id, "解説スライドを作る"); await s.runNow();
      expect.soft(useWorkspaceListStore.getState().workspaces[0].name).toBe("以前の名前");
    }
    vi.setSystemTime(1_270_000); currentInstruction(a.id, "解説スライドを作る"); await s.runNow();
    expect(useWorkspaceListStore.getState().workspaces[0].name).toBe("解説スライド制作・ほか1");
    expect.soft(receipts).toEqual([[], [ws.id]]);
    expect(useAutoNameRuntimeStore.getState().meanings.has(u.id)).toBe(false);
    expect(useWorkspaceListStore.getState().workspaces[0].panes[0].tabs[1]).toEqual(raw);
    expect(useAutoNameRuntimeStore.getState().revision).toBe(0);
    console.log("K4-FIX-2 unknown CAS", JSON.stringify({ attempted, receipts, name: useWorkspaceListStore.getState().workspaces[0].name }));
  } finally { useWorkspaceListStore.setState({ applyNamePatches: originalApply }); }
});
