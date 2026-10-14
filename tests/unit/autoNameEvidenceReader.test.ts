import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { useLiveBriefStore } from "../../src/stores/liveBriefStore";
import { cachedNamingMaterial, liveNamingMaterialSignature, namingScanStillCurrent, readAutoNameScan, buildAutoNameEvidence } from "../../src/lib/autoNameEvidence";
import type { LiveSessionBrief, SemanticEventEnvelope } from "../../src/lib/livebrief";
import type { GroupingScan } from "../../src/components/layout/tabGrouping";
import { deriveAutoName, UNKNOWN_AUTO_NAME } from "../../src/lib/autoNamePolicy";
import { fixtureMaterial } from "./helpers/autoNamingInvariants";
import { namingPlanKey, plannedNamingMaterial } from "../../src/lib/autoNameMaterial";
const fake = vi.hoisted(() => ({ invoke: vi.fn(), scan: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: fake.invoke }));
// These cases count transcript-material reads; session titles have their own cache and tests.
vi.mock("../../src/lib/sessionTitles", () => ({ TITLED_AGENT_KINDS: ["claude", "claude-codex"], withSessionTitles: async (scan: unknown) => scan }));
vi.mock("../../src/components/layout/tabGrouping", () => ({ scanGroupingContext: fake.scan }));
const tab = { id: "t", sessionId: "pty", workspaceId: "w", paneId: "p", label: "", agentKind: "codex", agentSessionId: "agent", cwd: "/sample", tail: [] } as GroupingScan["tabs"][number];
const event = (eventId: string, kind: SemanticEventEnvelope["kind"]): SemanticEventEnvelope => ({ eventId, kind, sourceRevision: 1, occurredAt: 1, sourceByteStart: 0, sourceByteEnd: 1 });
const planFor = (events: SemanticEventEnvelope[]) => fixtureMaterial({tab_id: "t", pty_session_id: "pty", agent_kind: "codex", agent_session_id: "agent", cwd: "/sample", events}).naming_plan!;
const instruction = (text: string) => event("new-user", {type: "userMessage", kind: "taskChange", text, digest: "fixture"});
const brief = (overrides: Partial<LiveSessionBrief> = {}): LiveSessionBrief => ({ ptySessionId: "pty", agentSessionId: "agent", agentKind: "codex", telemetryHealth: "live", updatedAt: Date.now(),
  latestInstruction: "機材費の見積を作る", taskSourceEventIds: ["new-user"], namingSourceEventIds: ["new-user"],
  namingPlan: planFor([instruction(overrides.latestInstruction ?? "機材費の見積を作る")]),
  checkpointEvidenceEventIds: ["new-write"], activitySourceEventId: null, ...overrides } as LiveSessionBrief);
