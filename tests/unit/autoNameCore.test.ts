// @vitest-environment jsdom
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { buildAutoNameEvidence, namingBinding, plannedNamingMaterial, type NamingMaterial } from "../../src/lib/autoNameMaterial";
import { createAutoPaneNamingScheduler } from "../../src/lib/autoPaneNaming";
import { aggregateWorkspaceName, createAutoWorkspaceNamePolicy, type WorkspaceNameSummary } from "../../src/lib/autoWorkspaceNaming";
import { deriveAutoName, type AutoNameMeaning } from "../../src/lib/autoNamePolicy";
import { getTabDisplayFullLabel, getTabDisplayLabel } from "../../src/lib/tabDisplayLabel";
import type { LiveSessionBrief, UserMessageKind } from "../../src/lib/livebrief";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useLiveBriefStore } from "../../src/stores/liveBriefStore";
import { useAutoNameRuntimeStore, clearNamingHolds } from "../../src/stores/autoNameRuntimeStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useAiSettingsStore } from "../../src/stores/aiSettingsStore";
import { useLauncherDirsStore } from "../../src/stores/launcherDirsStore";
import type { PaneTab, Workspace } from "../../src/types";
import { actions, envelope, fixtureMaterial, makeTab, makeWorkspace, materialFor, policyHarness, user } from "./helpers/autoNamingInvariants";

// Oracles are literal target/action contracts from CORE, never parser/selector outputs.
const UNKNOWN = "作業内容未取得", A = "動画編集", B = "解説スライド制作";
const initial = "動画を編集する", direct = "解説スライドを作る";
const fake = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: fake.invoke }));
type Check = { label: string; actual: unknown; expected: unknown };
type Row = { input: unknown; checks: Check[]; failures: Check[]; trace: unknown };
const reports: Record<string, Row[]> = {};
function equal(checks: Check[], label: string, actual: unknown, expected: unknown): void { checks.push({ label, actual, expected }); }
async function cases<T>(group: string, inputs: T[], run: (input: T, checks: Check[]) => unknown | Promise<unknown>): Promise<void> {
  const rows: Row[] = reports[group] = [];
  for (const input of inputs) {
    const checks: Check[] = []; let trace: unknown;
    try { trace = await run(input, checks); }
    catch (error) { checks.push({ label: "unexpected exception (not semantic red evidence)", actual: String(error), expected: null }); }
    rows.push({ input, checks, failures: checks.filter(c => !isDeepStrictEqual(c.actual, c.expected)), trace });
  }
  const failed = rows.filter(row => row.failures.length).length;
  console.log(`${group}: ${inputs.length} cases, ${failed} failed`);
  expect.soft(failed, `${group}: ${JSON.stringify(rows.filter(r => r.failures.length).slice(0, 2).map(r => ({ input: r.input, failures: r.failures })))}`).toBe(0);
}
afterAll(() => {
  if (process.env.K1_TRACE_PREFIX) writeFileSync(process.env.K1_TRACE_PREFIX + "-trace.json", JSON.stringify({
    productCommit: process.env.K1_PRODUCT_SHA, groups: reports,
    total: Object.values(reports).reduce((n, rows) => n + rows.length, 0),
    failed: Object.values(reports).flat().filter(row => row.failures.length).length,
  }, null, 2) + "\n");
});
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(2_000_000); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
const message = (index: number, text: string, kind: UserMessageKind = "taskChange") => envelope(index, { type: "userMessage", text, kind, digest: String(index) });
const scanTab = (tab: PaneTab) => ({ ...tab, label: tab.label ?? "", agentKind: tab.agentKind ?? "", cwd: tab.cwd ?? "",
  workspaceId: "w", workspaceName: "", paneId: "p", column: 1, tail: [], lastOutputAt: null });
