import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

import {
  buildComposerPayload,
  composerKeyIntent,
  resolveComposerAgentLabelKind,
  resolveComposerTarget,
  type ComposerAgentLabelKind,
  type ComposerTargetInput,
} from "../../lib/composerSend";
import { eraseSequenceFor, resetSessionDraft, restorableText, sessionDraft } from "../../lib/inputLineDraft";
import { focusController } from "../../lib/focusController";
import { handleSocketCommand } from "../layout/socketCommands";
import { useComposerStore } from "../../stores/composerStore";
import { useToastStore } from "../../stores/toastStore";

/** Past this the pane's line editor is the wrong tool and the write would stall it. */
const MAX_SEND_CHARS = 100_000;
const LINE_HEIGHT = 20;
const MAX_ROWS = 6;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The part of pane.send_text's reply this composer acts on. */
interface PaneSendOutcome {
  confirmed?: boolean;
  reason?: string;
}

const TARGET_LABEL: Record<ComposerAgentLabelKind, string> = {
  claude: "Claude",
  "claude-codex": "claude-codex",
  codex: "Codex",
  grok: "Grok",
  shell: "シェル",
};

export interface PaneComposerProps {
  sessionId: string;
  /** Enough of the pane's launch parameters to tell which program reads the input. */
  target: ComposerTargetInput;
}

/**
 * The pane's own input line: a real textarea, so selecting a phrase and typing
 * over it works the way it does everywhere else. The pane's program only ever
 * sees the finished text, sent as the keystrokes that program understands.
 */
