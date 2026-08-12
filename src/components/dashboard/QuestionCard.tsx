import { useMemo } from "react";
import type { CSSProperties, MouseEvent } from "react";

import { targetKey, type LiveSessionBrief, type SemanticEventEnvelope } from "../../lib/livebrief";
import { dashboardStrings } from "./dashboardStrings";
import {
  chooseOption,
  interventionResultText,
  isInterventionConflict,
  questionModel,
  useInterventionFeedbackStore,
} from "./interventionRouting";

/** 番号キー (1/2/3) で撃てる上限。これを超えたらヒントを出さない。 */
const NUMBER_KEY_LIMIT = 3;

/**
 * 「エージェントが今なにを聞いているか」と、その場で答えるボタン。
 * 一覧行 (compact) と詳細フッタ (フル) の両方で同じものを出す。
 * 送信そのものは interventionRouting へ寄せてあり、キーボード経路と同一。
 */
export function QuestionCard({ brief, events, targetLabel, onFocusComposer, compact = false }: {
  brief: LiveSessionBrief | undefined;
  events: readonly SemanticEventEnvelope[] | undefined;
  targetLabel: string;
  onFocusComposer: () => void;
  compact?: boolean;
}) {
  const model = useMemo(() => questionModel(brief, events), [brief, events]);
  const key = brief ? targetKey(brief) : null;
  const inFlight = useInterventionFeedbackStore((state) => (key ? state.inFlightByTarget[key] ?? false : false));
  const result = useInterventionFeedbackStore((state) => (key ? state.resultByTarget[key] : undefined));

  if (!model) return null;
  const disabled = inFlight || !model.canSend;
  const resultText = result ? interventionResultText(result) : null;
  // 一覧行の行クリック (選択) は通してよいが、ボタンの連打が dblclick になって
  // ペインへ飛ぶのは事故なので、ボタン側でバブリングを止める。
  const stop = (event: MouseEvent) => event.stopPropagation();

  return <section
    data-livebrief-interactive="true"
    style={compact ? compactCardStyle : cardStyle}
    onDoubleClick={stop}
  >
    {compact ? null : <div style={headerStyle}>
      <strong>{dashboardStrings.liveBriefQuestionLabel}</strong>
      <span style={targetStyle}>{targetLabel}</span>
    </div>}
    <div style={promptStyle}>{model.prompt}</div>
    {model.options.length ? <div style={optionsStyle}>
      {model.options.map((option, index) => <button
        key={option.id}
        type="button"
        disabled={disabled}
        style={{ ...optionButtonStyle, opacity: disabled ? 0.55 : 1 }}
        // blur しておかないとフォーカスがボタンに残り、DashboardView の
        // キーボード操作 (1/2/3・j/k) が「入力中」と見なされて効かなくなる。
        onClick={(event) => { stop(event); event.currentTarget.blur(); void chooseOption(brief, option.id); }}
      >
        <span style={badgeStyle}>{index + 1}</span>
        <span style={optionLabelStyle}>{option.label}</span>
      </button>)}
    </div> : null}
    {compact ? null : <div style={footerRowStyle}>
      <button
        type="button"
        disabled={inFlight}
        style={{ ...otherButtonStyle, opacity: inFlight ? 0.55 : 1 }}
        onClick={(event) => { stop(event); onFocusComposer(); }}
      >{dashboardStrings.otherFreeText}</button>
      {model.options.length && model.options.length <= NUMBER_KEY_LIMIT
        ? <span style={hintStyle}>{dashboardStrings.numberKeyHint}</span>
        : null}
    </div>}
    {resultText
      ? <div style={{ ...resultStyle, color: isInterventionConflict(result) ? "var(--status-error)" : "var(--cmux-text-secondary)" }}>{resultText}</div>
      : null}
  </section>;
}

const cardStyle: CSSProperties = {
  // 詳細フッタでは縦フレックスの末尾に置くので、タイムライン側に潰されないようにする。
  flex: "0 0 auto",
  display: "grid",
  gap: 6,
  padding: 9,
  border: "1px solid color-mix(in srgb, var(--status-waiting) 55%, transparent)",
  borderRadius: "var(--cmux-radius-lg)",
  background: "color-mix(in srgb, var(--status-waiting) 8%, transparent)",
  fontSize: "var(--cmux-font-size-sm)",
};
const compactCardStyle: CSSProperties = {
  ...cardStyle,
  gap: 5,
  padding: "7px 8px",
  marginTop: 4,
};
const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  minWidth: 0,
  color: "var(--cmux-text-secondary)",
};
const targetStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  textAlign: "right",
  color: "var(--cmux-text-tertiary)",
  fontSize: "var(--cmux-font-size-xs)",
};
const promptStyle: CSSProperties = { minWidth: 0, overflowWrap: "anywhere", color: "var(--cmux-text)" };
const optionsStyle: CSSProperties = { display: "grid", gap: 4 };
const optionButtonStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  minWidth: 0,
  textAlign: "left",
  background: "color-mix(in srgb, var(--status-waiting) 10%, var(--cmux-surface))",
  border: "1px solid color-mix(in srgb, var(--status-waiting) 30%, transparent)",
  borderRadius: 7,
  color: "var(--cmux-text)",
  cursor: "pointer",
  fontSize: "var(--cmux-font-size-sm)",
  padding: "6px 9px",
};
/** 選択肢番号。数字1文字だけのバッジなので 10px を許す。 */
const badgeStyle: CSSProperties = {
  flex: "0 0 auto",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 17,
  height: 17,
  border: "1px solid color-mix(in srgb, var(--status-waiting) 40%, transparent)",
  borderRadius: "var(--cmux-radius-sm)",
  color: "var(--status-waiting)",
  fontFamily: "var(--cmux-font-mono)",
  fontSize: 10,
};
const optionLabelStyle: CSSProperties = { minWidth: 0, overflowWrap: "anywhere" };
const footerRowStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 8, minWidth: 0 };
const otherButtonStyle: CSSProperties = {
  background: "transparent",
  border: "1px dashed var(--cmux-border)",
  borderRadius: "var(--cmux-radius-md)",
  color: "var(--cmux-text-secondary)",
  cursor: "pointer",
  fontSize: "var(--cmux-font-size-sm)",
  padding: "5px 9px",
};
const hintStyle: CSSProperties = {
  marginLeft: "auto",
  color: "var(--cmux-text-tertiary)",
  fontSize: "var(--cmux-font-size-xs)",
};
const resultStyle: CSSProperties = { minWidth: 0, overflowWrap: "anywhere", fontSize: "var(--cmux-font-size-xs)" };