function finish(h: ReturnType<typeof policyHarness>, checks: Check[], expected: string): unknown {
  const first = h.run(65_000).get("t")?.displayName, stable = h.run(75_000).get("t")?.displayName;
  equal(checks, "stable current task", stable, expected);
  for (const at of [120_000, 360_000]) equal(checks, "no resurrection at " + at, h.run(at).get("t")?.displayName, expected);
  for (const write of h.writes.filter(w => w.at >= 75_000)) equal(checks, "every stable pane write", write.name, expected);
  const beforeRecovery = structuredClone(h.writes);
  Object.assign(h.materials.get("t")!, { latest_instruction: direct, latest_instruction_kind: "taskChange", events: [message(1000, direct)] });
  h.run(420_000); equal(checks, "later complete direct instruction", h.run(430_000).get("t")?.displayName, B);
  return { first, stable, beforeRecovery, recoveredWrites: h.writes };
}

it("K1 G1 count: an unobserved change followed by bounded replies cannot authorize old work", async () => {
  const inputs = [direct, "動画を編集してはいけません", "次は会議を予約してください"].flatMap(next =>
    (["answer", "ack", "taskChange"] as const).flatMap(kind => [0, 1, 3, 4, 5, 8].flatMap(count =>
      [false, true].flatMap(observed => [0, 24, 200].map(noise => ({ next, kind, count, observed, noise }))))));
  await cases("G1-count-frontend", inputs, ({ next, kind, count, observed, noise }, checks) => {
    const h = policyHarness(), m = h.materials.get("t")!;
    m.latest_instruction = initial; m.events = [user(0, initial)]; h.run(0);
    if (observed) { m.latest_instruction = next; m.events = [message(1, next)]; h.run(60_000); }
    m.latest_instruction = kind === "taskChange" && count ? "続きをお願いします" : next;
    m.events = [user(0, initial), message(1, next), ...Array.from({ length: noise }, (_, i) => envelope(i + 2, { type: "agentMessage", text: "50%" })),
      ...Array.from({ length: count }, (_, i) => message(noise + i + 2, kind === "ack" ? "了解" : kind === "taskChange" ? "続きをお願いします" : ["A", "動画", "はい", "了解"][i % 4], kind))];
    const evidence = buildAutoNameEvidence(scanTab(h.tabs[0]), fixtureMaterial(m));
    equal(checks, "bounded instruction count", evidence.instructions.length <= 4, true);
    equal(checks, "bounded Unicode scalar budget", evidence.instructions.reduce((n, v) => n + Array.from(v).length, 0) <= 1600, true);
    return { material: structuredClone(m), evidence, result: finish(h, checks, count === 0 && next === direct ? B : UNKNOWN) };
  });
});

it("K1 G1 budget: zero remaining characters lose evidence before any represented clipping", async () => {
  const inputs = [0, 1, 7, 21, 79].flatMap(remaining => [-1, 0, 1].flatMap(delta => ["あ", "😀", "e\u0301"].map(pad => ({ remaining, delta, pad }))));
  await cases("G1-budget-frontend", inputs, ({ remaining, delta, pad }, checks) => {
    const control = "続きをお願いします", size = 1600 - remaining + delta;
    const padding = Array.from(pad.repeat(size)).slice(0, size - 7 - Array.from(control).length).join("");
    const latest = "引用：「" + padding + "」。\n" + control;
    equal(checks, "complete input scalar length", Array.from(latest).length, size);
    const h = policyHarness(), m = h.materials.get("t")!;
    m.latest_instruction = initial; m.events = [user(0, initial)]; h.run(0);
    // The prohibition is never separately observed by naming.
    m.latest_instruction = latest; m.events = [user(0, initial), message(1, "動画を編集してはいけません"), message(2, latest)];
    const evidence = buildAutoNameEvidence(scanTab(h.tabs[0]), fixtureMaterial(m));
    equal(checks, "real frontend scalar bounding", evidence.instructions.reduce((n, v) => n + Array.from(v).length, 0) <= 1600, true);
    return { material: structuredClone(m), evidence, representedIncomplete: evidence.instructionCompleteness?.filter(v => !v).length,
      result: finish(h, checks, UNKNOWN) };
  });
});

