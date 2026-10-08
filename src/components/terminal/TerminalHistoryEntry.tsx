import { useEffect, useState } from "react";
import { readAgentSessionMappings, type AgentSessionMapping } from "../../lib/ipc";
import { useSettingsStore } from "../../stores/settingsStore";
import { terminalTurnStrings } from "./terminalTurnStrings";

export const TERMINAL_HISTORY_EVENT = "mycmux:terminal-history";
export const HISTORY_MAPPING_POLL_MS = 3_000;

export function hasExactHistoryMapping(mapping: AgentSessionMapping | undefined): boolean {
  return Boolean(mapping?.session_id.trim()
    && (mapping.agent_kind === "claude" || mapping.agent_kind === "codex"
      || mapping.agent_kind === "claude-codex" || mapping.agent_kind === "grok"));
}

/** Read-only mapping checks; never use a saved id or a cwd's newest conversation. */
export function TerminalHistoryEntry({ sessionId, visible = true, compact = false }: {
  sessionId: string | null;
  visible?: boolean;
  compact?: boolean;
}) {
  const enabled = useSettingsStore((state) => state.showTerminalHistoryButton);
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

  if (!enabled || !visible || !sessionId) return null;
  const checked = availability?.sessionId === sessionId;
  if (!checked || !availability.available) {
    return <span data-terminal-history-unavailable="true"
      title={checked ? terminalTurnStrings.historyUnlinked : terminalTurnStrings.historyChecking}
      aria-label={checked ? terminalTurnStrings.historyUnlinked : terminalTurnStrings.historyChecking}
      style={{ color: "var(--cmux-text-dim)", fontSize: "var(--cmux-font-size-xs)", padding: "0 4px" }}>
      {compact ? "?" : terminalTurnStrings.conversationHistory}
    </span>;
  }
  return <button type="button" className="pane-action-btn" data-terminal-history-entry="true"
    aria-label={terminalTurnStrings.openPanel} title={terminalTurnStrings.openPanel}
    style={{ fontSize: "var(--cmux-font-size-xs)", whiteSpace: "nowrap", flexShrink: 0 }}
    onClick={(event) => {
      event.stopPropagation();
      window.dispatchEvent(new CustomEvent(TERMINAL_HISTORY_EVENT, { detail: { sessionId } }));
    }}>
    {compact ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M12 5v16M12 5C8 2 4 3 2 4v15c4-1 7-1 10 2 3-3 6-3 10-2V4c-2-1-6-2-10 1Z" />
    </svg> : terminalTurnStrings.openPanel}
  </button>;
}
