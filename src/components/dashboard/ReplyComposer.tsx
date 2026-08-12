import { useEffect, useState } from "react";
import type { CSSProperties, RefObject } from "react";

import { handleSocketCommand } from "../layout/socketCommands";
import { useLiveBriefStore } from "../../stores/liveBriefStore";
import { useDashboardViewStore } from "../../stores/dashboardViewStore";
import type { DashboardCardModel } from "./dashboardModel";
import { dashboardStrings } from "./dashboardStrings";
import {
  interventionResultText,
  isInterventionAccepted,
  isInterventionConflict,
  resolveComposerRoute,
  runIntervention,
} from "./interventionRouting";

/** pane.send_text (送達確認つき送信) の戻り。確認できたときだけ confirmed が true。 */
interface PaneSendTextOutcome {
  confirmed?: boolean;
  reason?: string;
}

interface ComposerNote {
  text: string;
  error: boolean;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 画面最下部に常設する入力欄。選択中のペインへ「その場で」返す。
 * 経路 (介入 / 素の入力 / 送れない) の判定は interventionRouting が持ち、
 * ここは下書きの保持と結果表示だけを受け持つ。
 */
export function ReplyComposer({ card, inputRef }: {
  card: DashboardCardModel | null;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const sessionId = card?.tab.sessionId ?? null;
  const brief = useLiveBriefStore((state) => (sessionId ? state.briefsBySession[sessionId] : undefined));
  const draft = useDashboardViewStore((state) => (sessionId ? state.draftBySession[sessionId] ?? "" : ""));
  const setDraft = useDashboardViewStore((state) => state.setDraft);
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<ComposerNote | null>(null);

  // 前のセッションの結果を次のセッションの欄に残さない。
  useEffect(() => { setNote(null); }, [sessionId]);

  const route = card ? resolveComposerRoute(brief, !card.neverStarted) : null;
  const blocked = !card || !route || route.kind === "disabled";
  const disabledNote = route?.kind === "disabled"
    ? (route.reason === "running" ? dashboardStrings.composerRunningDisabled : dashboardStrings.composerNotStarted)
    : null;
  const canSubmit = !blocked && !sending && Boolean(draft.trim());

  const submit = async () => {
    if (!card || !sessionId || !route || route.kind === "disabled" || sending || !draft.trim()) return;
    setSending(true);
    try {
      if (route.kind === "intervention") {
        const result = await runIntervention(brief, { type: "replyText", text: draft });
        setNote({ text: interventionResultText(result), error: isInterventionConflict(result) });
        // conflict / busy / 未確認では下書きを消さない (自動再送もしない)。
        if (isInterventionAccepted(result)) setDraft(sessionId, "");
        return;
      }
      const outcome = await handleSocketCommand("pane.send_text", {
        sessionId,
        text: draft,
        enter: true,
      }) as PaneSendTextOutcome | null;
      const confirmed = outcome?.confirmed === true;
      const reason = outcome?.reason;
      setNote({
        text: confirmed
          ? dashboardStrings.sendConfirmedOnScreen
          : `${dashboardStrings.sendUnverified}${reason ? ` (${reason})` : ""}`,
        error: false,
      });
      // 端末へは書けているので下書きは残さない (再送は人間の判断で)。
      setDraft(sessionId, "");
    } catch (error) {
      // handleSocketCommand が throw したときは書き込み自体が走っていない。
      setNote({ text: `${dashboardStrings.sendFailedBeforeWrite} (${errorText(error)})`, error: true });
    } finally {
      setSending(false);
    }
  };

  const noteText = disabledNote ?? note?.text ?? null;
  const noteIsError = disabledNote ? false : Boolean(note?.error);

  return <div data-livebrief-interactive="true" style={rootStyle}>
    <div style={rowStyle}>
      {card ? <span style={toStyle}>{dashboardStrings.composerTo(card.workspace.name, card.tabIndex + 1, `P${card.paneIndex + 1}`)}</span> : null}
      <textarea
        ref={inputRef}
        rows={1}
        value={draft}
        disabled={blocked || sending}
        aria-label={dashboardStrings.composerAriaLabel}
        placeholder={dashboardStrings.composerPlaceholder}
        onChange={(event) => { if (sessionId) setDraft(sessionId, event.target.value); }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key !== "Enter" || event.shiftKey) return;
          event.preventDefault();
          void submit();
        }}
        style={textareaStyle}
      />
      <button
        type="button"
        disabled={!canSubmit}
        style={{ ...sendButtonStyle, opacity: canSubmit ? 1 : 0.55 }}
        onClick={() => void submit()}
      >{dashboardStrings.composerSend}</button>
    </div>
    {noteText
      ? <div style={{ ...noteStyle, color: noteIsError ? "var(--status-error)" : "var(--cmux-text-secondary)" }}>{noteText}</div>
      : null}
  </div>;
}

/** フッタより一段暗い地に置いて、入力欄が「前に出ている」ように見せる。 */
const rootStyle: CSSProperties = {
  display: "grid",
  gap: 3,
  minWidth: 0,
  flex: 1,
  background: "var(--cmux-bg)",
  borderRadius: "var(--cmux-radius-lg)",
  padding: "5px 8px",
};
const rowStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 8, minWidth: 0 };
const toStyle: CSSProperties = {
  flex: "0 0 auto",
  maxWidth: "34%",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "var(--cmux-text-secondary)",
  fontSize: "var(--cmux-font-size-sm)",
};
const textareaStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  resize: "none",
  background: "var(--cmux-surface)",
  border: "1px solid var(--cmux-border)",
  borderRadius: "var(--cmux-radius-lg)",
  color: "var(--cmux-text)",
  fontFamily: "var(--cmux-font-mono)",
  fontSize: "var(--cmux-font-size-sm)",
  lineHeight: 1.4,
  padding: "6px 10px",
};
const sendButtonStyle: CSSProperties = {
  flex: "0 0 auto",
  background: "var(--cmux-surface)",
  border: "1px solid var(--cmux-border)",
  borderRadius: "var(--cmux-radius-lg)",
  color: "var(--cmux-text)",
  cursor: "pointer",
  fontSize: "var(--cmux-font-size-sm)",
  padding: "5px 10px",
};
const noteStyle: CSSProperties = { minWidth: 0, overflowWrap: "anywhere", fontSize: "var(--cmux-font-size-xs)" };