it("K1 G2 replies: marker-free cancellation and replacement answers remain uncertainty", async () => {
  const texts = ["その作業は中止してください", "この作業は取りやめてください", "次の仕事は会議の予約です", "その案件は別の仕事に切り替えてください"];
  const inputs = texts.flatMap(text => (["answer", "taskChange"] as const).flatMap(kind => ["", "追記：", "確認です。"].map(prefix => ({ text: prefix + text, kind }))))
    .concat(["はい", "A", "動画", "はい。追加の仕事です", "A。追加の仕事です", "動画。追加の仕事です"].map(text => ({ text, kind: "answer" as const })));
  await cases("G2-reply-frontend", inputs, ({ text, kind }, checks) => {
    equal(checks, "none of the old answer whitelist's object markers", /(?:を|について|に対して)/.test(text), false);
    const h = policyHarness(), m = h.materials.get("t")!;
    m.latest_instruction = initial; m.events = [user(0, initial)]; h.run(0);
    m.latest_instruction = kind === "answer" ? initial : text; m.events.push(message(1, text, kind));
    const input = structuredClone(m), result = finish(h, checks, UNKNOWN);
    // This is a frontend wire-boundary test. The real reducer proof is requested separately.
    equal(checks, "generic Answer instruction remains A", input.latest_instruction, kind === "answer" ? initial : text);
    equal(checks, "frontend does not rewrite event classification", input.events[1].kind, message(1, text, kind).kind);
    return { material: input, result };
  });
});

