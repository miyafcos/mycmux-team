// LiveBrief のイベント列を「読める行」へ畳む純関数群。
// dashboardModel.ts と同じ約束: React も副作用も持たない。表示文言 (日本語) は
// 呼び出し側 (dashboardStrings) の責務なので、このファイルには置かない。
import type {
  LiveSessionBrief,
  PendingInputKind,
  PendingOption,
  SemanticEventEnvelope,
} from "../../lib/livebrief";

export type TimelineKind =
  | "instruction"
  | "agentText"
  | "tool"
  | "result"
  | "question"
  | "answer"
  | "error"
  | "test"
  | "file";

export interface TimelineRow {
  id: string;
  at: number;
  kind: TimelineKind;
  title: string;
  detail?: string;
  ok?: boolean;
  target?: string;
  /** 連続する同一 tool+target を畳んだ本数。1 のときは畳んでいない。 */
  count: number;
}

export interface ActivityChainItem {
  id: string;
  at: number;
  tool: string;
  target?: string;
  ok?: boolean;
  count: number;
}

export interface UnresolvedQuestion {
  id: string;
  at: number;
  promptEventId: string;
  prompt: string;
  kind: PendingInputKind;
  options: PendingOption[];
}

export const TIMELINE_ROW_LIMIT = 40;
export const ACTIVITY_CHAIN_LENGTH = 3;
const TEXT_LIMIT = 160;

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > TEXT_LIMIT ? `${flat.slice(0, TEXT_LIMIT)}…` : flat;
}

/** 畳んだ本数を表題へ焼く。畳む前の行は tool 名そのままを title に持つ。 */
function stampCount(row: TimelineRow): TimelineRow {
  return row.count > 1 ? { ...row, title: `${row.title} ×${row.count}` } : row;
}

/** toolStart に対応する toolEnd を突合して 1 行にする。未突合の toolEnd は単独行。 */
function pairToolCalls(events: readonly SemanticEventEnvelope[]): Map<string, SemanticEventEnvelope> {
  const ends = new Map<string, SemanticEventEnvelope>();
  const open = new Map<string, string>();
  for (const envelope of events) {
    if (envelope.kind.type === "toolStart") open.set(envelope.kind.call_id, envelope.eventId);
    else if (envelope.kind.type === "toolEnd") {
      const startId = open.get(envelope.kind.call_id);
      if (startId === undefined) continue;
      open.delete(envelope.kind.call_id);
      ends.set(startId, envelope);
    }
  }
  return ends;
}

function toRow(
  envelope: SemanticEventEnvelope,
  endByStartId: Map<string, SemanticEventEnvelope>,
  pairedEndIds: ReadonlySet<string>,
): TimelineRow | null {
  const base = { id: envelope.eventId, at: envelope.occurredAt, count: 1 };
  const event = envelope.kind;
  switch (event.type) {
    case "userMessage":
      return event.kind === "answer" || event.kind === "ack"
        ? { ...base, kind: "answer", title: clip(event.text) }
        : { ...base, kind: "instruction", title: clip(event.text) };
    case "agentMessage":
      return { ...base, kind: "agentText", title: clip(event.text) };
    case "toolStart": {
      const end = endByStartId.get(envelope.eventId);
      const summary = end && end.kind.type === "toolEnd" ? end.kind.summary : null;
      const ok = end && end.kind.type === "toolEnd" ? end.kind.ok : undefined;
      return {
        ...base,
        kind: "tool",
        title: event.tool,
        target: event.target ?? undefined,
        detail: summary ? clip(summary) : undefined,
        ok,
      };
    }
    case "toolEnd":
      if (pairedEndIds.has(envelope.eventId)) return null;
      return {
        ...base,
        kind: "result",
        title: event.tool,
        target: event.target ?? undefined,
        detail: event.summary ? clip(event.summary) : undefined,
        ok: event.ok,
      };
    case "question":
      return { ...base, kind: "question", title: clip(event.prompt) };
    case "questionResolved":
      return null;
    case "testResult":
      return { ...base, kind: "test", title: `${event.pass}/${event.fail}`, ok: event.fail === 0 };
    case "fileChange":
      return { ...base, kind: "file", title: event.path, detail: event.change };
    case "error":
      return { ...base, kind: "error", title: clip(event.text), ok: false };
    default:
      return null;
  }
}