function scan(tabs: typeof tab[], status = "running") {
  return { tabs, workspaces: [{ id: "w", status }], scannedAt: 0, baseline: [], workspaceIds: ["w"], lineageClusters: [] } as unknown as GroupingScan;
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10000); fake.invoke.mockReset().mockResolvedValue([]); fake.scan.mockReset(); useLiveBriefStore.getState().reset(); });
afterEach(() => { vi.useRealTimers(); });
it("uses only event IDs referenced by the current brief, never an old agent detail cache", () => {
  useLiveBriefStore.setState({ briefsBySession: { pty: brief() }, eventsBySession: { pty: [event("old-user", { type: "userMessage", kind: "taskStart", text: "動画を編集する", digest: "old" })] },
    listEventsBySession: { pty: [event("new-write", { type: "toolStart", tool: "Write", call_id: "w", target: "costs.xlsx" })] } });
  const material = cachedNamingMaterial(tab); expect(material).toBeUndefined();
  expect(buildAutoNameEvidence(tab, material).instructions).toEqual([]);
  expect(deriveAutoName(buildAutoNameEvidence(tab, material)).fullName).toBe(UNKNOWN_AUTO_NAME);
  expect(cachedNamingMaterial({ ...tab, agentSessionId: "replacement" })).toBeUndefined();
});
it("ignores event sequence and heartbeat changes, but detects a changed current instruction", () => {
  const state = useLiveBriefStore.getState(); state.applyBrief(brief({ briefRevision: 1, serviceEpoch: "epoch" }));
  const previous = liveNamingMaterialSignature(useLiveBriefStore.getState());
  state.applyBrief(brief({ briefRevision: 2, serviceEpoch: "epoch", checkpoint: "50%", eventSeq: 10 }));
  expect(liveNamingMaterialSignature(useLiveBriefStore.getState())).toBe(previous);
  state.applyBrief(brief({ briefRevision: 3, serviceEpoch: "epoch", latestInstruction: "日付表示を修正する" }));
  expect(liveNamingMaterialSignature(useLiveBriefStore.getState())).not.toBe(previous);
});
it("rejects a result after the same agent's current instruction changes during a read", () => {
  useLiveBriefStore.setState({ briefsBySession: { pty: brief() }, eventsBySession: {pty: [instruction("機材費の見積を作る")]} });
  const material = cachedNamingMaterial(tab)!;
  const scanned = { ...scan([tab]), naming: new Map([[tab.id, buildAutoNameEvidence(tab, material)]]) };
  expect(namingScanStillCurrent(scanned, tab)).toBe(true);
  useLiveBriefStore.setState({ briefsBySession: { pty: brief({ latestInstruction: "字幕位置を直す" }) }, eventsBySession: {pty: [instruction("字幕位置を直す")]} });
  expect(namingScanStillCurrent(scanned, tab)).toBe(false);
});
it("throttles failed raw reads for sixty seconds", async () => {
  fake.scan.mockResolvedValue(scan([{ ...tab, id: "failed", sessionId: "failed-pty" }])); fake.invoke.mockRejectedValue(new Error("unavailable"));
  await readAutoNameScan(); vi.setSystemTime(40000); await readAutoNameScan(); expect(fake.invoke).toHaveBeenCalledTimes(1);
  vi.setSystemTime(70000); await readAutoNameScan(); expect(fake.invoke).toHaveBeenCalledTimes(2);
});
it("bounds each IPC batch to sixty-four and never reads stopped workspaces", async () => {
  fake.scan.mockResolvedValue(scan(Array.from({ length: 130 }, (_, i) => ({ ...tab, id: "batch-" + i, sessionId: "pty-" + i }))));
  await readAutoNameScan(); expect(fake.invoke.mock.calls.map(call => call[1].requests.length)).toEqual([64, 64, 2]);
  fake.invoke.mockClear(); fake.scan.mockResolvedValue(scan([{ ...tab, id: "stopped" }], "stopped"));
  const stopped = await readAutoNameScan(); expect(stopped.tabs).toHaveLength(0); expect(fake.invoke).not.toHaveBeenCalled();
});

it("B11 F3: current naming references include answers without changing the generic instruction", async () => {
  const task = { ...event("task", { type: "userMessage", kind: "taskStart", text: "動画を編集する", digest: "task" }), sourceByteStart: 0 };
  const answer = { ...event("answer", { type: "userMessage", kind: "answer", text: "動画を編集してはいけません", digest: "answer" }), sourceByteStart: 100 };
  useLiveBriefStore.setState({ briefsBySession: { pty: brief({ latestInstruction: "動画を編集する", taskSourceEventIds: ["task"], namingSourceEventIds: ["task", "answer"], namingPlan: planFor([task, answer]) }) },
    listEventsBySession: { pty: [task, answer] } });
  const cached = cachedNamingMaterial(tab)!;
  expect(cached.latest_instruction).toBe("動画を編集してはいけません");
  expect(useLiveBriefStore.getState().briefsBySession.pty.latestInstruction).toBe("動画を編集する");
  expect(buildAutoNameEvidence(tab, cached).instructions[0]).toBe("動画を編集してはいけません");
  expect(deriveAutoName(buildAutoNameEvidence(tab, cached)).fullName).toBe(UNKNOWN_AUTO_NAME);
  fake.scan.mockResolvedValue(scan([tab]));
  const read = await readAutoNameScan(); expect(read.naming.get(tab.id)?.instructions[0]).toBe(answer.kind.type === "userMessage" ? answer.kind.text : "");
  expect(fake.invoke).not.toHaveBeenCalled();
});