type Frame = { at: number; brief: LiveSessionBrief; material: NamingMaterial; cache_events: NamingMaterial["events"]; raw_records?: unknown[] };
const seed = JSON.parse(readFileSync("tests/fixtures/auto_naming_reader_parity.json", "utf8")) as { schema: string; frames: Frame[] };
const readers = ["live-cached", "live-native", "transcript"] as const;
type Reader = typeof readers[number];
function reset(): void {
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} }); useLiveBriefStore.getState().reset();
  useAutoNameRuntimeStore.setState({ meanings: new Map(), descriptions: new Map(), recovery: null, revision: 0, invalidatedTabs: new Map(), invalidatedWorkspaces: new Map() });
  useSettingsStore.setState({ autoPaneNamingEnabled: true, autoWorkspaceNamingEnabled: true }); useAiSettingsStore.setState({ aiEnabled: false });
  useLauncherDirsStore.setState({ view: null }); fake.invoke.mockReset();
}
function immutable(ws: Workspace): unknown {
  const { name: _name, nameSource: _source, panes, ...rest } = ws;
  return { ...rest, panes: panes.map(({ tabs, ...pane }) => ({ ...pane, tabs: tabs.map(tab => {
    if (tab.labelSource === "user") return tab;
    const { displayName: _display, displayNameSource: _displaySource, ...fields } = tab; return fields;
  }) })) };
}
// Replay retains all intermediate writer states. Assertions stay outside isolated listeners.
async function replay(id: string, reader: Reader, frames: Frame[], schedule: number[], checks: Check[], coreControl = true): Promise<unknown> {
  reset(); vi.setSystemTime(2_000_000);
  const tab = makeTab(id + "-0"), ws = makeWorkspace([tab, makeTab(id + "-manual", { label: "手動の名前", labelSource: "user" })], id);
  ws.createdAt = 2_000_000; useWorkspaceListStore.setState({ workspaces: [ws], activeWorkspaceId: id });
  const baseline = structuredClone(immutable(ws)), states: Array<{ at: number; workspace: Workspace }> = [];
  let at = 0, delivered: Frame | undefined, observedKey = "", accepted = A, pending: { name: string; readyAt: number } | undefined;
  let controlObservedAt: number | undefined, workspaceCommittedAt: number | undefined;
  const deliveries: unknown[] = [], snapshots: unknown[] = [], expectedByTime = new Map<number, { pane: string; workspace: string }>();
  const unsubscribe = useWorkspaceListStore.subscribe(state => { states.push({ at, workspace: structuredClone(state.workspaces[0]) }); });
  const frameAt = () => [...frames].reverse().find(f => f.at <= at)!;
  fake.invoke.mockImplementation(async (command: string, args: { requests: Array<{ tab_id: string }> }) => {
    if (command === "get_pty_metadata_snapshot") return Object.fromEntries(ws.panes[0].tabs.map(t => [t.sessionId, { process_status: "working" }]));
    if (command === "get_session_output_snapshot") return {};
    if (command === "auto_name_materials") return args.requests.map(request => {
      if (request.tab_id !== tab.id) return { ...materialFor(ws.panes[0].tabs[1]), ...request };
      delivered = frameAt(); deliveries.push({ at, rawFrameAt: delivered.at });
      return { ...structuredClone(delivered.material), tab_id: tab.id, pty_session_id: tab.sessionId, agent_session_id: tab.agentSessionId,
        agent_kind: tab.agentKind, cwd: tab.cwd };
    });
    throw new Error("Unexpected IPC " + command);
  });
  const scheduler = createAutoPaneNamingScheduler();
  try {
    for (at of schedule) {
      vi.setSystemTime(2_000_000 + at);
      if (reader !== "transcript") {
        const frame = frameAt(), brief = { ...structuredClone(frame.brief), ptySessionId: tab.sessionId, agentSessionId: tab.agentSessionId!, updatedAt: Date.now() };
        useLiveBriefStore.setState({ briefsBySession: { [tab.sessionId]: brief }, eventsBySession: { [tab.sessionId]: reader === "live-cached" ? structuredClone(frame.cache_events) : [] } });
      }
      await scheduler.runNow();
      const observed = reader === "live-cached" ? frameAt() : delivered!;
      const latestUser = observed.cache_events.filter(e => e.kind.type === "userMessage").at(-1);
      const key = JSON.stringify([latestUser?.eventId, latestUser?.kind]);
      if (key !== observedKey) {
        observedKey = key;
        const latest = latestUser?.kind;
        const next = latest?.type === "userMessage" && latest.kind !== "answer" && latest.kind !== "ack" && latest.text === initial ? A
          : latest?.type === "userMessage" && latest.kind !== "answer" && latest.kind !== "ack" && latest.text === direct ? B : UNKNOWN;
        if (next === UNKNOWN && controlObservedAt === undefined) controlObservedAt = at;
        pending = next === accepted ? undefined : pending?.name === next ? pending : { name: next, readyAt: at + 10_000 };
      }
      if (pending && at >= pending.readyAt) { accepted = pending.name; pending = undefined; }
      const current = useWorkspaceListStore.getState().workspaces[0];
      // The first actual successful A patch establishes the workspace cooldown.
      if (workspaceCommittedAt === undefined && states.some(s => s.workspace.name === A + "・ほか1")) workspaceCommittedAt = at;
      const deadline = controlObservedAt === undefined ? Infinity : Math.max(controlObservedAt + 10_000 + 120_000, (workspaceCommittedAt ?? 30_000) + 300_000);
      const expectedWorkspace = at < 30_000 ? ws.name : at < deadline ? A + "・ほか1" : UNKNOWN;
      expectedByTime.set(at, { pane: accepted, workspace: expectedWorkspace });
      const meanings = useAutoNameRuntimeStore.getState().meanings, summary = aggregateWorkspaceName(current, meanings);
      const pane = getTabDisplayFullLabel(current.panes[0].tabs[0]), short = getTabDisplayLabel(current.panes[0].tabs[0]);
      equal(checks, "pane snapshot/full at " + at, pane, accepted); equal(checks, "pane snapshot/short at " + at, short, accepted);
      if (coreControl) equal(checks, "workspace snapshot after its independent deadline at " + at, current.name, expectedWorkspace);
      const known = accepted !== UNKNOWN, m = meanings.get(tab.id);
      equal(checks, "current target/action at " + at, known ? [m?.target, m?.action] : m?.strength, known ? accepted === A ? ["動画", "編集"] : ["解説スライド", "制作"] : "unknown");
      equal(checks, "workspace concrete topic at " + at, known ? m?.topic : m?.topic ?? "", known ? accepted : "");
      equal(checks, "workspace job count at " + at, summary.jobs, 2); equal(checks, "workspace unknown count at " + at, summary.unknown, known ? 1 : 2);
      const description = known ? `${accepted} 1件: ${accepted}\n${UNKNOWN} 1件` : `${UNKNOWN} 2件`;
      equal(checks, "workspace description counts/topics at " + at, summary.description, description);
      snapshots.push({ at, observedFrameAt: observed.at, pane, short, workspace: current.name, summary, meanings: [...meanings],
        controlObservedAt, workspaceCommittedAt, workspaceDeadline: Number.isFinite(deadline) ? deadline : null, expected: expectedByTime.get(at) });
    }
    let prior = ws;
    for (const state of states) {
      equal(checks, "every write preserves all non-name workspace/pane fields", immutable(state.workspace), baseline);
      const expected = expectedByTime.get(state.at)!;
      const t = state.workspace.panes[0].tabs[0], old = prior.panes[0].tabs[0];
      if (t.displayName !== old.displayName || t.displayNameSource !== old.displayNameSource) {
        equal(checks, "every pane write/full at " + state.at, getTabDisplayFullLabel(t), expected.pane);
        equal(checks, "every pane write/short at " + state.at, getTabDisplayLabel(t), expected.pane);
        equal(checks, "every pane write provenance", t.displayNameSource, "auto");
      }
      if (state.workspace.name !== prior.name || state.workspace.nameSource !== prior.nameSource) {
        if (coreControl) equal(checks, "every workspace write/topic at " + state.at, state.workspace.name, expected.workspace);
        equal(checks, "every workspace write provenance", state.workspace.nameSource, "auto");
      }
      prior = state.workspace;
    }
    equal(checks, "allowed IPC only", fake.invoke.mock.calls.every(([command]) => ["get_pty_metadata_snapshot", "get_session_output_snapshot", "auto_name_materials"].includes(command)), true);
    return { frames, deliveries, snapshots, writes: states, controlObservedAt, workspaceCommittedAt };
  } finally { scheduler.stop(); unsubscribe(); clearNamingHolds([id], ws.panes[0].tabs.map(t => t.id)); vi.clearAllTimers(); }
}

