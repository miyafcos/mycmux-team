// @vitest-environment jsdom
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { isDeepStrictEqual } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { createAutoPaneNamingScheduler } from "../../src/lib/autoPaneNaming";
import { readAutoNameScan } from "../../src/lib/autoNameEvidence";
import { getTabDisplayFullLabel, getTabDisplayLabel } from "../../src/lib/tabDisplayLabel";
import { namePrefix, UNKNOWN_AUTO_NAME } from "../../src/lib/autoNamePolicy";
import { aggregateWorkspaceName } from "../../src/lib/autoWorkspaceNaming";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useAiSettingsStore } from "../../src/stores/aiSettingsStore";
import { useLauncherDirsStore } from "../../src/stores/launcherDirsStore";
import { useLiveBriefStore } from "../../src/stores/liveBriefStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { clearNamingHolds, useAutoNameRuntimeStore } from "../../src/stores/autoNameRuntimeStore";
import { recoverNamesFromContent, undoRecoveredNames } from "../../src/lib/nameRecoveryAction";
import type { LiveSessionBrief, UserMessageKind } from "../../src/lib/livebrief";
import type { NamingMaterial } from "../../src/lib/autoNameMaterial";
import type { PaneTab } from "../../src/types";
import { actions, endings, envelope, fixtureEvents, fixtureMaterial, makeTab, makeWorkspace, materialFor, matrix, nextFamilies, punctuation, targets, tasks, user, write, writeMatrixReport } from "./helpers/autoNamingInvariants";

