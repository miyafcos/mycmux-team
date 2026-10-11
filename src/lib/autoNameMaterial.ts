import type { GroupingScan } from "../components/layout/tabGrouping";
import type { NamingPlan, NamingAllocation, SemanticEventEnvelope, UserMessageKind } from "./livebrief";
import { sha256Hex } from "./persistentLayoutProjection";
import { interpretNamingText, isNamingAck, namingTextKey, substantiveInstruction } from "./autoNameLanguage";

export interface NamingMaterial {
  tab_id: string; pty_session_id: string; agent_session_id?: string | null;
  agent_kind: string; cwd: string; latest_instruction?: string | null;
  task_title?: string | null; events: SemanticEventEnvelope[];
  latest_instruction_complete?: boolean; latest_instruction_kind?: UserMessageKind | null;
  latest_instruction_event_id?: string | null; latest_instruction_byte_start?: number | null;
  incomplete_event_ids?: string[]; task_title_complete?: boolean;
  instruction_history_complete?: boolean; naming_plan?: NamingPlan | null;
}
export interface AutoNameEvidence {
  id: string; workspaceId: string; binding: string; contentKey: string;
  instructions: string[]; activity: string[];
  instructionCompleteness?: boolean[]; instructionPositions?: Array<number | undefined>;
  activityCompleteness?: boolean[]; taskTitleComplete?: boolean; replyOnly?: boolean;
  instructionHistoryComplete?: boolean; latestInput?: NamingPlan["latestInput"];
  files: { name: string; operation: "read" | "write"; ref: string }[];
  taskTitle: string; cwd: string; evidenceRefs: string[];
}
export interface AutoNameScan extends GroupingScan { naming: Map<string, AutoNameEvidence>; namingSourceKeys?: Map<string, string> }
const take = (text: string, cap: number) => Array.from(text).slice(0, cap).join("");
const text = (value: string | null | undefined) => (value ?? "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim();
export const namingBinding = (tab: { id: string; sessionId: string; agentKind?: string; agentSessionId?: string; cwd?: string }) => JSON.stringify([tab.id, tab.sessionId, tab.agentKind ?? "", tab.agentSessionId, tab.cwd ?? ""]);
export function namingPlanKey(plan?: NamingPlan | null): unknown {
  if (!validNamingPlan(plan)) return null;
  const { readStart: _start, readEnd: _end, ...coverage } = plan.coverage;
  return { ...plan, coverage };
}
export function validNamingPlan(plan?: NamingPlan | null): plan is NamingPlan {
  if (!plan?.coverage || typeof plan.coverage.sourceUnknown !== "boolean" || !Array.isArray(plan.entries) || plan.entries.length > 24) return false;
  const rows = plan.entries;
  return [plan.coverage.countLoss, plan.coverage.characterLoss].every(v => v === null || (Number.isSafeInteger(v) && v! >= 0))
    && "latestInput" in plan && "latestAgent" in plan
    && (!plan.latestInput ? !rows.some(e => e.role === "user") : typeof plan.latestInput.complete === "boolean" && typeof plan.latestInput.choice === "boolean"
      && ["taskStart", "taskChange", "correction", "answer", "ack"].includes(plan.latestInput.kind)
      && rows.filter(e => e.role === "user").every(e => e.order <= plan.latestInput!.order))
    && new Set(rows.map(e => e.eventId)).size === rows.length
    && rows.every(e => typeof e.complete === "boolean" && Number.isSafeInteger(e.order) && Number.isSafeInteger(e.chars) && e.chars > 0
      && e.chars <= ({user: 1600, agent: 300, read: 80, write: 80}[e.role] ?? 0))
    && rows.filter(e => e.role === "user").length <= 4 && rows.filter(e => e.role !== "user").length <= 20
    && rows.filter(e => e.role === "agent").length <= 2 && rows.filter(e => e.role === "read" || e.role === "write").length <= 8
    && ["user", "agent", "file"].every(role => rows.filter(e => role === "file" ? e.role === "read" || e.role === "write" : e.role === role)
      .reduce((sum, e) => sum + e.chars, 0) <= ({user: 1600, agent: 600, file: 640}[role] ?? 0));
}
function plannedField(event: SemanticEventEnvelope): { role: NamingAllocation["role"]; value: string } | undefined {
  const kind = event.kind;
  if (kind.type === "userMessage") return { role: "user", value: kind.text };
  if (kind.type === "agentMessage") return { role: "agent", value: kind.text };
  const path = kind.type === "fileChange" ? kind.path
    : (kind.type === "toolStart" || kind.type === "toolEnd") && /^(read|edit|write)$/i.test(kind.tool) ? kind.target : null;
  if (!path) return undefined;
  return { role: kind.type === "fileChange" || ((kind.type === "toolStart" || kind.type === "toolEnd") && /^(edit|write)$/i.test(kind.tool)) ? "write" : "read",
    value: path.split(/[\\/]/).pop() ?? "" };
}
/** Consume native allocations; never select generic task refs or extra cache history. */
export function plannedNamingMaterial(tab: GroupingScan["tabs"][number], plan: NamingPlan | null | undefined, raw: SemanticEventEnvelope[]): NamingMaterial | undefined {
  if (!validNamingPlan(plan)) return undefined;
  const events: SemanticEventEnvelope[] = [];
  for (const entry of plan.entries) {
    const event = raw.find(e => e.eventId === entry.eventId), field = event && plannedField(event);
    if (!event || !field || field.role !== entry.role || event.sourceRevision !== entry.sourceRevision
      || event.sourceByteStart !== entry.sourceByteStart || event.sourceByteEnd !== entry.sourceByteEnd || sha256Hex(field.value) !== entry.hash) return undefined;
    if (entry.eventId === plan.latestInput?.eventId && (event.kind.type !== "userMessage" || event.kind.kind !== plan.latestInput.kind)) return undefined;
    const value = take(field.value, entry.chars), kind = { ...event.kind };
    if (kind.type === "userMessage" || kind.type === "agentMessage") kind.text = value;
    else if (kind.type === "fileChange") kind.path = value;
    else if (kind.type === "toolStart" || kind.type === "toolEnd") { kind.target = value; if (kind.type === "toolEnd") kind.summary = null; }
    events.push({ ...event, kind });
  }
  const mark = plan.latestInput, latestIndex = events.findIndex(e => e.eventId === mark?.eventId);
  const latest = latestIndex < 0 ? undefined : events.splice(latestIndex, 1)[0];
  return { tab_id: tab.id, pty_session_id: tab.sessionId, agent_session_id: tab.agentSessionId,
    agent_kind: tab.agentKind, cwd: tab.cwd, events, naming_plan: plan,
    latest_instruction: latest?.kind.type === "userMessage" ? latest.kind.text : null,
    latest_instruction_kind: mark?.kind, latest_instruction_event_id: mark?.eventId, latest_instruction_byte_start: mark?.sourceByteStart,
    latest_instruction_complete: !!mark?.complete, instruction_history_complete: !plan.coverage.sourceUnknown && plan.coverage.countLoss === null && plan.coverage.characterLoss === null,
    incomplete_event_ids: plan.entries.filter(e => !e.complete).map(e => e.eventId), task_title_complete: true };
}
export function buildAutoNameEvidence(tab: GroupingScan["tabs"][number], material?: NamingMaterial): AutoNameEvidence {
  const matching = material?.tab_id === tab.id && material.pty_session_id === tab.sessionId
    && (material.agent_session_id ?? undefined) === tab.agentSessionId && material.agent_kind === tab.agentKind && material.cwd === tab.cwd;
  const plan = matching && validNamingPlan(material.naming_plan) ? material.naming_plan : undefined;
  const incomplete = new Set(matching ? material.incomplete_event_ids : []);
  const instructions: string[] = [], activity: string[] = [], instructionCompleteness: boolean[] = [], activityCompleteness: boolean[] = [];
  const instructionPositions: Array<number | undefined> = [], files: AutoNameEvidence["files"] = [], evidenceRefs: string[] = [];
  let present = !!plan, remaining = 3000;
  for (const entry of [...(plan?.entries ?? [])].reverse()) {
    const event = material?.events.find(e => e.eventId === entry.eventId);
    const field = entry.eventId === material?.latest_instruction_event_id && material.latest_instruction != null
      ? {role: "user" as const, value: material.latest_instruction} : event && plannedField(event);
    if (!field || field.role !== entry.role || Array.from(field.value).length !== entry.chars
      || (entry.complete && sha256Hex(field.value) !== entry.hash)) { present = false; continue; }
    const value = text(field.value); remaining -= entry.chars; evidenceRefs.push(entry.eventId);
    if (entry.role === "user") {
      const complete = entry.complete && !incomplete.has(entry.eventId) && (entry.eventId !== material?.latest_instruction_event_id || material.latest_instruction_complete !== false);
      const answer = (event?.kind.type === "userMessage" && event.kind.kind === "answer") || (entry.eventId === plan?.latestInput?.eventId && plan.latestInput.kind === "answer");
      instructions.push(complete && !answer ? substantiveInstruction(value) : value);
      instructionCompleteness.push(complete); instructionPositions.push(entry.sourceByteStart);
    } else if (entry.role === "agent") {
      // Retain the second body as auxiliary evidence, without upgrading it to current activity.
      activity.push(value); activityCompleteness.push(entry.complete && entry.eventId === plan?.latestAgent?.eventId);
    } else files.push({name: value, operation: entry.role, ref: entry.eventId});
  }
  const mark = plan?.latestInput && {...plan.latestInput, complete: plan.latestInput.complete && material?.latest_instruction_complete !== false && !incomplete.has(plan.latestInput.eventId)};
  const current = mark && plan?.entries.find(e => e.eventId === mark.eventId);
  const currentText = current ? instructions[0] : undefined;
  const direct = currentText && mark?.complete && mark.kind !== "answer" && mark.kind !== "ack" && !mark.choice ? interpretNamingText(currentText) : undefined;
  const losses = plan ? [plan.coverage.countLoss, plan.coverage.characterLoss].filter((v): v is number => v !== null) : [];
  const recovered = !!direct?.chosen && !direct.ambiguous && losses.every(end => end <= mark!.sourceByteStart);
  const replyOnly = !!mark?.complete && (mark.kind === "answer" || mark.kind === "ack" || mark.choice || isNamingAck(text(material?.latest_instruction)));
  const instructionHistoryComplete = present && !plan?.coverage.sourceUnknown && (!losses.length || recovered)
    && (material?.instruction_history_complete !== false || recovered) && (!mark || (!!mark.complete && (mark.kind === "ack" || !!current))) && !replyOnly;
  const rawTaskTitle = text(matching ? material.task_title : tab.taskTitle), taskTitle = take(rawTaskTitle, Math.min(160, remaining));
  const taskTitleComplete = !rawTaskTitle || (material?.task_title_complete !== false && Array.from(rawTaskTitle).length === Array.from(taskTitle).length);
  remaining -= Array.from(taskTitle).length;
  const cwd = take(tab.cwd.split(/[\\/]/).filter(part => !/^([A-Za-z]:|users?|home|src|\d{6,8}|[A-Za-z0-9_-]+)$/i.test(part)).slice(-3).join("/"), Math.min(160, remaining));
  const binding = namingBinding(tab);
  const activityKey = activity.filter((value, index) => { const meaning = interpretNamingText(value); return activityCompleteness[index] && meaning.chosen && !meaning.ambiguous && !meaning.rejected.length; }).map(namingTextKey).filter(Boolean);
  const contentKey = JSON.stringify([binding, instructions.map((value, i) => instructionCompleteness[i] ? namingTextKey(value) : "incomplete"),
    activityKey, files.map(({name, operation}) => [name, operation]), taskTitleComplete ? namingTextKey(taskTitle) : "incomplete",
    mark, plan && [plan.coverage.sourceUnknown, plan.coverage.countLoss, plan.coverage.characterLoss], instructionHistoryComplete, "rules-v5"]);
  return {id: tab.id, workspaceId: tab.workspaceId, binding, contentKey, instructions, instructionCompleteness, instructionPositions,
    activity, activityCompleteness, files, taskTitle, taskTitleComplete, replyOnly, latestInput: mark, instructionHistoryComplete, cwd, evidenceRefs};
}