it("K1 G3 replay: every write and workspace topic obey the reader's own observation deadline", async () => {
  expect(seed.schema).toBe("B12-reader-parity-seed-v1");
  const inputs = readers.flatMap(reader => [60_000, 90_000, 150_000].flatMap(change => [0, 1_000, 5_000, 9_000, 15_000, 60_000].flatMap(gap => [false, true].map(observed => ({ reader, change, gap, observed })))));
  await cases("G3-reader-writes", inputs, async ({ reader, change, gap, observed }, checks) => {
    const frames = [structuredClone(seed.frames[0]), ...(observed && gap ? [{ ...structuredClone(seed.frames[1]), at: change }] : []), { ...structuredClone(seed.frames[2]), at: change + gap }];
    // Synthetic wire proof over the untouched raw seed; real Rust proof has its own 507-case check below.
    for (const frame of frames) { frame.material = fixtureMaterial({...frame.material, events: frame.cache_events}); frame.brief.namingPlan = frame.material.naming_plan; }
    const schedule = [...new Set([0, 30_000, change, change + gap, change + 10_000, change + gap + 10_000,
      ...[60_000, 120_000, 180_000, 240_000, 300_000, 360_000, 420_000, 480_000].flatMap(at => [at, at + 10_000]), 330_000])].sort((a, b) => a - b);
    return replay(`core-g3-${reader}-${change}-${gap}-${observed}`, reader, frames, schedule, checks);
  });
}, 60_000);