/** 直前の行と同じ tool+target なら畳んで count を積む (title は素の tool 名のまま)。 */
function buildFoldedRows(events: readonly SemanticEventEnvelope[]): TimelineRow[] {
  const endByStartId = pairToolCalls(events);
  const pairedEndIds = new Set([...endByStartId.values()].map((envelope) => envelope.eventId));
  const folded: TimelineRow[] = [];
  for (const envelope of events) {
    const row = toRow(envelope, endByStartId, pairedEndIds);
    if (!row) continue;
    const previous = folded[folded.length - 1];
    if (previous && previous.kind === "tool" && row.kind === "tool" && previous.title === row.title && previous.target === row.target) {
      folded[folded.length - 1] = {
        ...previous,
        at: row.at,
        count: previous.count + 1,
        detail: row.detail ?? previous.detail,
        ok: row.ok ?? previous.ok,
      };
      continue;
    }
    folded.push(row);
  }
  return folded;
}

export function toTimelineRows(
  events: readonly SemanticEventEnvelope[],
  options: { limit?: number } = {},
): TimelineRow[] {
  const limit = Math.max(0, options.limit ?? TIMELINE_ROW_LIMIT);
  if (!events.length || limit === 0) return [];
  const folded = buildFoldedRows(events);
  return folded.slice(Math.max(0, folded.length - limit)).map(stampCount);
}

/** 直近 n 個のツール操作連鎖。表示文字列化は view 側の責務なので構造で返す。 */
export function toActivityChain(
  events: readonly SemanticEventEnvelope[],
  n: number = ACTIVITY_CHAIN_LENGTH,
): ActivityChainItem[] {
  if (n <= 0 || !events.length) return [];
  const toolRows = buildFoldedRows(events).filter((row) => row.kind === "tool" || row.kind === "result");
  return toolRows.slice(Math.max(0, toolRows.length - n)).map((row) => ({
    id: row.id,
    at: row.at,
    tool: row.title,
    target: row.target,
    ok: row.ok,
    count: row.count,
  }));
}

/** 直近の「指示」原文。answer / ack は指示を上書きしない。 */
export function latestInstruction(events: readonly SemanticEventEnvelope[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index].kind;
    if (event.type !== "userMessage") continue;
    if (event.kind === "answer" || event.kind === "ack") continue;
    const text = event.text.trim();
    if (text) return text;
  }
  return null;
}

/** QuestionResolved と突合して残っている質問。無ければ null。 */
export function unresolvedQuestion(events: readonly SemanticEventEnvelope[]): UnresolvedQuestion | null {
  const open = new Map<string, UnresolvedQuestion>();
  for (const envelope of events) {
    const event = envelope.kind;
    if (event.type === "question") {
      open.set(event.prompt_event_id, {
        id: envelope.eventId,
        at: envelope.occurredAt,
        promptEventId: event.prompt_event_id,
        prompt: event.prompt,
        kind: event.kind,
        options: event.options,
      });
    } else if (event.type === "questionResolved") {
      open.delete(event.prompt_event_id);
    }
  }
  const remaining = [...open.values()];
  return remaining.length ? remaining[remaining.length - 1] : null;
}

/** 最後に何かが起きてからの経過分。基準が無ければ null。 */
export function noUpdateMinutes(brief: LiveSessionBrief | undefined, nowMs: number): number | null {
  if (!brief) return null;
  const since = brief.lastEventAt ?? brief.lastSuccessfulReadAt ?? brief.updatedAt;
  if (!since) return null;
  return Math.max(0, Math.floor((nowMs - since) / 60_000));
}