it("B11 F3: missing current answer events use the native naming path and invalidate in-flight or stale cache results", async () => {
  const current = { ...tab, id: "missing-answer", sessionId: "missing-answer-pty" };
  let instruction = "動画を編集してはいけません";
  const answerEvents = (last: string) => [event("task", {type: "userMessage", kind: "taskStart", text: "動画を編集する", digest: "task"}),
    {...event(last, {type: "userMessage", kind: "answer", text: instruction, digest: "answer"}), sourceByteStart: 100, sourceByteEnd: 200}];
  const setBrief = (last: string) => useLiveBriefStore.setState({ briefsBySession: { [current.sessionId]: brief({ ptySessionId: current.sessionId,
    latestInstruction: "動画を編集する", taskSourceEventIds: ["task"], namingSourceEventIds: ["task", last], namingPlan: planFor(answerEvents(last)) }) } });
  setBrief("answer"); expect(cachedNamingMaterial(current)).toBeUndefined();
  fake.scan.mockResolvedValue(scan([current]));
  fake.invoke.mockImplementation(async (_command, args) => args.requests.map((request: object) => fixtureMaterial({ ...request,
    events: answerEvents(useLiveBriefStore.getState().briefsBySession[current.sessionId].namingPlan!.latestInput!.eventId) } as Parameters<typeof fixtureMaterial>[0])));
  const scanned = await readAutoNameScan();
  expect(fake.invoke).toHaveBeenCalledTimes(1);
  expect(deriveAutoName(scanned.naming.get(current.id)!).strength).toBe("unknown");
  expect(namingScanStillCurrent(scanned, current)).toBe(true);
  const signature = liveNamingMaterialSignature(useLiveBriefStore.getState());
  instruction = "解説スライドを作る"; setBrief("new-answer");
  expect(namingScanStillCurrent(scanned, current)).toBe(false);
  expect(liveNamingMaterialSignature(useLiveBriefStore.getState())).not.toBe(signature);
  const refreshed = await readAutoNameScan(); expect(fake.invoke).toHaveBeenCalledTimes(2);
  expect(refreshed.naming.get(current.id)?.instructions).toEqual([instruction, "動画を編集する"]);
  expect(deriveAutoName(refreshed.naming.get(current.id)!).fullName).toBe(UNKNOWN_AUTO_NAME);
  await readAutoNameScan(); expect(fake.invoke).toHaveBeenCalledTimes(2);
});

it.each(["unavailable", "stale", "future", "wrong-agent", "wrong-pty", "heartbeat"])("B12: %s references cannot bypass the failed fallback interval", async mode => {
  const current = { ...tab, id: "b12-" + mode, sessionId: "b12-pty-" + mode };
  const original = brief({ ptySessionId: current.sessionId, serviceEpoch: "epoch", namingSourceEventIds: ["task"] });
  useLiveBriefStore.setState({ briefsBySession: { [current.sessionId]: original } });
  fake.scan.mockResolvedValue(scan([current])); fake.invoke.mockRejectedValue(new Error("unavailable"));
  await readAutoNameScan(); expect(fake.invoke).toHaveBeenCalledTimes(1);
  vi.setSystemTime(11000);
  const changed = { ...original, updatedAt: Date.now(), namingSourceEventIds: ["task", "control"] };
  if (mode === "unavailable") changed.telemetryHealth = "unavailable";
  if (mode === "stale") changed.updatedAt = Date.now() - 60_000;
  if (mode === "future") changed.updatedAt = Date.now() + 1;
  if (mode === "wrong-agent") changed.agentSessionId = "another-agent";
  if (mode === "wrong-pty") changed.ptySessionId = "another-pty";
  if (mode === "heartbeat") changed.namingSourceEventIds = [...(original.namingSourceEventIds ?? [])];
  useLiveBriefStore.setState({ briefsBySession: { [current.sessionId]: changed } });
  const scanned = await readAutoNameScan();
  expect(fake.invoke).toHaveBeenCalledTimes(1);
  expect(scanned.naming.get(current.id)?.instructions).toEqual([]);
});