it.runIf(!!process.env.K2_NATIVE_RECORDING)("K2 real selection: native and cache consume the same 507 proofs", async () => {
  const recording = JSON.parse(readFileSync(process.env.K2_NATIVE_RECORDING!, "utf8")) as {product_head: string; cases: Array<{id: string; frames: Frame[]}>};
  expect(recording.product_head).toBe(process.env.K2_SOURCE_SHA); expect(recording.cases).toHaveLength(507);
  await cases("K2-real-selection", recording.cases, (c, checks) => c.frames.map(frame => {
    const tab = scanTab(makeTab(c.id + "-0")), cached = plannedNamingMaterial(tab, frame.brief.namingPlan, frame.cache_events)!;
    const native = buildAutoNameEvidence(tab, frame.material), cache = buildAutoNameEvidence(tab, cached);
    equal(checks, "same allocations, markers, losses and evidence", cache, native);
    equal(checks, "same selector proof", cached.naming_plan, frame.material.naming_plan);
    const user = [...frame.cache_events].reverse().find(e => e.kind.type === "userMessage")!;
    equal(checks, "latest input ID before omission", native.latestInput?.eventId, user.eventId);
    equal(checks, "scalar bound", native.instructions.reduce((n, v) => n + Array.from(v).length, 0) <= 1600, true);
    const kind = user.kind.type === "userMessage" ? user.kind.kind : undefined;
    if (kind === "answer" || kind === "ack") equal(checks, "all reply markers block old instructions", deriveAutoName(native).fullName, UNKNOWN);
    if (frame.at === 0) equal(checks, "complete initial direct instruction", deriveAutoName(native).fullName, A);
    if (frame.at === 170_000) equal(checks, "complete later direct D recovers", deriveAutoName(native).fullName, B);
    return {at: frame.at, native, cache};
  }));
}, 60_000);

