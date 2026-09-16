import type { AttentionCard, PrimaryAction, Severity, Waiting } from "../../lib/attentionBridge";
import type { LiveSessionBrief } from "../../lib/livebrief";

const WAITING_PRIORITY: Record<Waiting, number> = { human: 0, work: 1, none: 2 };
const SEVERITY_PRIORITY: Record<Severity, number> = { blocking: 0, warning: 1, advisory: 2 };

export function sortAttentionCards(cards: readonly AttentionCard[]): AttentionCard[] {
  return [...cards].sort((left, right) => (
    WAITING_PRIORITY[left.waiting] - WAITING_PRIORITY[right.waiting]
    || SEVERITY_PRIORITY[left.severity] - SEVERITY_PRIORITY[right.severity]
    || left.firstSeenAt - right.firstSeenAt
    || (left.sourceRank ?? Number.MAX_SAFE_INTEGER) - (right.sourceRank ?? Number.MAX_SAFE_INTEGER)
    || left.id.localeCompare(right.id)
  ));
}

export function primaryActionLabel(action: PrimaryAction, label: (kind: PrimaryAction["type"]) => string): string {
  return label(action.type);
}

/** 無出力を事実として出す下限。これより短い経過は出さない。 */
export const ATTENTION_NO_UPDATE_MINUTES = 30;

export type AttentionFactKind = "pendingQuestion" | "queuedInput" | "noUpdate";

/** 一覧のカード 1 枚を、気づき欄が要る範囲だけに削いだもの。 */
export interface AttentionFactSource {
  sessionId: string;
  label: string;
  brief?: LiveSessionBrief;
  noUpdateMinutes: number | null;
  /** 入力欄に残ったままの本文 (stallStore の queued_input)。 */
  queuedInput?: string | null;
}

export interface AttentionFactCard {
  id: string;
  kind: AttentionFactKind;
  sessionId: string;
  label: string;
  prompt: string | null;
  options: string[];
  minutes: number | null;
  detail: string | null;
}

const FACT_PRIORITY: Record<AttentionFactKind, number> = {
  pendingQuestion: 0,
  queuedInput: 1,
  noUpdate: 2,
};

/** 複数行の値から、中身のある最初の 1 行だけを取る。 */
export function firstLine(value: string | null | undefined): string | null {
  if (!value) return null;
  for (const line of value.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/**
 * 観測できた事実だけをカードにする。どうするかの判定は載せない (通報をやめた
 * 2026-09-16 の裁定)。1 セッションにつき 1 枚で、質問 > 未送信 > 無出力 の順に採る。
 */
export function buildAttentionFactCards(sources: readonly AttentionFactSource[]): AttentionFactCard[] {
  const cards = sources.flatMap((source) => {
    const card = attentionFactCard(source);
    return card ? [card] : [];
  });
  return cards.sort((left, right) => (
    FACT_PRIORITY[left.kind] - FACT_PRIORITY[right.kind]
    || (right.minutes ?? 0) - (left.minutes ?? 0)
    || left.label.localeCompare(right.label)
    || left.sessionId.localeCompare(right.sessionId)
  ));
}

function attentionFactCard(source: AttentionFactSource): AttentionFactCard | null {
  const label = source.label.trim();
  // 対象のセッションを名指しできないカードは出さない。
  if (!source.sessionId || !label) return null;
  const minutes = typeof source.noUpdateMinutes === "number" && Number.isFinite(source.noUpdateMinutes)
    ? Math.max(0, Math.floor(source.noUpdateMinutes))
    : null;
  const base = { sessionId: source.sessionId, label, prompt: null, options: [] as string[], minutes, detail: null };

  const brief = source.brief;
  // 質問文を載せられない「質問中」は、読んでも何も分からないので出さない。
  const prompt = brief && brief.pendingInputKind !== null ? brief.pendingPrompt?.trim() || null : null;
  if (prompt) {
    return {
      ...base,
      id: `fact:question:${source.sessionId}`,
      kind: "pendingQuestion",
      prompt,
      options: (brief?.pendingOptions ?? [])
        .map((option) => option.label.trim())
        .filter((option) => option.length > 0),
    };
  }

  const queued = firstLine(source.queuedInput);
  if (queued) {
    return { ...base, id: `fact:queued:${source.sessionId}`, kind: "queuedInput", detail: queued };
  }

  if (minutes !== null && minutes >= ATTENTION_NO_UPDATE_MINUTES) {
    return {
      ...base,
      id: `fact:noupdate:${source.sessionId}`,
      kind: "noUpdate",
      detail: firstLine(brief?.activityText) ?? firstLine(brief?.checkpoint),
    };
  }

  return null;
}