export function PaneComposer({ sessionId, target }: PaneComposerProps) {
  const draft = useComposerStore((state) => state.draftBySession[sessionId] ?? "");
  const setDraft = useComposerStore((state) => state.setDraft);
  const clearDraft = useComposerStore((state) => state.clearDraft);
  const [focused, setFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  /** True between issuing an adopt's erase and that erase landing. */
  const adoptingRef = useRef(false);

  const resolved = resolveComposerTarget(target);
  // The badge names the agent; the payload follows the input shape it shares.
  const label = TARGET_LABEL[resolveComposerAgentLabelKind(target)];
  const payload = buildComposerPayload({ text: draft, target: resolved });
  const canSend = payload.body.length > 0;

  // Grow with the text, then scroll: the terminal keeps the rest of the pane.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, LINE_HEIGHT * MAX_ROWS)}px`;
  }, [draft]);

  useEffect(() => {
    const focus = (event: Event): void => {
      if ((event as CustomEvent<{ sessionId: string }>).detail?.sessionId !== sessionId) return;
      textareaRef.current?.focus();
    };
    window.addEventListener("mycmux:composer-focus", focus);
    return () => window.removeEventListener("mycmux:composer-focus", focus);
  }, [sessionId]);

  /** Every byte this composer puts into the pane goes through here. */
  const writeToPane = (text: string, submit = false): Promise<PaneSendOutcome> =>
    handleSocketCommand("pane.send_text", {
      sessionId,
      text,
      // A stray re-pressed Enter would answer whatever the pane asked next, and
      // the operator is sitting right here to press it themselves.
      ...(submit ? { enter: true, retrySubmit: false } : {}),
    }) as Promise<PaneSendOutcome>;

  const returnToTerminal = (): void => {
    // Blur first: the refocus retries bail out while the composer holds focus.
    textareaRef.current?.blur();
    focusController.focusSessionSoon(sessionId);
  };

  const adoptPendingLine = (): void => {
    // Only a draft we mirrored keystroke for keystroke can be moved safely; if
    // the line was edited in ways we cannot model, leave the pane alone. A TUI
    // rewrites its own input line, so our mirror can read clean while the real
    // line holds something else — erasing that would eat the user's text.
    if (resolved !== "shell") return;
    // The mirror is only cleared once the erase lands, so a blur/focus inside
    // that window would read the same pending line and fire a second set of
    // backspaces -- which would eat the characters the first set uncovered.
    if (adoptingRef.current) return;
    const pending = sessionDraft(sessionId);
    const text = restorableText(pending);
    if (!text) return;
    const before = draft;
    adoptingRef.current = true;
    // Same route as send(), so the erase can never overtake the message that
    // follows it: pane.send_text serialises per session, the terminal's own
    // input queue is a separate lane and mixing the two loses that ordering.
    //
    // The text moves only once the erase has actually landed. Moving it first
    // and erasing in the background leaves the line in the pane *and* in the
    // editor when the write fails, and the next send submits it twice.
    void writeToPane(eraseSequenceFor(pending)).then(() => {
      resetSessionDraft(sessionId);
      // The pane's line was typed before any of this, so it goes after whatever
      // the editor already held and before anything typed during the wait.
      const current = useComposerStore.getState().draftBySession[sessionId] ?? "";
      const duringWait = current.startsWith(before) ? current.slice(before.length) : current;
      setDraft(sessionId, `${before}${text}${duringWait}`);
    }).catch((error: unknown) => {
      useToastStore.getState().pushToast(
        `ターミナルの入力行を移せませんでした: ${errorText(error)}`,
        "error",
      );
    }).finally(() => {
      adoptingRef.current = false;
    });
  };

  /**
   * Put the text back when the send never reached the pane. Prepended rather
   * than assigned: the editor is cleared optimistically, so by the time a
   * failure comes back the operator may already be typing the next message.
   */
  const restoreFailedDraft = (text: string): void => {
    const current = useComposerStore.getState().draftBySession[sessionId] ?? "";
    setDraft(sessionId, current ? `${text}\n${current}` : text);
  };

  const send = (): void => {
    if (!canSend) return;
    if (payload.body.length > MAX_SEND_CHARS) {
      useToastStore.getState().pushToast(
        `長すぎて送れません (${payload.body.length.toLocaleString()}文字・上限 ${MAX_SEND_CHARS.toLocaleString()})`,
        "warning",
      );
      return;
    }
    const sent = draft;
    // pane.send_text, not a raw pair of writes: it writes the body, waits for
    // the pane to echo it, and only then sends the submit key as its own write.
    // The raw route queued both, and the queue batches whatever is pending into
    // one PTY write -- so whenever another write was already in flight the agent
    // received the paste and the Enter in a single read, committed the Enter
    // against an input line that had not caught up yet, and the message was
    // gone (2026-09-02). The dashboard reply box has always used this route.
    // recentInput / turn markers are recorded by the handler, not here.
    resetSessionDraft(sessionId);
    clearDraft(sessionId);
    // Focus goes back only once the message is committed. Handing it to the
    // terminal first reopens the same wound in a narrower window: keystrokes
    // ride the terminal's own queue, so anything typed between the body and the
    // submit key lands inside the line about to be submitted.
    void writeToPane(payload.body, true).then((outcome) => {
      // Only when the operator has not started the next message. Waiting for the
      // send and *then* taking focus is worse than never taking it: the typing
      // already in progress gets cut in half, with the first part in the editor
      // and the rest going straight to the PTY.
      if (!useComposerStore.getState().draftBySession[sessionId]) returnToTerminal();
      // Resolving is not the same as landing: an unmounted or unreadable pane
      // comes back ok:false, and staying quiet there is the silence this whole
      // change exists to remove.
      if (outcome?.confirmed !== true) {
        useToastStore.getState().pushToast(
          `送信を確認できませんでした${outcome?.reason ? ` (${outcome.reason})` : ""}。ペインの入力行を確認してください`,
          "warning",
        );
      }
    }).catch((error: unknown) => {
      // Restore even though a failure after the body write leaves the text in
      // the pane too: a visible duplicate can be deleted, a silently dropped
      // message cannot be recovered.
      // ponytail: one attempt, no backpressure retry. The old raw route retried
      // a congested write forever and said nothing; this one gives up and hands
      // the text back. Add a bounded retry on PTY_INPUT_BACKPRESSURE if pastes
      // near MAX_SEND_CHARS start bouncing in practice.
      restoreFailedDraft(sent);
      useToastStore.getState().pushToast(`送信できませんでした: ${errorText(error)}`, "error");
    });
  };

  return (
    <div
      data-livebrief-interactive="true"
      data-composer-session={sessionId}
      style={rootStyle}
    >
      <div style={{ ...shellStyle, ...(focused ? shellFocusedStyle : null) }}>
        <span style={badgeStyle}>{label}</span>
        <textarea
          ref={textareaRef}
          rows={1}
          value={draft}
          aria-label={`${label} へ送るメッセージ`}
          placeholder="メッセージを入力"
          onChange={(event) => setDraft(sessionId, event.target.value)}
          onFocus={() => { setFocused(true); adoptPendingLine(); }}
          onBlur={() => setFocused(false)}
          onKeyDown={(event) => {
            const intent = composerKeyIntent({
              key: event.key,
              shiftKey: event.shiftKey,
              ctrlKey: event.ctrlKey,
              altKey: event.altKey,
              metaKey: event.metaKey,
              isComposing: event.nativeEvent.isComposing,
              keyCode: event.nativeEvent.keyCode,
            });
            if (intent === "none" || intent === "newline") return;
            event.preventDefault();
            event.stopPropagation();
            if (intent === "close") returnToTerminal();
            else send();
          }}
          style={textareaStyle}
        />
        {/* Always mounted: a button that appears under the cursor turns a tap
            meant for the caret into a send. */}
        <button
          type="button"
          onClick={send}
          disabled={!canSend}
          aria-label="送信"
          style={{ ...sendButtonStyle, opacity: canSend ? 1 : 0.3, cursor: canSend ? "pointer" : "default" }}
        >
          ↵
        </button>
      </div>
      {/* The row keeps its height whether or not the hint is showing, so
          focusing the composer never resizes the terminal above it. */}
      <div style={{ ...hintStyle, visibility: focused ? "visible" : "hidden" }}>
        <span>Shift+Enter で改行・Esc でターミナルへ</span>
        {payload.foldedNewlines ? <span>改行はスペースに畳んで送ります</span> : null}
      </div>
    </div>
  );
}

