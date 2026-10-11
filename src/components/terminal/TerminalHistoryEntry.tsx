import { useEffect, useRef, useState } from "react";
import { readAgentSessionMappings, type AgentSessionMapping } from "../../lib/ipc";
import { useSettingsStore } from "../../stores/settingsStore";
import { terminalTurnStrings } from "./terminalTurnStrings";
import { TERMINAL_SEARCH_EVENT } from "./terminalSearchEvents";
import { terminalPaneStrings } from "../workspace/terminalPaneStrings";
import { beginTerminalHistoryRequest, isTerminalHistoryRequestCurrent, useTerminalHistoryRequestCancellation } from "./terminalHistoryRequests";

export const TERMINAL_HISTORY_EVENT = "mycmux:terminal-history";
export const TERMINAL_HISTORY_FOCUS_EVENT = "mycmux:terminal-history-focus";
export const HISTORY_MAPPING_POLL_MS = 3_000;

export function hasExactHistoryMapping(mapping: AgentSessionMapping | undefined): boolean {
  return Boolean(mapping?.session_id.trim()
    && (mapping.agent_kind === "claude" || mapping.agent_kind === "codex"
      || mapping.agent_kind === "claude-codex"));
}

/** Read-only mapping checks; never use a saved id or a cwd's newest conversation. */
export function TerminalHistoryEntry({ sessionId, visible = true, searchTitle, variant = "header" }: {
  sessionId: string | null;
  visible?: boolean;
  searchTitle?: string;
  variant?: "header" | "menu";
}) {
  const enabled = useSettingsStore((state) => state.showTerminalHistoryButton);
  const context = useRef({ sessionId, visible });
  context.current = { sessionId, visible };
  useTerminalHistoryRequestCancellation(sessionId, visible);
  const [availability, setAvailability] = useState<{
    sessionId: string; available: boolean;
  } | null>(null);

  useEffect(() => {
    if (!enabled || !visible || !sessionId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async (): Promise<void> => {
      let available = false;
      try {
        const mappings = await readAgentSessionMappings([sessionId]);
        available = hasExactHistoryMapping(mappings?.[sessionId]);
      } catch { /* Unavailable is explicit; mapping errors never choose another conversation. */ }
      if (disposed) return;
      setAvailability({ sessionId, available });
      timer = setTimeout(() => { void check(); }, HISTORY_MAPPING_POLL_MS);
    };
    void check();
    return () => { disposed = true; clearTimeout(timer); };
  }, [enabled, visible, sessionId]);

  if (!visible) return null;
  const checked = availability?.sessionId === sessionId;
  const history = enabled && checked && availability?.available;
  const menu = variant === "menu";
  const disabled = !sessionId || menu && !history;
  const label = menu || history ? terminalTurnStrings.openPanel : terminalPaneStrings.searchTerminal;
  return <button type="button" className={menu ? "pane-history-menu-button" : "pane-action-btn"} role={menu ? "menuitem" : undefined} data-terminal-magnifier="true"
    data-terminal-magnifier-destination={menu || history ? "history" : "terminal"}
    aria-label={label} aria-disabled={disabled}
    title={menu && !history ? checked ? terminalTurnStrings.historyUnlinked : terminalTurnStrings.historyChecking : !sessionId ? terminalPaneStrings.searchUnavailable : history ? label : searchTitle ?? label}
    style={menu ? { display: "block", width: "100%", border: 0, background: "transparent", font: "inherit", textAlign: "left", padding: "6px 12px", color: disabled ? "var(--cmux-text-tertiary)" : "var(--cmux-text)", opacity: disabled ? 0.55 : 1, cursor: disabled ? "default" : "pointer" } : { flexShrink: 0, opacity: disabled ? 0.55 : 1 }}
    onMouseEnter={event => { if (menu && !disabled) event.currentTarget.style.background = "var(--cmux-hover)"; }}
    onMouseLeave={event => { if (menu) event.currentTarget.style.background = "transparent"; }}
    onClick={(event) => {
      event.stopPropagation();
      if (!sessionId || disabled) return;
      // An open panel handles this synchronously, without starting validation.
      if (!window.dispatchEvent(new CustomEvent(TERMINAL_HISTORY_FOCUS_EVENT, {
        detail: { sessionId }, cancelable: true,
      }))) return;
      const request = beginTerminalHistoryRequest(sessionId, menu);
      if (!isTerminalHistoryRequestCurrent(request)) return;
      const dispatch = (mapping?: AgentSessionMapping) => {
        if (!isTerminalHistoryRequestCurrent(request) || context.current.sessionId !== sessionId || !context.current.visible) return;
        const history = useSettingsStore.getState().showTerminalHistoryButton && hasExactHistoryMapping(mapping);
        setAvailability({ sessionId, available: hasExactHistoryMapping(mapping) });
        if (menu && !history) return;
        window.dispatchEvent(new CustomEvent(history ? TERMINAL_HISTORY_EVENT : TERMINAL_SEARCH_EVENT, {
          detail: history ? { sessionId, request } : { sessionId },
        }));
      };
      if (!useSettingsStore.getState().showTerminalHistoryButton) dispatch();
      else void readAgentSessionMappings([sessionId]).then(mappings => dispatch(mappings?.[sessionId])).catch(() => dispatch());
    }}>
    {menu ? label : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="10" cy="10" r="6" /><path d="m15 15 6 6" />
    </svg>}
  </button>;
}
