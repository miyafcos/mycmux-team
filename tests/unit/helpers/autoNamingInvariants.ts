import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { performance as wallClock } from "node:perf_hooks";
import { expect } from "vitest";
import { buildAutoNameEvidence, plannedNamingMaterial, type AutoNameScan, type NamingMaterial } from "../../../src/lib/autoNameMaterial";
import { sha256Hex } from "../../../src/lib/persistentLayoutProjection";
import type { NamingAllocation, NamingPlan, SemanticEventEnvelope } from "../../../src/lib/livebrief";
import { createAutoNamePolicy, type NamingProject } from "../../../src/lib/autoNamePolicy";
import type { PaneTab, Workspace } from "../../../src/types";

export const targets = ["動画", "字幕位置", "解説スライド"];
// The existing public action vocabulary, copied as test inputs rather than derived from the parser.
export const actions = ["制作", "修正", "校正", "調整", "調査", "比較", "編集", "確認", "集計", "送付", "見積"];
export const endings = [
  { text: "する", positive: true }, { text: "してください", positive: true }, { text: "している", positive: true },
  { text: "しない", positive: false }, { text: "しません", positive: false }, { text: "してはいけません", positive: false },
  { text: "する必要はありません", positive: false }, { text: "しないでください", positive: false },
  { text: "するのをやめてください", positive: false }, { text: "は不要です", positive: false },
];
export const punctuation = ["", "。", "！", "!"];
export function product<T>(...dimensions: readonly T[][]): T[][] {
  return dimensions.reduce<T[][]>((rows, values) => rows.flatMap(row => values.map(value => [...row, value])), [[]]);
}
export const tasks = [
  { target: "動画", action: "編集", request: "動画を編集する", name: "動画編集" },
  { target: "解説スライド", action: "制作", request: "解説スライドを制作する", name: "解説スライド制作" },
  { target: "参加者名簿", action: "集計", request: "参加者名簿を集計する", name: "参加者名簿集計" },
];
export const nextFamilies = [
  { kind: "status", keep: true, texts: ["進捗はどうですか", "状況を教えてください", "いつ終わりそうですか"] },
  { kind: "continuation", keep: true, texts: ["続きをお願いします", "そのまま続けてください", "引き続きお願いします"] },
  { kind: "known", keep: false, texts: ["字幕位置を修正する", "授業資料を送付する", "出席表を集計する"] },
  { kind: "unknown", keep: false, texts: ["次は会議を予約してください", "次は設備を点検してください", "配送便を手配してください"] },
  { kind: "replacement", keep: false, texts: ["会議を予約してください", "設備を点検してください", "配送便を手配してください"] },
];
export function makeTab(id: string, extra: Partial<PaneTab> = {}): PaneTab {
  return { id, sessionId: "pty-" + id, agentId: "shell-starter", label: "runner-" + id, labelSource: "launch",
    agentKind: "claude", agentSessionId: "agent-" + id, cwd: "/fixture",
    initialPrompt: "original", commandArgv: ["claude", "--resume", id], launchEnv: { ORIGINAL: id }, ...extra };
}
export function makeWorkspace(tabs: PaneTab[], id = "w"): Workspace {
  return { id, name: "以前のワークスペース名", nameSource: "auto", status: "running", createdAt: 0, gridTemplateId: "1x1",
    splitColumns: [["p"]], panes: [{ id: "p", sessionId: "unused", agentId: "shell-starter", activeTabId: tabs[0]?.id ?? "", tabs }] };
}
export function envelope(index: number, kind: NamingMaterial["events"][number]["kind"]): NamingMaterial["events"][number] {
  return { eventId: "event-" + index, occurredAt: index, sourceRevision: index + 1, sourceByteStart: index * 100, sourceByteEnd: (index + 1) * 100, kind };
}
export const user = (index: number, text: string) => envelope(index, { type: "userMessage", kind: index ? "taskChange" : "taskStart", text, digest: String(index) });
export const write = (index: number, target: string) => envelope(index, { type: "toolStart", call_id: String(index), tool: "Write", target });
/** Explicitly complete synthetic source, only for unit fixtures, never native recordings. */
export function fixtureMaterial(input: NamingMaterial, occurrence?: number): NamingMaterial {
  const raw = [...input.events];
  let scalarOrder: number | undefined;
  if (!raw.some(e => e.kind.type === "userMessage") && input.latest_instruction) {
    const prior = input.naming_plan?.entries.find(e => e.eventId === input.latest_instruction_event_id && e.eventId === input.naming_plan?.latestInput?.eventId && e.role === "user"
      && e.sourceByteStart === input.latest_instruction_byte_start && e.hash === sha256Hex(input.latest_instruction!));
    const kept = occurrence === undefined ? prior : undefined, index = occurrence ?? 0;
    const event = { ...envelope(index, {type: "userMessage", kind: input.latest_instruction_kind ?? "taskChange", text: input.latest_instruction, digest: "fixture"}),
      eventId: kept?.eventId ?? (occurrence === undefined ? "fixture-" + sha256Hex(input.latest_instruction).slice(0, 16) : `fixture-${input.tab_id}-${index}`) };
    if (kept) Object.assign(event, {sourceRevision: kept.sourceRevision, sourceByteStart: kept.sourceByteStart, sourceByteEnd: kept.sourceByteEnd});
    scalarOrder = kept?.order ?? index + 1;
    raw.push(event);
  }
  const latest = [...raw].reverse().find(e => e.kind.type === "userMessage"), users = raw.filter(e => e.kind.type === "userMessage" && e.kind.kind !== "ack");
  const descriptor = (event: SemanticEventEnvelope): NamingAllocation => {
    const k = event.kind, role = k.type === "userMessage" ? "user" : k.type === "agentMessage" ? "agent" : k.type === "toolStart" || k.type === "toolEnd" ? (/^read$/i.test(k.tool) ? "read" : "write") : "write";
    const value = k.type === "userMessage" || k.type === "agentMessage" ? k.text : k.type === "fileChange" ? k.path : k.type === "toolStart" || k.type === "toolEnd" ? k.target ?? "" : "";
    const field = role === "read" || role === "write" ? value.split(/[\\/]/).pop() ?? "" : value;
    return {eventId: event.eventId, order: event === latest ? scalarOrder ?? raw.indexOf(event) + 1 : raw.indexOf(event) + 1, sourceRevision: event.sourceRevision, sourceByteStart: event.sourceByteStart,
      sourceByteEnd: event.sourceByteEnd, role, chars: Array.from(field).length, hash: sha256Hex(field), complete: true};
  };
  const lastAgent = [...raw].reverse().find(e => e.kind.type === "agentMessage");
  const plan: NamingPlan = {latestInput: latest?.kind.type === "userMessage" ? {eventId: latest.eventId, order: scalarOrder ?? raw.indexOf(latest) + 1,
    sourceByteStart: latest.sourceByteStart, sourceByteEnd: latest.sourceByteEnd, kind: latest.kind.kind,
    choice: scalarOrder !== undefined && occurrence === undefined ? input.naming_plan?.latestInput?.choice ?? false : false, complete: latest.kind.kind === "ack"} : null,
    latestAgent: lastAgent ? descriptor(lastAgent) : null, entries: [], coverage: {readStart: 0, readEnd: raw.at(-1)?.sourceByteEnd ?? 0,
      sourceUnknown: false, countLoss: users.length > 4 ? Math.max(...users.slice(0, -4).map(e => e.sourceByteEnd)) : null, characterLoss: null}};
  let userBudget = 1600, agentBudget = 600, agents = 0; const files = new Set<string>();
  const others = raw.filter(e => e.kind.type !== "userMessage").slice(-20).reverse();
  for (const event of [...users.slice(-4).reverse(), ...others]) {
    const k = event.kind;
    if (k.type !== "userMessage" && k.type !== "agentMessage" && k.type !== "fileChange" && !((k.type === "toolStart" || k.type === "toolEnd") && /^(read|edit|write)$/i.test(k.tool) && k.target)) continue;
    const entry = descriptor(event), rawChars = entry.chars;
    if (entry.role === "user") { entry.chars = Math.min(rawChars, userBudget); userBudget -= entry.chars; }
    else if (entry.role === "agent") { if (agents++ >= 2) continue; entry.chars = Math.min(rawChars, 300, agentBudget); agentBudget -= entry.chars; }
    else { const key = entry.role + entry.hash; if (files.size >= 8 || files.has(key)) continue; files.add(key); entry.chars = Math.min(rawChars, 80); }
    entry.complete = entry.chars === rawChars && !input.incomplete_event_ids?.includes(entry.eventId)
      && !(entry.eventId === latest?.eventId && input.latest_instruction_complete === false);
    if (entry.role === "user" && !entry.complete) plan.coverage.characterLoss = Math.max(plan.coverage.characterLoss ?? 0, entry.sourceByteEnd);
    if (entry.chars) plan.entries.push(entry);
  }
  plan.entries.sort((a, b) => a.order - b.order);
  if (plan.latestInput && plan.latestInput.kind !== "ack") plan.latestInput.complete = !!plan.entries.find(e => e.eventId === plan.latestInput?.eventId)?.complete;
  if (plan.latestAgent) plan.latestAgent.complete = !!plan.entries.find(e => e.eventId === plan.latestAgent?.eventId)?.complete;
  const tab = {id: input.tab_id, sessionId: input.pty_session_id, agentKind: input.agent_kind, agentSessionId: input.agent_session_id ?? undefined, cwd: input.cwd} as AutoNameScan["tabs"][number];
  return {...input, ...plannedNamingMaterial(tab, plan, raw), latest_instruction_complete: plan.latestInput ? plan.latestInput.complete : input.latest_instruction_complete ?? true,
    task_title: input.task_title, task_title_complete: input.task_title_complete};
}
export function materialFor(tab: PaneTab, instruction?: string, occurrence = 0): NamingMaterial {
  return fixtureMaterial({ tab_id: tab.id, pty_session_id: tab.sessionId, agent_kind: tab.agentKind ?? "", agent_session_id: tab.agentSessionId,
    cwd: tab.cwd ?? "", latest_instruction: instruction, events: [] }, occurrence);
}
export function fixtureEvents(material: NamingMaterial): SemanticEventEnvelope[] {
  const latest = material.naming_plan?.latestInput, entry = material.naming_plan?.entries.find(e => e.eventId === latest?.eventId);
  return !latest || !entry || material.latest_instruction == null ? material.events : [...material.events, {eventId: latest.eventId, sourceRevision: entry.sourceRevision,
    sourceByteStart: entry.sourceByteStart, sourceByteEnd: entry.sourceByteEnd, occurredAt: 0,
    kind: {type: "userMessage", kind: latest.kind, text: material.latest_instruction, digest: "fixture"}}].sort((a,b) => a.sourceByteStart-b.sourceByteStart);
}
/** Unit harness; reader/scheduler matrices use the production scan and stores instead. */
export function policyHarness(tabs = [makeTab("t")], projects: NamingProject[] = []) {
  let now = 0;
  const workspace = makeWorkspace(tabs);
  const materials = new Map(tabs.map(tab => [tab.id, materialFor(tab)]));
  const policy = createAutoNamePolicy(() => now, () => projects);
  const writes: Array<{ at: number; id: string; name: string }> = [];
  const run = (at: number) => {
    now = at;
    const scan: AutoNameScan = { scannedAt: at, workspaces: [workspace], workspaceIds: [workspace.id], baseline: [], lineageClusters: [],
      tabs: workspace.status === "running" ? workspace.panes[0].tabs.map(tab => ({
        id: tab.id, sessionId: tab.sessionId, label: tab.label ?? "", labelSource: tab.labelSource, displayName: tab.displayName,
        agentKind: tab.agentKind ?? "", agentSessionId: tab.agentSessionId, cwd: tab.cwd ?? "", taskTitle: "", workspaceId: workspace.id,
        workspaceName: workspace.name, paneId: "p", column: 1, lastOutputAt: null, tail: [],
      })) : [], naming: new Map() };
    for (const tab of scan.tabs) { const material = materials.get(tab.id); scan.naming.set(tab.id, buildAutoNameEvidence(tab, material && fixtureMaterial(material))); }
    const names = policy.identify(scan).tabs;
    for (const tab of workspace.panes[0].tabs) {
      const name = names.get(tab.id)?.displayName;
      if (name && name !== tab.displayName && tab.labelSource !== "user") {
        tab.displayName = name; tab.displayNameSource = "auto"; writes.push({ at, id: tab.id, name });
      }
    }
    return names;
  };
  return { policy, workspace, tabs, materials, run, writes };
}

interface MatrixResult { name: string; cases: number; failed: number; milliseconds: number; examples: string[] }
const results: MatrixResult[] = [];
export async function matrix<T>(name: string, cases: T[], check: (value: T, index: number) => void | Promise<void>) {
  const started = wallClock.now(); const failures: string[] = []; let failed = 0;
  for (const [index, value] of cases.entries()) {
    try { await check(value, index); }
    catch (error) { failed++; if (failures.length < 12) failures.push(JSON.stringify(value) + ": " + String(error)); }
  }
  results.push({ name, cases: cases.length, failed, milliseconds: wallClock.now() - started, examples: failures });
  expect.soft(failures, name + " failed " + failed + "/" + cases.length).toEqual([]);
}
export function writeMatrixReport(defaultPath: string, extra: unknown = undefined) {
  if (process.env.AUTO_NAMING_QUALITY_REPORT !== "1") return;
  const path = process.env.AUTO_NAMING_INVARIANT_REPORT_PATH ?? defaultPath;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ mode: "generated-invariants", modelCalls: 0, total: results.reduce((sum, row) => sum + row.cases, 0),
    failed: results.reduce((sum, row) => sum + row.failed, 0), matrices: results, extra }, null, 2) + "\n");
}