it("B11 F3: a generic task outside the current answer history is not a new affirmation", () => {
  const answers = ["A", "動画", "はい", "了解"].map((text, i) => ({ ...event("answer-" + i, { type: "userMessage", kind: "answer", text, digest: String(i) }), sourceByteStart: 100 + i }));
  const old = event("old-task", {type: "userMessage", kind: "taskStart", text: "動画を編集する", digest: "old"});
  useLiveBriefStore.setState({ briefsBySession: { pty: brief({ latestInstruction: "動画を編集する", taskSourceEventIds: ["old-task"], namingSourceEventIds: answers.map(e => e.eventId), namingPlan: planFor([old, ...answers]) }) },
    listEventsBySession: { pty: answers } });
  const material = cachedNamingMaterial(tab)!;
  expect(material.latest_instruction).toBe("了解");
  expect(buildAutoNameEvidence(tab, material).instructions).toEqual(["了解", "はい", "動画", "A"]);
  expect(material.naming_plan?.coverage.countLoss).toBe(1);
  expect(buildAutoNameEvidence(tab, material).replyOnly).toBe(true);
});

it("K2: native allocations count equal text by ID and reject missing or altered cache bodies", () => {
  const a = instruction("動画を編集する"), b = {...a, eventId: "second", sourceByteStart: 100, sourceByteEnd: 200};
  const plan = planFor([a, b]), native = fixtureMaterial({tab_id: "t", pty_session_id: "pty", agent_kind: "codex", agent_session_id: "agent", cwd: "/sample", events: [a, b]});
  const cached = plannedNamingMaterial(tab, plan, [a, b, event("extra", {type: "agentMessage", text: "無関係"})])!;
  expect(buildAutoNameEvidence(tab, cached)).toEqual(buildAutoNameEvidence(tab, native));
  expect(buildAutoNameEvidence(tab, cached).instructions).toEqual(["動画を編集する", "動画を編集する"]);
  expect(cached.events.map(e => e.eventId)).toEqual(["new-user"]); expect(cached.latest_instruction_event_id).toBe("second");
  expect(plannedNamingMaterial(tab, plan, [b])).toBeUndefined();
  expect(plannedNamingMaterial(tab, plan, [a, {...b, kind: {...b.kind, text: "別の仕事"} as typeof b.kind}])).toBeUndefined();
  expect(namingPlanKey({...plan, coverage: {...plan.coverage, readEnd: 999}})).toEqual(namingPlanKey(plan));
  expect(deriveAutoName(buildAutoNameEvidence(tab, {...native, naming_plan: undefined, instruction_history_complete: true})).fullName).toBe(UNKNOWN_AUTO_NAME);
});

it("K2: coverage changes bypass only a healthy new source; offsets and same-source failures keep the interval", async () => {
  const current = {...tab, id: "coverage", sessionId: "coverage-pty"}, original = brief({ptySessionId: "coverage-pty"});
  fake.scan.mockResolvedValue(scan([current])); fake.invoke.mockRejectedValue(new Error("unavailable"));
  useLiveBriefStore.setState({briefsBySession: {[current.sessionId]: original}}); await readAutoNameScan();
  vi.setSystemTime(11000); original.namingPlan!.coverage.readEnd += 100; original.updatedAt = Date.now(); await readAutoNameScan();
  expect(fake.invoke).toHaveBeenCalledTimes(1);
  original.namingPlan!.coverage.countLoss = 1; await readAutoNameScan(); expect(fake.invoke).toHaveBeenCalledTimes(2);
  await readAutoNameScan(); expect(fake.invoke).toHaveBeenCalledTimes(2);
});