const rootStyle: CSSProperties = {
  flex: "0 0 auto",
  display: "grid",
  gap: 2,
  padding: "4px 8px 6px",
  borderTop: "1px solid var(--cmux-border)",
  background: "var(--cmux-bg)",
};
const shellStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  gap: 6,
  padding: "4px 6px",
  borderRadius: "var(--cmux-radius-lg)",
  background: "transparent",
  boxShadow: "none",
  transition: "background 120ms ease-out, box-shadow 120ms ease-out",
};
const shellFocusedStyle: CSSProperties = {
  background: "var(--cmux-surface)",
  boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--cmux-accent) 40%, transparent), 0 2px 12px rgba(0, 0, 0, 0.18)",
};
const badgeStyle: CSSProperties = {
  flex: "0 0 auto",
  alignSelf: "center",
  color: "var(--cmux-text-dim)",
  fontSize: "var(--cmux-font-size-xs)",
  whiteSpace: "nowrap",
};
const textareaStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  resize: "none",
  border: "none",
  outline: "none",
  background: "transparent",
  color: "var(--cmux-text)",
  fontFamily: "var(--cmux-font-mono)",
  fontSize: "var(--cmux-font-size-sm)",
  lineHeight: `${LINE_HEIGHT}px`,
  padding: "2px 0",
};
const sendButtonStyle: CSSProperties = {
  flex: "0 0 auto",
  alignSelf: "flex-end",
  border: "none",
  background: "transparent",
  color: "var(--cmux-text-secondary)",
  cursor: "pointer",
  fontSize: "var(--cmux-font-size-sm)",
  lineHeight: `${LINE_HEIGHT}px`,
  padding: "0 2px",
  animation: "cmux-composer-send-in 90ms ease-out",
};
const hintStyle: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 10,
  padding: "0 8px",
  color: "var(--cmux-text-dim)",
  fontSize: "var(--cmux-font-size-xs)",
};
