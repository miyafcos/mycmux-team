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
import { chunkedWrite, enqueueSessionWrite } from "../terminal/terminalCache";
import { eraseSequenceFor, resetSessionDraft, restorableText, sessionDraft } from "../../lib/inputLineDraft";
import { focusController } from "../../lib/focusController";
import { recordRecentInputText } from "../../stores/recentInputStore";
import { clearTurnDraft, noteTurnSubmit } from "../terminal/terminalTurnMarkers";
import { turnLabelFrom } from "../terminal/terminalTurnModel";
import { useComposerStore } from "../../stores/composerStore";
import { useToastStore } from "../../stores/toastStore";

/** Past this the pane's line editor is the wrong tool and the write would stall it. */
const MAX_SEND_CHARS = 100_000;
const LINE_HEIGHT = 20;
const MAX_ROWS = 6;

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
    const pending = sessionDraft(sessionId);
    const text = restorableText(pending);
    if (!text) return;
    enqueueSessionWrite(sessionId, eraseSequenceFor(pending));
    resetSessionDraft(sessionId);
    setDraft(sessionId, draft ? `${draft}${text}` : text);
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
    // Body and submit key go through the same per-session queue in order, so a
    // backed-up write can never let the Enter land on a half-written line.
    chunkedWrite(sessionId, payload.body);
    enqueueSessionWrite(sessionId, payload.submitKey);
    resetSessionDraft(sessionId);
    clearTurnDraft(sessionId);
    recordRecentInputText(sessionId, draft);
    noteTurnSubmit(sessionId, turnLabelFrom(draft));
    clearDraft(sessionId);
    returnToTerminal();
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