function concrete(tab: PaneTab, target: string, action: string, fresh: boolean): AutoNameMeaning {
  return { target, action, topic: target + action, fullName: target + action, shortCandidates: [target + action], evidenceRefs: [],
    strength: "strong", binding: namingBinding(tab), contentKey: target + action, meaningKey: target + "|" + action, fresh };
}
it("K3 pane core: controls cancel pending work and lost markers cannot revive activity or older input", async () => {
  const inputs = ["続きをお願いします", "そのまま続けてください", "引き続きお願いします", "進捗はどうですか", "状況を教えてください", "いつ終わりそうですか"]
    .flatMap(control => ["missing", "old-activity", "new-activity"].map(loss => ({control, loss})));
  await cases("K3-pane-watermark", inputs, ({control, loss}, checks) => {
    const h = policyHarness(), m = h.materials.get("t")!;
    m.events = [message(0, initial)]; equal(checks, "initial direct A", h.run(0).get("t")?.displayName, A);
    m.events.push(message(1, direct)); h.run(60_000);
    m.events.push(message(2, control)); h.run(65_000);
    equal(checks, "unknown gets its own ten second deadline", h.policy.nextCheckMs(), 10_000);
    h.run(65_001); equal(checks, "reread does not restart deadline", h.policy.nextCheckMs(), 9_999);
    equal(checks, "control cancels positive B", h.run(75_000).get("t")?.displayName, UNKNOWN);
    m.events = loss === "missing" ? [] : [envelope(3, {type: "agentMessage", text: loss === "old-activity" ? initial : direct})];
    for (const at of [90_000, 120_000, 240_000]) equal(checks, "lost marker cannot be healed at " + at, h.run(at).get("t")?.displayName, UNKNOWN);
    m.events = [message(0, initial)]; h.run(250_000);
    equal(checks, "older direct input cannot cross watermark", h.run(260_000).get("t")?.displayName, UNKNOWN);
    m.events = [message(4, direct)]; h.run(300_000);
    equal(checks, "later complete direct input recovers", h.run(310_000).get("t")?.displayName, B);
    for (const write of h.writes.filter(w => w.at >= 75_000 && w.at < 300_000)) equal(checks, "every invalidated pane write", write.name, UNKNOWN);
    return {writes: h.writes, meaning: h.policy.meanings().get("t")};
  });
  await cases("K3-pane-owner-watermark", ["id", "higher-order-id", "reread", "read-loss", "binding", "reset", "prune"], (mode, checks) => {
    const h = policyHarness(), m = h.materials.get("t")!, tab = h.tabs[0];
    m.events = [message(0, initial)]; h.run(0);
    m.events.push(message(1, "続きをお願いします")); h.run(60_000);
    equal(checks, "control retires A", h.run(70_000).get("t")?.displayName, UNKNOWN);
    if (mode.endsWith("id")) {
      m.events = [message(0, initial), ...(mode === "higher-order-id" ? [{...envelope(0, {type: "agentMessage", text: "50%"}), eventId: "noise"}] : []),
        {...message(1, initial), eventId: "different-input-at-same-position"}];
    } else if (mode === "read-loss") h.materials.delete("t");
    else if (mode !== "reread") {
      if (mode === "binding") { tab.agentSessionId = "new-owner"; m.agent_session_id = tab.agentSessionId; }
      else if (mode === "reset") h.policy.reset([tab.id]);
      else { h.workspace.panes[0].tabs = []; h.run(80_000); h.workspace.panes[0].tabs = [tab]; }
      m.events = [message(0, initial)];
    }
    h.run(90_000); const expected = ["binding", "reset", "prune"].includes(mode) ? A : UNKNOWN;
    equal(checks, "same-position identity and owner boundary", h.run(100_000).get("t")?.displayName, expected);
    equal(checks, "stable rereads release the deadline", h.policy.nextCheckMs(), undefined);
    if (mode === "reread") { m.events = [message(2, direct)]; h.run(120_000); h.run(130_000); equal(checks, "same complete direct input remains concrete", h.run(140_000).get("t")?.displayName, B); }
    return {mode, writes: h.writes, meaning: h.policy.meanings().get("t")};
  });
});
it("K3 pane core: file and heading do not invent work and only the latest complete activity is weak evidence", async () => {
  await cases("K3-pane-sources", ["file", "heading", "unparsed-latest", "clipped-latest", "weak"], (source, checks) => {
    const tab = scanTab(makeTab("t")), material = materialFor(tab);
    if (source === "file") material.events = [envelope(0, {type: "toolStart", tool: "Write", call_id: "w", target: "lesson.pptx"})];
    else if (source === "heading") material.task_title = initial;
    else material.events = [envelope(0, {type: "agentMessage", text: "字幕位置を調整しています"}),
      ...(source === "weak" ? [] : [envelope(1, {type: "agentMessage", text: source === "clipped-latest" ? "あ".repeat(301) : "50%"})])];
    const next = deriveAutoName(buildAutoNameEvidence(tab, fixtureMaterial(material)));
    equal(checks, "literal pane oracle", [next.fullName, next.strength], source === "weak" ? ["字幕位置調整", "weak"] : [UNKNOWN, "unknown"]);
    const h = policyHarness([makeTab("t", {displayName: A, displayNameSource: "auto"})]);
    equal(checks, "saved automatic text has no current proof", h.run(0).get("t")?.displayName, UNKNOWN);
    return {source, meaning: next, savedWrites: h.writes};
  });
});
it("K3 pane core: every existing action keeps its concrete target", async () => {
  await cases("K3-pane-concrete-actions", ["スライド", "動画", "字幕", "解答", "受付"].flatMap(head => actions.map(action => ({head, action}))), ({head, action}, checks) => {
    const target = "授業" + head, tab = scanTab(makeTab("t"));
    const next = deriveAutoName(buildAutoNameEvidence(tab, materialFor(tab, target + "を" + action + "する")));
    equal(checks, "target and action remain concrete", [next.target, next.action, next.topic, next.fullName], [target, action, target + action, target + action]);
    return next;
  });
});
it("K1 G3 support: a positive held replacement retires A without upgrading its half vote", async () => {
  const inputs = [0, 1, 2].flatMap(unknown => ["none", "fresh", "held"].flatMap(survivor => [false, true].map(child => ({ unknown, survivor, child }))));
  await cases("G3-positive-held-support", inputs, ({ unknown, survivor, child }, checks) => {
    const t = makeTab("t"), tabs = [t, ...(child ? [makeTab("child", { origin: { kind: "agent", parentTabId: "t" } })] : []),
      ...(survivor === "none" ? [] : [makeTab("survivor")]), ...Array.from({ length: unknown }, (_, i) => makeTab("unknown" + i, { labelSource: i ? "launch" : "user" }))];
    const ws = makeWorkspace(tabs); let at = 0; const policy = createAutoWorkspaceNamePolicy(() => at);
    const map = new Map(tabs.slice(0, child ? 2 : 1).map(tab => [tab.id, concrete(tab, "動画", "編集", true)]));
    if (survivor !== "none") map.set("survivor", concrete(tabs.find(t => t.id === "survivor")!, "日付表示", "修正", survivor === "fresh"));
    const old = aggregateWorkspaceName(ws, map); policy.candidate(ws, old); at = 30_000;
    const name = policy.candidate(ws, old); equal(checks, "A was actually committed", !!name, true); ws.name = name!;
    const committed: (id: string, summary: WorkspaceNameSummary) => void = policy.committed;
    committed(ws.id, old); const writes = [{ at, name: ws.name }];
    for (const tab of tabs.slice(0, child ? 2 : 1)) map.set(tab.id, concrete(tab, "解説スライド", "制作", false));
    const expectedTopics = survivor === "none" ? [B] : [B, "日付表示修正"];
    let summary = aggregateWorkspaceName(ws, map);
    for (at of [60_000, 90_000, 180_000, 329_999, 330_000, 360_000]) {
      summary = aggregateWorkspaceName(ws, map); const next = policy.candidate(ws, summary);
      if (next) { ws.name = next; committed(ws.id, summary); writes.push({ at, name: next }); }
      if (at < 330_000) equal(checks, "cooldown retains previous display at " + at, ws.name, name);
    }
    const topics = ws.name.split("・").filter(part => !/^ほか\d+$/.test(part));
    equal(checks, "all visible topics match current independent jobs", topics.sort(), expectedTopics.sort());
    equal(checks, "remainder counts unknown owners", ws.name.match(/ほか(\d+)$/)?.[1] ?? "0", String(unknown));
    equal(checks, "parent/child one vote", summary.jobs, 1 + (survivor === "none" ? 0 : 1) + unknown);
    equal(checks, "unknown count", summary.unknown, unknown); equal(checks, "held replacement stays held", map.get(t.id)?.fresh, false);
    equal(checks, "description retains concrete job", summary.description.includes(B + " 1件: " + B), true);
    equal(checks, "description retires video job", summary.description.includes(A), false);
    for (const write of writes.filter(w => w.at >= 330_000)) equal(checks, "every supported workspace write", write.name.split("・").filter(p => !/^ほか\d+$/.test(p)).sort(), expectedTopics.sort());
    return { summary, writes, meanings: [...map] };
  });
  await cases("G3-half-vote-dominance", [0], (_input, checks) => {
    const tabs = Array.from({ length: 5 }, (_, i) => makeTab("weight" + i));
    const map = new Map(tabs.map((tab, i) => [tab.id, i < 2 ? concrete(tab, "解説スライド", "制作", false) : concrete(tab, "参加者名簿", "集計", true)]));
    const summary = aggregateWorkspaceName(makeWorkspace(tabs), map);
    equal(checks, "3 / (3 + 2*0.5) >= .7 and (3 + 2*0.5)/5 = .8", summary.name, "参加者名簿集計・ほか1");
    equal(checks, "held owners were not upgraded", [...map.values()].filter(m => !m.fresh).length, 2);
    equal(checks, "five independent jobs", summary.jobs, 5); return summary;
  });
});

it.runIf(!!process.env.K1_NATIVE_RECORDING)("K1 G1 real recording: adapter output obeys the independent latest-input oracle", async () => {
  const recording = JSON.parse(readFileSync(process.env.K1_NATIVE_RECORDING!, "utf8")) as { schema: string; product_head: string; cases: Array<{ id: string; reader: Reader; frames: Frame[] }> };
  expect(recording.schema).toBe("K1-core-native-v1"); expect(recording.product_head).toBe(process.env.K1_PRODUCT_SHA);
  expect(recording.cases).toHaveLength(507);
  await cases("G1-real-adapter-replay", recording.cases, (c, checks) => replay(c.id, c.reader, c.frames,
    [0, 30_000, 60_000, 65_000, 70_000, 75_000, 120_000, 130_000, 170_000, 180_000, 240_000, 360_000, 420_000, 480_000], checks, false));
}, 60_000);
