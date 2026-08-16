import type { QuestionAnswer, QuestionId } from "../components/ailog/questionModel";

export const AILOG_LAST_VISIT_STORAGE_KEY = "mycmux:ailog-last-visit";

export interface AilogLastVisit {
  lastVisitTs: number | null;
  readDigestDates: string[];
  lastAnswers: Partial<Record<QuestionId, QuestionAnswer>>;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const answers = new Set<QuestionAnswer>(["得している", "差がない", "損している", "まだ判断できない"]);
const questionIds = new Set<QuestionId>(["subagent", "effort", "length", "compaction", "model"]);
const emptyVisit = (): AilogLastVisit => ({ lastVisitTs: null, readDigestDates: [], lastAnswers: {} });

function browserStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function parse(raw: string | null): AilogLastVisit {
  if (!raw) return emptyVisit();
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return emptyVisit();
    const record = value as Record<string, unknown>;
    const lastVisitTs = typeof record.lastVisitTs === "number" && Number.isFinite(record.lastVisitTs) && record.lastVisitTs >= 0 ? record.lastVisitTs : null;
    const readDigestDates = Array.isArray(record.readDigestDates) ? [...new Set(record.readDigestDates.filter((date): date is string => typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)))] : [];
    const lastAnswers: AilogLastVisit["lastAnswers"] = {};
    if (record.lastAnswers && typeof record.lastAnswers === "object") {
      for (const [id, answer] of Object.entries(record.lastAnswers as Record<string, unknown>)) {
        if (questionIds.has(id as QuestionId) && typeof answer === "string" && answers.has(answer as QuestionAnswer)) lastAnswers[id as QuestionId] = answer as QuestionAnswer;
      }
    }
    return { lastVisitTs, readDigestDates, lastAnswers };
  } catch {
    return emptyVisit();
  }
}

export function readAilogLastVisit(storage: StorageLike | null = browserStorage()): AilogLastVisit {
  try {
    return parse(storage?.getItem(AILOG_LAST_VISIT_STORAGE_KEY) ?? null);
  } catch {
    return emptyVisit();
  }
}

export function writeAilogLastVisit(value: AilogLastVisit, storage: StorageLike | null = browserStorage()): void {
  try {
    storage?.setItem(AILOG_LAST_VISIT_STORAGE_KEY, JSON.stringify({ lastVisitTs: value.lastVisitTs, readDigestDates: [...new Set(value.readDigestDates)], lastAnswers: value.lastAnswers }));
  } catch {
    // Local storage is only a convenience for a renderer visit; failure is non-fatal.
  }
}

export function markAilogVisited(now = Date.now()): AilogLastVisit {
  const value = { ...readAilogLastVisit(), lastVisitTs: now };
  writeAilogLastVisit(value);
  return value;
}

export function markDigestRead(date: string): AilogLastVisit {
  const previous = readAilogLastVisit();
  const value = { ...previous, readDigestDates: [...new Set([...previous.readDigestDates, date])] };
  writeAilogLastVisit(value);
  return value;
}

export function saveQuestionAnswers(lastAnswers: Partial<Record<QuestionId, QuestionAnswer>>): AilogLastVisit {
  const previous = readAilogLastVisit();
  const value = { ...previous, lastAnswers };
  writeAilogLastVisit(value);
  return value;
}