const fake = vi.hoisted(() => ({ invoke: vi.fn(), confirm: vi.fn() }));
vi.mock("@tauri-apps/api/core", async importOriginal => ({ ...await importOriginal<typeof import("@tauri-apps/api/core")>(), invoke: fake.invoke }));
vi.mock("../../src/lib/appConfirmation", () => ({ confirm: fake.confirm }));
const nativeResults: unknown[] = [];
afterAll(() => {
  writeMatrixReport(".dispatch/b9-generated-native-after.json", nativeResults);
  if (process.env.K4_WORKSPACE_TRACE_FILE) writeFileSync(process.env.K4_WORKSPACE_TRACE_FILE, JSON.stringify(nativeResults.filter(row =>
    !!(row as { compositeOracle?: unknown }).compositeOracle), null, 2) + "\n");
});
interface NativeContext {
  tabs: PaneTab[]; writes: Array<{ at: number; id: string; name: string; source?: string }>;
  reads: Array<{ at: number; id: string }>; snapshots: Array<{ at: number; names: string[] }>;
  workspaceWrites: Array<{ at: number; name: string; source?: string }>;
  workspaceSnapshots: Array<{ at: number; name: string; candidate: string | null; jobs: number; unknown: number; description: string }>;
  workspaceName: string; run: (at: number) => Promise<void>;
}
/** Literal tasks and observation times, never selector/aggregate/recorder expectations. */
function compositeOracle(context: NativeContext, id: string, reader: string, inputName: (at: number) => string) {
  const unknown = "作業内容未取得", { snapshots, reads, writes, workspaceWrites, workspaceSnapshots, tabs } = context;
  // Both healthy routes receive the current canonical plan each run. A plan
  // with no allocations proves loss in cache without making native IPC.
  const observed = new Set(reader !== "transcript" ? snapshots.map(s => s.at) : reads.filter(r => r.id === id + "-0").map(r => r.at));
  const expected = new Map<number, { pane: string; workspace: string; candidate: string; jobs: number; unknown: number; description: string }>();
  let candidate = inputName(0), accepted: string | undefined, pending: { name: string; readyAt: number } | undefined;
  let workspace = "以前のワークスペース名", committedAt = -Infinity, proposal: { name: string; since: number; observed: number; count: number } | undefined;
  for (const { at } of snapshots) {
    if (observed.has(at)) candidate = inputName(at);
    accepted ??= candidate;
    pending = candidate === accepted ? undefined : pending?.name === candidate ? pending : { name: candidate, readyAt: at + 10_000 };
    if (pending && at >= pending.readyAt) { accepted = pending.name; pending = undefined; }
    const known = accepted !== unknown, next = known ? accepted + "・ほか1" : unknown;
    if (workspace === next) proposal = undefined;
    else {
      if (proposal?.name !== next) proposal = { name: next, since: at, observed: at, count: 1 };
      if (at - proposal.observed >= 30_000) { proposal.count++; proposal.observed = at; }
      if (proposal.count >= 2 && at - proposal.since >= (at < 120_000 ? 30_000 : 120_000) && at - committedAt >= 300_000) {
        workspace = next; committedAt = at; proposal = undefined;
      }
    }
    expected.set(at, { pane: accepted, workspace, candidate: next, jobs: 2, unknown: known ? 1 : 2,
      description: known ? `${accepted} 1件: ${accepted}\n${unknown} 1件` : `${unknown} 2件` });
  }
  const checks: Array<{ label: string; actual: unknown; expected: unknown }> = [];
  const equal = (label: string, actual: unknown, want: unknown) => checks.push({ label, actual, expected: want });
  equal("initial read", observed.has(0), true);
  for (const s of snapshots) equal("pane snapshot at " + s.at, s.names[0], expected.get(s.at)!.pane);
  for (const w of writes.filter(w => w.id === id + "-0")) {
    equal("every pane write at " + w.at, w.name, expected.get(w.at)!.pane); equal("pane provenance", w.source, "auto");
  }
  for (const s of workspaceSnapshots) {
    const { pane: _pane, ...want } = expected.get(s.at)!;
    equal("workspace snapshot/topic/count/description at " + s.at, { workspace: s.name, candidate: s.candidate, jobs: s.jobs, unknown: s.unknown, description: s.description }, want);
  }
  for (const w of workspaceWrites) {
    equal("every workspace write at " + w.at, w.name, expected.get(w.at)!.workspace); equal("workspace provenance", w.source, "auto");
  }
  equal("final short pane name", getTabDisplayLabel(tabs[0]), expected.get(snapshots.at(-1)!.at)!.pane);
  const failures = checks.filter(c => !isDeepStrictEqual(c.actual, c.expected));
  Object.assign(nativeResults.at(-1)!, { compositeOracle: { reader, observed: [...observed], expected: [...expected], checks: checks.length, failures } });
  expect(failures, id + " composite oracle").toEqual([]);
  return { final: expected.get(snapshots.at(-1)!.at), timeline: [...expected] };
}
function reset() {
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} });
  useLiveBriefStore.getState().reset();
  useAutoNameRuntimeStore.setState({ recovery: null, revision: 0, meanings: new Map(), descriptions: new Map(), invalidatedTabs: new Map(), invalidatedWorkspaces: new Map() });
  useLauncherDirsStore.setState({ view: null });
  useSettingsStore.setState({ autoPaneNamingEnabled: true, autoWorkspaceNamingEnabled: true });
  useAiSettingsStore.setState({ aiEnabled: false });
  fake.confirm.mockReset().mockResolvedValue(true); fake.invoke.mockReset();
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(2_000_000); reset(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
/** Only native IPC is replaced; scan, reader, policy, scheduler, stores and writer are real. */
async function nativeCase(id: string, jobs: Array<{ tab?: Partial<PaneTab>; material: (at: number, tab: PaneTab) => NamingMaterial; healthy?: boolean;
  brief?: (at: number) => LiveSessionBrief; cacheEvents?: (at: number) => NamingMaterial["events"] }>,
  check: (context: NativeContext) => void | Promise<void>,
  registrations?: Array<{ section: string; label: string; path: string }>, schedule = [0, 60_000, 70_000, 90_000, 120_000, 180_000, 360_000]) {
  reset(); vi.setSystemTime(2_000_000);
  const ws = makeWorkspace([...jobs.map((job, i) => makeTab(id + "-" + i, job.tab)),
    makeTab(id + "-manual", { label: "手動の名前", labelSource: "user", displayName: "前の表示", displayNameSource: "auto" })], id);
  ws.createdAt = 2_000_000;
  const before = structuredClone(ws.panes[0].tabs);
  useWorkspaceListStore.setState({ workspaces: [ws], activeWorkspaceId: ws.id });
  if (registrations) useLauncherDirsStore.setState({ view: { doc: { entries: registrations } } as NonNullable<ReturnType<typeof useLauncherDirsStore.getState>["view"]> });
  let elapsed = 0;
  const writes: NativeContext["writes"] = [], snapshots: NativeContext["snapshots"] = [];
  const workspaceWrites: NativeContext["workspaceWrites"] = [], workspaceSnapshots: NativeContext["workspaceSnapshots"] = [];
  const reads: Array<{ at: number; id: string }> = [];
  const baselines = new Map(before.map(tab => [tab.id, tab]));
  const violations: Array<{ at: number; id: string; before: unknown; after: unknown }> = [];
  const unsubscribe = useWorkspaceListStore.subscribe((state, prior) => {
    const tabs = state.workspaces.flatMap(w => w.panes.flatMap(p => p.tabs));
    const previousTabs = prior.workspaces.flatMap(w => w.panes.flatMap(p => p.tabs));
    for (const [index, tab] of tabs.entries()) {
      const old = previousTabs.find(t => t.id === tab.id) ?? (tabs.length === previousTabs.length ? previousTabs[index] : undefined);
      if (old?.displayName !== tab.displayName || old?.displayNameSource !== tab.displayNameSource) writes.push({ at: elapsed, id: tab.id, name: tab.displayName ?? "", source: tab.displayNameSource });
      // A deliberate add/remove in a case may register another baseline. An
      // identity change during a write is compared to its previous owner too.
      const original = baselines.get(tab.id) ?? (old && baselines.get(old.id));
      if (!original) { baselines.set(tab.id, structuredClone(tab)); continue; }
      let actual: unknown = tab, expected: unknown = original;
      const protectedName = original.labelSource === "user" || (!!original.displayName && original.displayNameSource !== "auto") || (original.label && !original.labelSource);
      if (!protectedName) {
        const { displayName: _name, displayNameSource: _source, ...immutable } = tab;
        const { displayName: _oldName, displayNameSource: _oldSource, ...originalImmutable } = original;
        actual = immutable; expected = originalImmutable;
      }
      // Production isolates listener exceptions. Never assert here, and clone
      // violations so a later restoration cannot hide a transient mutation.
      if (!isDeepStrictEqual(actual, expected)) violations.push({ at: elapsed, id: tab.id, before: structuredClone(expected), after: structuredClone(actual) });
    }
    const current = state.workspaces.find(w => w.id === id), old = prior.workspaces.find(w => w.id === id);
    if (current && old && (current.name !== old.name || current.nameSource !== old.nameSource)) workspaceWrites.push({ at: elapsed, name: current.name, source: current.nameSource });
    if (current && (id.startsWith("b11-real-") || id.startsWith("b12-parity-"))) {
      const fields = ({ name: _name, nameSource: _source, panes, ...rest }: typeof ws) => ({ ...rest, panes: panes.map(({ tabs, ...pane }) => ({ ...pane,
        tabs: tabs.map(({ displayName: _display, displayNameSource: _displaySource, ...tab }) => tab) })) });
      if (!isDeepStrictEqual(fields(current), fields(ws))) violations.push({ at: elapsed, id, before: fields(ws), after: structuredClone(fields(current)) });
    }
  });
  fake.invoke.mockImplementation(async (command, args) => {
    if (command === "get_pty_metadata_snapshot") return Object.fromEntries(useWorkspaceListStore.getState().workspaces.flatMap(w => w.panes.flatMap(p => p.tabs.map(tab => [tab.sessionId, { process_status: "working" }]))));
    if (command === "get_session_output_snapshot") return {};
    if (command === "auto_name_materials") return args.requests.map((request: { tab_id: string }) => {
      const index = ws.panes[0].tabs.findIndex(tab => tab.id === request.tab_id);
      if (index < 0 || index >= jobs.length) return {...request, events: []};
      reads.push({ at: elapsed, id: request.tab_id });
      const material = jobs[index].material(elapsed, ws.panes[0].tabs[index]);
      return {...request, ...(jobs[index].brief ? material : fixtureMaterial(material))};
    });
    throw new Error("Unexpected IPC: " + command);
  });
  const scheduler = createAutoPaneNamingScheduler();
  const run = async (at: number) => {
    elapsed = at; vi.setSystemTime(2_000_000 + at);
    for (const [index, job] of jobs.entries()) if (job.healthy) {
      const tab = ws.panes[0].tabs[index], material = job.brief ? job.material(at, tab) : fixtureMaterial(job.material(at, tab));
      const brief: LiveSessionBrief = job.brief ? { ...job.brief(at), updatedAt: Date.now() } : { ptySessionId: tab.sessionId, agentSessionId: tab.agentSessionId ?? "", agentKind: "claude",
        ptyInstanceId: tab.sessionId, ptyGeneration: 1, sourceRevision: 1, ptyInputRevision: 0,
        task: null, latestInstruction: material.latest_instruction ?? null,
        taskSourceEventIds: material.events.filter(event => event.kind.type === "userMessage" && !["answer", "ack"].includes(event.kind.kind)).map(event => event.eventId),
        namingSourceEventIds: material.events.filter(event => event.kind.type === "userMessage" && event.kind.kind !== "ack").map(event => event.eventId).slice(-4),
        namingPlan: material.naming_plan,
        activityKind: null, activityText: null, activitySourceEventId: null,
        checkpoint: null, checkpointEvidenceEventIds: [], pendingInputKind: null, pendingPrompt: null, pendingOptions: [], promptEventId: null, promptHash: null,
        eventSeq: 0, operationalState: "working", telemetryHealth: "live", lastEventAt: null, lastSuccessfulReadAt: Date.now(), updatedAt: Date.now(),
        serviceEpoch: "generated", briefRevision: at + 1 };
      useLiveBriefStore.setState(state => ({ briefsBySession: { ...state.briefsBySession, [tab.sessionId]: brief },
        eventsBySession: { ...state.eventsBySession, [tab.sessionId]: job.cacheEvents?.(at) ?? fixtureEvents(material) } }));
    }
    await scheduler.runNow();
    snapshots.push({ at, names: useWorkspaceListStore.getState().workspaces[0].panes[0].tabs.slice(0, jobs.length).map(tab => getTabDisplayFullLabel(tab)) });
    const current = useWorkspaceListStore.getState().workspaces[0], summary = aggregateWorkspaceName(current, useAutoNameRuntimeStore.getState().meanings);
    workspaceSnapshots.push({ at, name: current.name, candidate: summary.name, jobs: summary.jobs, unknown: summary.unknown,
      description: useAutoNameRuntimeStore.getState().descriptions.get(id) ?? "" });
    expect(violations, "forbidden fields at an intermediate write").toEqual([]);
  };
  try {
    for (const at of schedule) await run(at);
    const after = useWorkspaceListStore.getState().workspaces[0];
    nativeResults.push({ id, verification: id.startsWith("witness-") || id.startsWith("injected-") ? "intentional-mutation" : "ordinary",
      names: after.panes[0].tabs.slice(0, jobs.length).map(tab => ({ full: getTabDisplayFullLabel(tab), short: getTabDisplayLabel(tab) })),
      workspace: after.name, writes, reads, snapshots, workspaceWrites, workspaceSnapshots });
    await check({ tabs: after.panes[0].tabs.slice(0, jobs.length), workspaceName: after.name, writes, reads, snapshots, workspaceWrites, workspaceSnapshots, run });
    expect(violations, "forbidden fields, including restored transient writes").toEqual([]);
    expect(useWorkspaceListStore.getState().workspaces[0].panes[0].tabs[jobs.length]).toEqual(before[jobs.length]);
    expect(fake.invoke.mock.calls.every(([command]) => ["get_pty_metadata_snapshot", "get_session_output_snapshot", "auto_name_materials", "agent_session_titles"].includes(command))).toBe(true);
    expect(useAiSettingsStore.getState().aiEnabled).toBe(false);
  } finally {
    scheduler.stop(); unsubscribe();
    clearNamingHolds([id], before.map(tab => tab.id)); vi.clearAllTimers();
  }
}

it("generated native: polarity and every intermediate committed name", async () => {
  const cases = targets.flatMap(target => ["編集", "制作"].flatMap(action => endings.filter(ending => !ending.positive).flatMap(ending =>
    ["。", "！"].flatMap(mark => [false, true].map(accepted => ({ target, action, ending: ending.text, mark, accepted }))))));
  await matrix("native-polarity", cases, async ({ target, action, ending, mark, accepted }, i) => {
    const request = target + "を" + action + ending + mark;
    await nativeCase("polarity-" + i, [{ material: (at, tab) => materialFor(tab, accepted && at < 60_000 ? target + "を" + action + "する" : request) }], ({ tabs, writes }) => {
      expect(tabs[0].displayName).toMatch(new RegExp("^" + UNKNOWN_AUTO_NAME + "(?:・[1-9]\\d*)?$"));
      for (const commit of writes.filter(commit => commit.at >= (accepted ? 70_000 : 0))) expect(commit.name).not.toBe(target + action);
    });
  });
}, 60_000);

it("B11 F7: forbidden-field mutations must escape the subscriber as recorded matrix violations", async () => {
  await matrix("B11-F7-mutation-witness", ["initialPrompt", "commandArgv", "manual-label", "manual-display"], async (field, i) => {
    await expect(nativeCase("witness-" + i, [{ tab: field === "manual-display" ? { displayName: "手動の表示", displayNameSource: "user" } : {},
      material: (_at, tab) => materialFor(tab, "動画を編集する") }], () => {
      const state = useWorkspaceListStore.getState(), original = structuredClone(state.workspaces);
      const changed = structuredClone(original), tab = changed[0].panes[0].tabs[field === "manual-label" ? 1 : 0];
      if (field === "initialPrompt") tab.initialPrompt = "forbidden";
      else if (field === "commandArgv") tab.commandArgv = ["forbidden"];
      else if (field === "manual-display") tab.displayName = "forbidden";
      else tab.label = "forbidden";
      useWorkspaceListStore.setState({ workspaces: changed });
      useWorkspaceListStore.setState({ workspaces: original });
    })).rejects.toThrow();
  });
});

it("B11 generated frontend: two instructions between scans and controls during quiet periods", async () => {
  const controls = nextFamilies.filter(family => family.keep).flatMap(family => family.texts);
  const cases = ["解説スライドを作る", "次は会議を予約してください", "動画を編集してはいけません"].flatMap(next =>
    controls.flatMap(control => [false, true].map(quiet => ({ next, control, quiet }))));
  await matrix("B11-native-temporal", cases, async ({ next, control, quiet }, i) => {
    await nativeCase("b11-temporal-" + i, [{ healthy: true, material: (at, tab) => {
      if (at < 60_000) return materialFor(tab, "動画を編集する");
      if (quiet && at < 65_000) return materialFor(tab, next);
      return { ...materialFor(tab, control), events: [user(0, "動画を編集する"), user(1, next), user(2, control)] };
    } }], ({ tabs, snapshots }) => {
      const expected = UNKNOWN_AUTO_NAME;
      expect(tabs[0].displayName).toBe(expected);
      for (const snapshot of snapshots.filter(snapshot => snapshot.at >= (quiet ? 75_000 : 70_000))) expect(snapshot.names[0]).toBe(expected);
    }, undefined, [0, 60_000, 65_000, 70_000, 75_000, 120_000, 180_000, 360_000]);
  });
});

it("B11 generated frontend: budgets carry incompleteness through the reader and scheduler", async () => {
  await matrix("B11-native-budgets", ["はいけません。", "は不要です。", "よいですか？", "ください。"].flatMap(suffix =>
    [false, true].map(healthy => ({ suffix, healthy }))), async ({ suffix, healthy }, i) => {
    await nativeCase("b11-budget-" + i, [{ healthy, material: (at, tab) => materialFor(tab, at < 60_000 ? "動画を編集する" :
      "引用：「" + "あ".repeat(1586) + "」。\n動画を編集して" + suffix) }], ({ tabs, writes }) => {
      expect(tabs[0].displayName).toBe(UNKNOWN_AUTO_NAME);
      for (const commit of writes.filter(commit => commit.at >= 70_000)) expect(commit.name).not.toContain("動画編集");
    });
  });
});

it("B11 generated frontend: concrete heads and estimate predicates reach composition", async () => {
  await matrix("B11-native-object-head", ["動画", "スライド"].flatMap(domain => actions.map(action => ({ domain, action }))), async ({ domain, action }, i) => {
    await nativeCase("b11-head-" + i, ["授業", "研修"].map(prefix => ({ material: (_at, tab) => materialFor(tab, prefix + domain + "の請求書を" + action + "する") })), ({ workspaceName }) => {
      expect(workspaceName).not.toMatch(/動画(?:編集|制作)|教材制作/);
    });
  });
  await matrix("B11-native-estimate-object", actions, async (action, i) => {
    await nativeCase("b11-estimate-" + i, [{ material: (_at, tab) => materialFor(tab, "機材費の見積を" + action + "する") }], ({ tabs }) => {
      expect(tabs[0].displayName).toBe(action === "制作" ? "機材費見積" : "機材費の見積" + action);
    });
  });
});

it("B11 generated frontend: mixed workspace invalidation retains held weights", async () => {
  await matrix("B11-native-mixed-workspace", ["held-control", "held-absent", "fresh"].flatMap(state => [0, 1].map(unknown => ({ state, unknown }))), async ({ state, unknown }, i) => {
    await nativeCase("b11-mixed-" + i, [
      { material: (at, tab) => materialFor(tab, at < 180_000 ? "動画を編集する" : "動画を編集しない") },
      { material: (at, tab) => materialFor(tab, at < 180_000 || state === "fresh" ? "解説スライドを作る" : state === "held-control" ? "続きをお願いします" : undefined) },
      ...Array.from({ length: unknown }, () => ({ material: (_at: number, tab: PaneTab) => materialFor(tab) })),
    ], ({ workspaceName, workspaceWrites }) => {
      const expected = state === "fresh" ? "解説スライド制作・ほか" + (unknown + 2) : UNKNOWN_AUTO_NAME;
      expect(workspaceName).toBe(expected);
      for (const write of workspaceWrites.filter(w => w.at >= 420_000)) expect(write.name).toBe(expected);
    },
    undefined, [0, 60_000, 120_000, 180_000, 190_000, 300_000, 420_000, 480_000]);
    expect(useAutoNameRuntimeStore.getState().meanings.get("b11-mixed-" + i + "-1")?.fresh).toBe(state === "fresh");
  });
});

it.runIf(!!process.env.B11_NATIVE_RECORDING)("B11 real native: recorded adapter → reducer → native reader → frontend reader → scheduler", async () => {
  const recording = JSON.parse(readFileSync(process.env.B11_NATIVE_RECORDING!, "utf8")) as {
    schema: string; head: string; cases: Array<{ id: string; family: string; reader: string; expected: string; stableAt?: number;
      frames: Array<{ at: number; brief: LiveSessionBrief; cache_events: NamingMaterial["events"]; material: NamingMaterial;
        raw_records: Array<{ message: { role: string; content: string | Array<{ type: string; name?: string; text?: string }> } }> }> }>;
  };
  expect(recording.schema).toBe("B11-native-recording-v1"); expect(recording.head).toBe(process.env.B11_RECORD_HEAD);
  expect(recording.cases).toHaveLength(375);
  // Literal fixture tasks and raw question ordering are independent of the adapter,
  // selector, policy and the recorder's old expected field.
  const direct: Record<string, string> = { "動画を編集する": "動画編集", "字幕位置を修正する": "字幕位置修正",
    "解説スライドを制作する": "解説スライド制作", "解説スライドを作る": "解説スライド制作" };
  for (const target of ["動画", "字幕位置", "解説スライド"]) direct[target + "ではなく解説スライドを作る"] = "解説スライド制作";
  for (const reader of ["live-cached", "live-native", "transcript"]) await matrix("B11-real-native-" + reader, recording.cases.filter(c => c.reader === reader), async c => {
    const frame = (at: number) => [...c.frames].reverse().find(frame => frame.at <= at)!;
    const inputName = (at: number) => {
      let open = false, name = UNKNOWN_AUTO_NAME;
      for (const record of frame(at).raw_records) {
        const content = record.message.content;
        if (record.message.role === "user") {
          const text = typeof content === "string" ? content : content.find(part => part.type === "text")?.text;
          if (text !== undefined) name = open ? UNKNOWN_AUTO_NAME : direct[text] ?? UNKNOWN_AUTO_NAME;
          if (Array.isArray(content) && content.some(part => part.type === "tool_result")) open = false;
        } else if (Array.isArray(content) && content.some(part => part.type === "tool_use" && part.name === "AskUserQuestion")) open = true;
      }
      return name;
    };
    await nativeCase(c.id, [{ healthy: reader !== "transcript", material: at => frame(at).material,
      brief: at => frame(at).brief, cacheEvents: at => reader === "live-cached" ? frame(at).cache_events : [] }], context => {
      compositeOracle(context, c.id, reader, inputName);
    }, undefined, [0, 60_000, 65_000, 69_999, 70_000, 74_999, 75_000, 119_999, 120_000, 129_999, 130_000, 180_000, 360_000, 420_000, 480_000]);
    const calls = fake.invoke.mock.calls.filter(([command, args]) => command === "auto_name_materials" && args.requests.some((request: { tab_id: string }) => request.tab_id === c.id + "-0"));
    if (reader === "live-cached") expect(calls).toHaveLength(0); else expect(calls.length).toBeGreaterThan(0);
  });
}, 60_000);

it("B12 generated parity: complete controls preserve deadlines and missing histories wait for evidence in all three readers", async () => {
  const seed = JSON.parse(readFileSync("tests/fixtures/auto_naming_reader_parity.json", "utf8")) as {
    schema: string; frames: Array<{ brief: LiveSessionBrief; material: NamingMaterial; cache_events: NamingMaterial["events"] }>;
  };
  expect(seed.schema).toBe("B12-reader-parity-seed-v1");
  const readers = ["live-cached", "live-native", "transcript"] as const;
  const kinds: UserMessageKind[] = ["taskStart", "taskChange", "correction", "answer", "ack"];
  const controls = nextFamilies.filter(family => family.keep).flatMap(family => family.texts);
  const cases = [false, true].flatMap(missing => (missing ? ["controlled", "direct"] : ["controlled"]).flatMap(delivery =>
    (missing ? [60_000, 90_000] : [60_000, 90_000, 150_000]).flatMap(change =>
      (missing ? [1_000, 5_000, 9_000] : [0, 1_000, 5_000, 9_000, 15_000, 60_000]).flatMap(gap =>
        controls.flatMap(control => kinds.map(kind => ({ missing, delivery, change, gap, control, kind })))))));
  expect(cases).toHaveLength(900); // The old 720 rows plus 180 genuinely later direct recoveries.
  await matrix("B12-reader-parity", cases, async ({ missing, delivery, change, gap, control, kind }, i) => {
    const controlledAt = change + gap;
    const schedule = [...new Set([...(missing ? [0, change, controlledAt, change + 10_000, controlledAt + 10_000, 119_000, 170_000, 180_000, 240_000]
      : [0, change, controlledAt, change + 10_000, controlledAt + 10_000, change + 60_000, controlledAt + 60_000]),
      360_000, 420_000, 480_000, 540_000, 780_000])].sort((a, b) => a - b);
    const traces: ReturnType<typeof compositeOracle>[] = [];
    for (const reader of readers) {
      const id = `b12-parity-${i}-${reader}`;
      const frame = (at: number, tab = makeTab(id + "-0")) => {
        const phase = at < change ? 0 : at < controlledAt ? 1 : 2;
        const source = structuredClone(seed.frames[phase]);
        const { brief, cache_events: events } = source;
        if (phase === 2) {
          const latest = events.at(-1)!;
          if (latest.kind.type === "userMessage") { latest.kind.text = control; latest.kind.kind = kind; }
          if (kind === "answer" || kind === "ack") {
            brief.latestInstruction = seed.frames[1].brief.latestInstruction;
            brief.taskSourceEventIds = [...seed.frames[1].brief.taskSourceEventIds];
          } else brief.latestInstruction = control;
        }
        if (missing && at >= 170_000 && delivery === "direct") {
          // A new occurrence after the control, never reusing the old B at byte 89.
          events.push(user(3, "解説スライドを作る")); brief.latestInstruction = "解説スライドを作る";
        }
        const incomplete = missing && at >= change && at < 170_000;
        if (incomplete) events.splice(0, events.length, ...(phase === 2 ? events.slice(-1) : []));
        const material = fixtureMaterial({ ...source.material, latest_instruction: null, events,
          tab_id: tab.id, pty_session_id: tab.sessionId, agent_session_id: tab.agentSessionId, agent_kind: tab.agentKind, cwd: tab.cwd });
        material.naming_plan!.coverage.sourceUnknown = incomplete;
        material.instruction_history_complete = !incomplete;
        Object.assign(brief, { ptySessionId: tab.sessionId, agentSessionId: tab.agentSessionId, agentKind: tab.agentKind,
          namingPlan: material.naming_plan, namingSourceEventIds: events.filter(e => e.kind.type === "userMessage" && e.kind.kind !== "ack").map(e => e.eventId).slice(-4) });
        if (phase === 2 && (kind === "answer" || kind === "ack") && !(missing && at >= 170_000 && delivery === "direct")) {
          expect(brief.latestInstruction).toBe("解説スライドを作る");
          expect(material.naming_plan!.latestInput?.kind).toBe(kind);
        }
        return { material, brief, events };
      };
      const inputName = (at: number) => at < change ? "動画編集" : missing && at < 170_000 ? "作業内容未取得"
        : missing && delivery === "direct" ? "解説スライド制作" : at < controlledAt ? "解説スライド制作" : "作業内容未取得";
      await nativeCase(id, [{ healthy: reader !== "transcript", material: (at, tab) => frame(at, tab).material,
        brief: at => frame(at).brief, cacheEvents: at => reader === "live-cached" ? frame(at).events : [] }], context => {
        traces.push(compositeOracle(context, id, reader, inputName));
      }, undefined, schedule);
    }
    expect(traces[1], "same live deadlines and composition even when unchanged input is cached").toEqual(traces[0]);
    expect(traces[2].final, "physical sampling keeps its own deadlines, then converges in composition").toEqual(traces[0].final);
  });
}, 60_000);

it.runIf(process.env.B11_FORBIDDEN_MUTATION_WITNESS === "1")("B11 F7 injected: a forbidden-field change fails the real generated matrix", async () => {
  await matrix("B11-F7-injected-mutation", ["initialPrompt", "commandArgv"], async (field, i) => {
    await nativeCase("injected-" + i, [{ material: (_at, tab) => materialFor(tab, "動画を編集する") }], () => {
      const original = structuredClone(useWorkspaceListStore.getState().workspaces), changed = structuredClone(original);
      if (field === "initialPrompt") changed[0].panes[0].tabs[0].initialPrompt = "forbidden";
      else changed[0].panes[0].tabs[0].commandArgv = ["forbidden"];
      useWorkspaceListStore.setState({ workspaces: changed });
      useWorkspaceListStore.setState({ workspaces: original });
    });
  });
});

it("generated native: status/continuation/replacement with bounded histories and incidental files", async () => {
  const cases = tasks.flatMap(task => nextFamilies.flatMap(family => family.texts.slice(0, 2).flatMap(text =>
    [false, true].flatMap(inWindow => [false, true].map(incidental => ({ task, kind: family.kind, keep: family.keep, text, inWindow, incidental }))))));
  await matrix("native-transitions", cases, async ({ task, kind, keep, text, inWindow, incidental }, i) => {
    const request = kind === "replacement" ? task.target + "ではなく" + text : text;
    await nativeCase("transition-" + i, [{ material: (at, tab) => {
      if (at < 60_000) return materialFor(tab, task.request);
      const material = materialFor(tab, request);
      material.events = inWindow ? [user(0, task.request), user(1, request)] :
        [user(0, task.request), ...Array.from({ length: 24 }, (_, index) => envelope(index + 1, { type: "agentMessage", text: "50%" })), user(25, request)];
      if (incidental) material.events.push(write(30, task.target === "動画" ? "temporary.pptx" : "temporary.mp4"));
      return material;
    } }], ({ tabs, writes, snapshots }) => {
      if (keep) expect(tabs[0].displayName).toBe(UNKNOWN_AUTO_NAME); else expect(tabs[0].displayName).not.toBe(task.name);
      for (const snapshot of snapshots.filter(snapshot => snapshot.at >= 70_000)) {
        if (keep) expect(snapshot.names[0]).toBe(UNKNOWN_AUTO_NAME); else expect(snapshot.names[0]).not.toBe(task.name);
      }
      for (const commit of writes.filter(commit => commit.at >= 70_000)) {
        if (keep) expect(commit.name).toBe(UNKNOWN_AUTO_NAME); else expect(commit.name).not.toBe(task.name);
      }
    });
  });
}, 60_000);

it("generated native: healthy latest-instruction-only DTO keeps noun identities distinct", async () => {
  const cases = [["計算表", "集計表"], ["アップロード処理", "納品処理"], ["確認画面", "検査画面"], ["作成履歴", "制作履歴"]].flatMap(pair =>
    ["制作", "修正"].map(action => ({ pair, action })));
  await matrix("native-noun-cache", cases, async ({ pair, action }, i) => {
    await nativeCase("noun-" + i, [{ healthy: true, material: (at, tab) => materialFor(tab, pair[at < 60_000 ? 0 : 1] + "を" + action + "する", at < 60_000 ? 0 : 1) }], ({ tabs, writes }) => {
      expect(tabs[0].displayName).toContain(pair[1]); expect(tabs[0].displayName).not.toContain(pair[0]);
      for (const commit of writes.filter(commit => commit.at >= 70_000)) expect(commit.name).not.toContain(pair[0]);
    });
  });
});

it("generated native: compatible domain/actions", async () => {
  await matrix("native-domain-actions", ["動画", "スライド"].flatMap(domain => actions.map(action => ({ domain, action }))), async ({ domain, action }, i) => {
    await nativeCase("domain-" + i, ["授業", "研修"].map(prefix => ({ material: (_at, tab) => materialFor(tab, prefix + domain + "を" + action + "する") })), ({ workspaceName }) => {
      if (!["制作", "修正", "校正", "調整", "編集"].includes(action)) expect(workspaceName).not.toMatch(/動画(?:編集|制作)|教材制作/);
    });
  });
}, 60_000);

it("generated native: nearest project identity", async () => {
  await matrix("native-project", ["サンプル企画", "共通のサンプル企画", "授業資料の企画"].flatMap(parent => ["の", " "].map(separator => ({ parent, separator }))), async ({ parent, separator }, i) => {
    const children = ["数学", "国語", "理科"];
    await nativeCase("project-" + i, children.map((child, index) => ({ tab: { cwd: "/fixture/child-" + index },
      material: (_at, tab) => materialFor(tab, parent + separator + "スライドを制作する") })), ({ tabs }) => {
      children.forEach((child, index) => expect(getTabDisplayLabel(tabs[index])).toContain(child));
      expect(new Set(tabs.map(tab => namePrefix(getTabDisplayLabel(tab)))).size).toBe(children.length);
      expect(tabs.every(tab => !/・\d+$/.test(getTabDisplayLabel(tab)))).toBe(true);
    }, [{ label: parent, section: "subjects", path: "/fixture" }, ...children.map((child, index) => ({ label: parent + "/" + child, section: "subjects", path: "/fixture/child-" + index }))]);
  });
}, 60_000);

it("generated native: complete nouns", async () => {
  await matrix("native-nouns", ["きのこ", "たけのこ", "いのしし", "もののけ", "つのぶえ", "ほのぼの", "のり"], async (noun, i) => {
    await nativeCase("clip-" + i, [{ material: (_at, tab) => materialFor(tab, "小学校低学年向け理科の" + noun + "の観察記録を制作する") }], ({ tabs }) => {
      expect(getTabDisplayLabel(tabs[0])).toContain(noun + "の観察記録");
    });
  });
}, 60_000);

it("generated native: normalized acknowledgement", async () => {
  const ackCases = ["了解", "はい", "OK"].flatMap(ack => ["！", "!", "?"].flatMap(mark => ["字幕位置", "解説スライド"].map(target => ({ ack, mark, target }))));
  await matrix("native-ack", ackCases, async ({ ack, mark, target }, i) => {
    await nativeCase("ack-" + i, [{ material: (_at, tab) => materialFor(tab, ack + mark + "次は" + target + "を修正してください") }], ({ tabs }) => {
      expect(tabs[0].displayName).toBe(target + "修正");
    });
  });
}, 60_000);

it("generated native: exhausted arrangements and unknown reservations never keep a rejected job", async () => {
  await matrix("native-collisions", [4, 5, 6].flatMap(size => ["replacement", "rejection"].map(kind => ({ size, kind }))), async ({ size, kind }, i) => {
    const jobs = Array.from({ length: size }, (_, index) => ({ material: (at: number, tab: PaneTab) => materialFor(tab, index === size - 1 && at < 60_000 ? "動画を編集する" :
      index === size - 1 && kind === "rejection" ? "動画を編集してはいけません" :
      (index === size - 1 ? "動画ではなく" : "") + "数学スライドの解説ページ" + "甲乙丙丁戊己"[index] + "を確認する") }));
    await nativeCase("collision-" + i, jobs, ({ tabs, writes }) => {
      expect(tabs[size - 1].displayName).not.toContain("動画編集");
      expect(new Set(tabs.map(tab => getTabDisplayLabel(tab))).size).toBe(size);
      for (const commit of writes.filter(commit => commit.at >= 70_000)) expect(commit.name).not.toContain("動画編集");
    });
  });
}, 60_000);

it("generated native: unknown reservations and stable additions", async () => {
  await matrix("native-unknown", [2, 4].flatMap(size => [UNKNOWN_AUTO_NAME, UNKNOWN_AUTO_NAME + "・1", UNKNOWN_AUTO_NAME + "・2"].map(reservation => ({ size, reservation }))), async ({ size, reservation }, i) => {
    await nativeCase("unknown-" + i, [...Array.from({ length: size }, () => ({ material: (_at: number, tab: PaneTab) => materialFor(tab) })),
      { tab: { label: "legacy readable", labelSource: undefined, displayName: reservation, displayNameSource: "auto" }, material: (_at: number, tab: PaneTab) => materialFor(tab) }], async ({ tabs, run }) => {
      const initial = tabs.slice(0, size).map(tab => getTabDisplayLabel(tab));
      expect(new Set([...initial, reservation]).size).toBe(size + 1);
      const ws = useWorkspaceListStore.getState().workspaces[0], added = makeTab("0-added-" + i);
      useWorkspaceListStore.setState({ workspaces: [{ ...ws, panes: [{ ...ws.panes[0], tabs: [added, ...ws.panes[0].tabs] }] }] });
      await run(420_000);
      // Exact IDs, rather than positions, must retain their reservations.
      tabs.slice(0, size).forEach((tab, index) => expect(getTabDisplayLabel(useWorkspaceListStore.getState().workspaces[0].panes[0].tabs.find(t => t.id === tab.id)!)).toBe(initial[index]));
      const addedTabs = useWorkspaceListStore.getState().workspaces[0].panes[0].tabs.filter(tab => tab.labelSource !== "user");
      expect(new Set(addedTabs.map(tab => getTabDisplayLabel(tab))).size).toBe(addedTabs.length);
      const live = useWorkspaceListStore.getState().workspaces[0];
      useWorkspaceListStore.setState({ workspaces: [{ ...live, panes: [{ ...live.panes[0], tabs: live.panes[0].tabs.filter(tab => tab.id !== tabs[0].id) }] }] });
      await run(480_000);
      tabs.slice(1, size).forEach((tab, index) => expect(getTabDisplayLabel(useWorkspaceListStore.getState().workspaces[0].panes[0].tabs.find(t => t.id === tab.id)!)).toBe(initial[index + 1]));
    });
  });
}, 60_000);

it("generated operational boundaries preserve scoped undo/hold and bound raw reader batches", async () => {
  await matrix("native-scoped-undo", ["cwd", "identity", "pane"], async (overlay, i) => {
    reset(); vi.setSystemTime(2_000_000);
    const a = makeWorkspace([makeTab("undo-a-" + i, { displayName: "日付表示修正", displayNameSource: "auto" })], "a-" + i);
    const b = makeWorkspace([makeTab("undo-b-" + i)], "b-" + i);
    if (overlay === "cwd") usePaneMetadataStore.setState({ metadata: { [a.panes[0].tabs[0].sessionId]: { cwd: "/fixture/sub" } } });
    if (overlay === "identity") usePaneMetadataStore.setState({ metadata: { [a.panes[0].tabs[0].sessionId]: { agentKind: "codex", agentSessionId: "live-agent" } } });
    if (overlay === "pane") { a.panes[0].cwd = "/fixture/sub"; a.panes[0].tabs[0].cwd = undefined; }
    useWorkspaceListStore.setState({ workspaces: [a, b] });
    const before = structuredClone(a.panes[0].tabs[0]); let now = 0;
    fake.invoke.mockImplementation(async (command, args) => {
      if (command === "get_pty_metadata_snapshot") return Object.fromEntries([a, b].flatMap(w => w.panes[0].tabs.map(t => [t.sessionId, { process_status: "working" }])));
      if (command === "get_session_output_snapshot") return {};
      if (command === "auto_name_materials") return args.requests.map((request: NamingMaterial) => fixtureMaterial({ ...request,
        latest_instruction: request.tab_id.startsWith("undo-a") ? (now < 60_000 ? "日付表示を修正する" : "字幕位置を修正する") : now < 60_000 ? "解説スライドを制作する" : "字幕位置を修正する", events: [] }, now < 60_000 ? 0 : 1));
      throw new Error(String(command));
    });
    const scheduler = createAutoPaneNamingScheduler();
    try {
      await scheduler.runNow();
      now = 60_000; vi.setSystemTime(2_060_000); await scheduler.runNow();
      await recoverNamesFromContent(a.id); undoRecoveredNames(); await scheduler.runNow();
      expect(useWorkspaceListStore.getState().workspaces[0].panes[0].tabs[0]).toEqual(before);
      expect(useWorkspaceListStore.getState().workspaces[1].panes[0].tabs[0].displayName).toBe("解説スライド制作");
      now = 70_000; vi.setSystemTime(2_070_000); await scheduler.runNow();
      expect(useWorkspaceListStore.getState().workspaces[1].panes[0].tabs[0].displayName).toBe("字幕位置修正");
    } finally { scheduler.stop(); clearNamingHolds([a.id, b.id], [a.panes[0].tabs[0].id, b.panes[0].tabs[0].id]); }
  });
  await matrix("native-reader-limits", [65, 129, 130], async size => {
    reset(); vi.setSystemTime(2_000_000);
    const ws = makeWorkspace(Array.from({ length: size }, (_, i) => makeTab("limit-" + size + "-" + i)));
    useWorkspaceListStore.setState({ workspaces: [ws] });
    fake.invoke.mockImplementation(async command => {
      if (command === "get_pty_metadata_snapshot") return Object.fromEntries(ws.panes[0].tabs.map(t => [t.sessionId, { process_status: "working" }]));
      if (command === "get_session_output_snapshot") return {};
      if (command === "auto_name_materials") throw new Error("unavailable");
      throw new Error(String(command));
    });
    await readAutoNameScan(); const attempts = fake.invoke.mock.calls.filter(([command]) => command === "auto_name_materials");
    expect(attempts.map(([, args]) => args.requests.length)).toEqual(Array.from({ length: Math.ceil(size / 64) }, (_, i) => Math.min(64, size - 64 * i)));
    vi.setSystemTime(2_030_000); await readAutoNameScan();
    expect(fake.invoke.mock.calls.filter(([command]) => command === "auto_name_materials")).toHaveLength(attempts.length);
    useWorkspaceListStore.setState({ workspaces: [{ ...ws, status: "stopped" }] });
    const stopped = await readAutoNameScan(); expect(stopped.tabs).toHaveLength(0);
    expect(fake.invoke.mock.calls.filter(([command]) => command === "auto_name_materials")).toHaveLength(attempts.length);
  });
}, 60_000);

it("generated native: unresolved predicate context never appears in intermediate committed names", async () => {
  const cases = ["動画", "字幕位置"].flatMap(target => ["編集", "修正"].flatMap(action =>
    ["してはいけません", "する必要はありません", "しないでください", "しなくてよい"].flatMap(ending =>
      ["。", "が", ""].flatMap(join => ["before", "after"].map(order => ({ target, action, ending, join, order }))))));
  await matrix("native-whole-predicate", cases, async ({ target, action, ending, join, order }, i) => {
    const negative = target + "を" + action + ending, positive = "字幕位置を修正してください";
    const text = order === "before" ? negative + join + positive : positive + join + negative;
    await nativeCase("predicate-" + i, [{ material: (at, tab) => materialFor(tab, at < 60_000 ? "動画を編集する" : text) }], ({ tabs, writes }) => {
      if (order === "after" && target === "字幕位置" && action === "修正") expect(tabs[0].displayName).toMatch(new RegExp("^" + UNKNOWN_AUTO_NAME));
      else expect([UNKNOWN_AUTO_NAME, "字幕位置修正"]).toContain(tabs[0].displayName);
      for (const commit of writes.filter(commit => commit.at >= 70_000)) expect([UNKNOWN_AUTO_NAME, "字幕位置修正"]).toContain(commit.name);
    });
  });
}, 60_000);

it("generated native: invalidated work cannot leave an obsolete automatic workspace name", async () => {
  const cases = tasks.flatMap(task => ["次は会議を予約してください", "次は設備を点検してください",
    task.target + "を" + task.action + "しない", task.target + "を" + task.action + "してはいけません",
    task.target + "を" + task.action + "する必要はありません", task.target + "ではなく配送便を手配してください"].map(text => ({ task, text })));
  await matrix("native-workspace-invalidation", cases, async ({ task, text }, i) => {
    await nativeCase("workspace-invalidation-" + i, [{ material: (at, tab) => materialFor(tab, at < 60_000 ? task.request : text) }], ({ workspaceName }) => {
      expect(workspaceName).toBe(UNKNOWN_AUTO_NAME);
    });
  });
}, 60_000);

it("generated native: identical child labels preserve registered parent identity", async () => {
  await matrix("native-project-identity", ["企画", "サンプル企画", "共通授業企画"], async (parent, i) => {
    await nativeCase("identity-" + i, ["甲", "乙"].map((suffix, index) => ({ tab: { cwd: "/fixture/parent-" + index + "/src" },
      material: (_at, tab) => materialFor(tab, parent + "のスライドを制作する") })), ({ tabs }) => {
      tabs.forEach((tab, index) => { const name = getTabDisplayLabel(tab);
        if (!name.startsWith(UNKNOWN_AUTO_NAME)) { expect(name).toContain(parent + "甲乙"[index]); expect(name).toContain("数学"); expect(name).not.toMatch(/・\d+$/); } });
      expect(new Set(tabs.map(tab => getTabDisplayLabel(tab))).size).toBe(2);
    }, [{ section: "subjects", label: parent, path: "/fixture" }, ...["甲", "乙"].map((suffix, index) => ({ section: "subjects", label: parent + suffix + "/数学", path: "/fixture/parent-" + index }))]);
  });
});

it("generated native: unknown new task questions invalidate the prior work", async () => {
  const cases = tasks.flatMap(task => ["会議", "休憩", "配送"].flatMap(object => ["次は", ""].flatMap(prefix =>
    ["が", ""].flatMap(particle => ["か", "？"].map(mark => ({ task, text: prefix + object + particle + "進めます" + mark }))))));
  await matrix("native-new-job-questions", cases, async ({ task, text }, i) => {
    await nativeCase("question-" + i, [{ material: (at, tab) => materialFor(tab, at < 60_000 ? task.request : text) }], ({ tabs, writes }) => {
      expect(tabs[0].displayName).not.toBe(task.name);
      for (const commit of writes.filter(commit => commit.at >= 70_000)) expect(commit.name).not.toBe(task.name);
    });
  });
}, 60_000);

it("generated native: invalidation is lost from the tail without resurrecting a weak task", async () => {
  const cases = tasks.flatMap(task => ["rejection", "unknown", "replacement"].flatMap(kind => ["file", "activity"].map(source => ({ task, kind, source }))));
  await matrix("native-invalidated-tail-loss", cases, async ({ task, kind, source }, i) => {
    const invalid = kind === "rejection" ? task.target + "を" + task.action + "しない" : kind === "unknown" ? "次は会議を予約してください" : task.target + "ではなく配送便を手配してください";
    await nativeCase("invalidated-tail-" + i, [{ material: (at, tab) => {
      if (at < 60_000 || at >= 420_000) return materialFor(tab, task.request);
      if (at < 120_000) return materialFor(tab, invalid);
      const material = materialFor(tab);
      material.events = source === "file" ? [write(30, "temporary.mp4")] : [envelope(30, { type: "agentMessage", text: task.request.replace("する", "している") })];
      return material;
    } }], async ({ tabs, writes, run }) => {
      expect(tabs[0].displayName).toBe(UNKNOWN_AUTO_NAME);
      for (const commit of writes.filter(commit => commit.at >= 70_000)) expect(commit.name).toBe(UNKNOWN_AUTO_NAME);
      await run(420_000); await run(430_000);
      expect(useWorkspaceListStore.getState().workspaces[0].panes[0].tabs[0].displayName).toBe(task.name);
    });
  });
}, 60_000);
