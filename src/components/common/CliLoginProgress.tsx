import { useEffect, useState } from "react";
import type { CliProvider } from "../../lib/ipc";
import { loginRemainingLabel } from "../../lib/cliAccounts";
import { useCliLoginStore } from "../../stores/cliLoginStore";

/**
 * Progress line for an isolated CLI login, shared by the titlebar panel and the
 * settings panel so the two never drift on wording or on when the abort button
 * is offered.
 *
 * `compact` drops the stage text and keeps only the abort control, for the
 * titlebar footer where the add-account button already carries the state and a
 * 400px popover has no room to say it twice.
 */
export function CliLoginProgress({
  provider,
  compact = false,
}: {
  provider: CliProvider;
  compact?: boolean;
}) {
  const entry = useCliLoginStore((state) => state.byProvider[provider]);
  const cancel = useCliLoginStore((state) => state.cancel);
  const waiting = entry?.stage === "waiting";
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!waiting) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [waiting]);

  if (!entry || entry.stage === "idle") return null;

  const text =
    entry.stage === "spawning"
      ? "ログイン画面を開いています…"
      : entry.stage === "capturing"
        ? "登録中…"
        : `ログインの完了を待っています… ${loginRemainingLabel(entry.startedAt, nowMs)}`;

  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--cmux-space-2, 4px)",
        fontSize: 11,
        color: "var(--cmux-text-dim)",
      }}
    >
      {!compact && <span style={{ flex: 1, minWidth: 0 }}>{text}</span>}
      {waiting && (
        <button
          type="button"
          onClick={() => void cancel(provider)}
          style={{
            padding: "2px 7px",
            borderRadius: 3,
            border: "1px solid var(--cmux-border)",
            background: "none",
            color: "var(--cmux-text-secondary)",
            cursor: "pointer",
            fontSize: 11,
            fontFamily: "inherit",
          }}
        >
          中止
        </button>
      )}
    </div>
  );
}
