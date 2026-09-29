// 「その場で答える」(V2-B) の判定と送信を 1 か所に集める。
//
// 判定 (resolveComposerRoute / questionModel) は純関数で、React も副作用も持たない。
// 送信 (runIntervention) はカード側とキーボード (1/2/3) の両方から呼ばれるので、
// 状態 (in-flight / 直近の結果) ごとここへ置いて 1 本化している。
//
// 約束:
//   - fail-closed: promptEventId / promptHash が無い brief には送らない (freezeExpectation が null)
//   - 自動再送しない: conflict / busy / 未確認のいずれでもリトライを撃たない
//   - 送信結果で brief を書き換えない: brief の正本は livebrief 側 (liveBriefStore) だけ
import { create } from "zustand";

import {
  freezeExpectation,
  sendIntervention,
  targetKey,
  type InterventionAction,
  type InterventionResult,
  type LiveSessionBrief,
  type PendingInputKind,
  type PendingOption,
  type SemanticEventEnvelope,
} from "../../lib/livebrief";
import { dashboardStrings } from "./dashboardStrings";
import { unresolvedQuestion } from "./liveTimelineModel";

/** 送信できない理由。文言は dashboardStrings 側に持つ。 */
export type ComposerDisabledReason = "notStarted" | "webPane";

export type ComposerRoute =
  | { kind: "intervention" }
  | { kind: "paneSendText" }
  | { kind: "disabled"; reason: ComposerDisabledReason };

/**
 * コンポーザの送信経路。
 *   telemetry が live のときだけ「今どういう状態か」を断定でき、
 *   それ以外 (終了・未接続・読めない・brief 無し) は PTY があるなら素の入力へ落とす。
 */
export function resolveComposerRoute(
  brief: LiveSessionBrief | undefined,
  hasPty: boolean,
  isWebTab = false,
): ComposerRoute {
  // Web ペインには書き込む PTY が無い。打てるように見せて黙って捨てるより、
  // 理由を出して止める (入力はページ側で行う)。
  if (isWebTab) return { kind: "disabled", reason: "webPane" };
  if (brief && brief.telemetryHealth === "live") {
    if (brief.operationalState === "needsHuman") return { kind: "intervention" };
    // 作業中でも打てる: Claude Code / codex の TUI は稼働中の入力をキューに積む。
    // 送達は pane 側の検証つき送信が担保する (入力欄ごと殺すと「入力できない」体験になる)。
    return { kind: "paneSendText" };
  }
  if (!hasPty) return { kind: "disabled", reason: "notStarted" };
  return { kind: "paneSendText" };
}

export interface QuestionModel {
  prompt: string;
  kind: PendingInputKind;
  options: PendingOption[];
  /** 介入を撃てるか (freezeExpectation が期待値を作れるか) と同値。 */
  canSend: boolean;
}

/** freezeExpectation が非 null になる条件。UUID を作らずに同じ判定だけする。 */
export function canSendIntervention(brief: LiveSessionBrief | undefined): boolean {
  return Boolean(brief?.promptEventId && brief?.promptHash);
}

/**
 * 表示する質問。brief の pending* が正で、まだ載っていなければイベント列から拾う。
 * どちらにも質問が無ければ null (カードを出さない)。
 */
export function questionModel(
  brief: LiveSessionBrief | undefined,
  events: readonly SemanticEventEnvelope[] | undefined,
): QuestionModel | null {
  const canSend = canSendIntervention(brief);
  const prompt = brief?.pendingPrompt?.trim();
  if (prompt) {
    return {
      prompt,
      kind: brief?.pendingInputKind ?? "freeText",
      options: brief?.pendingOptions ?? [],
      canSend,
    };
  }
  const fallback = events?.length ? unresolvedQuestion(events) : null;
  if (!fallback) return null;
  return { prompt: fallback.prompt, kind: fallback.kind, options: fallback.options, canSend };
}

/** 介入結果の和文。7 種すべてに対応する (未知の型は未確認扱い)。 */
export function interventionResultText(result: InterventionResult): string {
  if (result.type === "confirmed") return dashboardStrings.interventionConfirmed;
  if (result.type === "conflict") return dashboardStrings.interventionConflict;
  if (result.type === "busy") return dashboardStrings.interventionBusy;
  if (result.type === "writtenAwaitingEvidence") return dashboardStrings.interventionWritten;
  if (result.type === "rejectedBeforeWrite") return dashboardStrings.interventionRejected(dashboardStrings.interventionReason(result.reason));
  if (result.type === "indeterminatePartial") return dashboardStrings.interventionIndeterminate;
  return dashboardStrings.interventionUnconfirmed;
}

/** 赤で出す結果 (対象が変わっていて送れていない)。 */
export function isInterventionConflict(result: InterventionResult | undefined): boolean {
  return result?.type === "conflict";
}

/** 送信できたと言える結果。ここでだけ下書きを消し、次の要対応へ進む。 */
export function isInterventionAccepted(result: InterventionResult | undefined): boolean {
  return result?.type === "confirmed" || result?.type === "writtenAwaitingEvidence";
}

interface InterventionFeedbackState {
  /** targetKey(brief) → 直近の結果。brief そのものは書き換えない。 */
  resultByTarget: Record<string, InterventionResult>;
  inFlightByTarget: Record<string, boolean>;
  setResult: (key: string, result: InterventionResult) => void;
  setInFlight: (key: string, inFlight: boolean) => void;
  reset: () => void;
}

export const useInterventionFeedbackStore = create<InterventionFeedbackState>((set) => ({
  resultByTarget: {},
  inFlightByTarget: {},
  setResult: (key, result) => set((state) => ({ resultByTarget: { ...state.resultByTarget, [key]: result } })),
  setInFlight: (key, inFlight) => set((state) => ({ inFlightByTarget: { ...state.inFlightByTarget, [key]: inFlight } })),
  reset: () => set({ resultByTarget: {}, inFlightByTarget: {} }),
}));

/**
 * 介入 1 回。カード (選択肢ボタン) ・コンポーザ (自由入力) ・キーボード (1/2/3) の
 * 共通入口。結果は targetKey 単位で覚えるだけで、brief には触らない。
 */
export async function runIntervention(
  brief: LiveSessionBrief | undefined,
  action: InterventionAction,
): Promise<InterventionResult> {
  if (!brief) return { type: "rejectedBeforeWrite", reason: "target_missing" };
  const key = targetKey(brief);
  const store = useInterventionFeedbackStore.getState();
  if (store.inFlightByTarget[key]) return { type: "busy" };
  const expectation = freezeExpectation(brief);
  if (!expectation) {
    const rejected: InterventionResult = { type: "rejectedBeforeWrite", reason: "target_missing" };
    store.setResult(key, rejected);
    return rejected;
  }
  store.setInFlight(key, true);
  try {
    const result = await sendIntervention(expectation, action);
    useInterventionFeedbackStore.getState().setResult(key, result);
    return result;
  } catch {
    // 送れたかどうかが分からない側へは倒さない。ここは「書く前に落ちた」だけ。
    const rejected: InterventionResult = { type: "rejectedBeforeWrite", reason: "transport" };
    useInterventionFeedbackStore.getState().setResult(key, rejected);
    return rejected;
  } finally {
    useInterventionFeedbackStore.getState().setInFlight(key, false);
  }
}

/** 選択肢 1 個を選ぶ。番号キーとカードのボタンで同じ経路を通す。 */
export function chooseOption(
  brief: LiveSessionBrief | undefined,
  optionId: string,
): Promise<InterventionResult> {
  return runIntervention(brief, { type: "choose", optionId });
}
