import type { UsageSummary, WindowStat } from "../../stores/usageStore";

type UsagePopoverProps = {
  summary: UsageSummary;
  lastError: string | null;
};

const countFormatter = new Intl.NumberFormat();
const resetFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "short",
  timeStyle: "short",
});

export function UsagePopover({ summary, lastError }: UsagePopoverProps) {
  return (
    <div
      style={{
        position: "absolute",
        top: "100%",
        right: 0,
        marginTop: 5,
        width: 340,
        maxWidth: "min(340px, calc(100vw - 16px))",
        background: "var(--cmux-popover)",
        border: "1px solid var(--cmux-border)",
        borderRadius: 6,
        zIndex: 100,
        boxShadow: "0 8px 24px rgba(0,0,0,0.42)",
        color: "var(--cmux-text)",
        fontSize: 12,
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "8px 10px",
          borderBottom: "1px solid var(--cmux-border)",
          display: "flex",
          justifyContent: "space-between",
          gap: 10,
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 650 }}>Usage</span>
        <span style={{ color: "var(--cmux-text-tertiary)", fontSize: 11 }}>
          {summary.tier}
        </span>
      </div>

      <div style={{ padding: "8px 10px", display: "grid", gap: 7 }}>
        <UsageRow label="Claude Code 5h" stat={summary.claude_5h} unit="tokens" />
        <UsageRow label="Claude Code 7d" stat={summary.claude_7d} unit="tokens" />
        <UsageRow label="Codex CLI 5h" stat={summary.codex_5h} unit="messages" />
        <UsageRow label="Codex CLI 7d" stat={summary.codex_7d} unit="messages" />
      </div>

      <div
        style={{
          padding: "7px 10px",
          borderTop: "1px solid var(--cmux-border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
        }}
      >
        <span style={{ color: "var(--cmux-text-tertiary)", fontSize: 11 }}>
          Updated {resetFormatter.format(new Date(summary.generated_at))}
        </span>
        {/* TODO(v0.7.1): wire up settings UI */}
        <a
          href="#"
          onClick={(event) => event.preventDefault()}
          style={{
            color: "var(--cmux-text-secondary)",
            fontSize: 11,
            textDecoration: "none",
            whiteSpace: "nowrap",
          }}
        >
          設定で limit を編集
        </a>
      </div>

      {lastError && (
        <div
          style={{
            padding: "7px 10px",
            borderTop: "1px solid var(--cmux-border)",
            color: "var(--cmux-usage-danger)",
            fontSize: 11,
          }}
        >
          {lastError}
        </div>
      )}
    </div>
  );
}

function UsageRow({ label, stat, unit }: { label: string; stat: WindowStat; unit: "tokens" | "messages" }) {
  const value = unit === "tokens" ? stat.tokens : stat.messages;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "96px 1fr", gap: 10 }}>
      <span style={{ color: "var(--cmux-text-secondary)", fontSize: 11 }}>{label}</span>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 8,
            color: "var(--cmux-text)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          <span>
            {countFormatter.format(value)} / {countFormatter.format(stat.limit)} {unit}
          </span>
          <span>{formatPct(stat.pct)}</span>
        </div>
        <div style={{ color: "var(--cmux-text-tertiary)", fontSize: 11, marginTop: 2 }}>
          resets {resetFormatter.format(new Date(stat.reset_at))}
        </div>
      </div>
    </div>
  );
}

function formatPct(pct: number): string {
  const clamped = Math.max(0, Math.min(999.9, pct));
  return `${clamped >= 10 ? clamped.toFixed(0) : clamped.toFixed(1)}%`;
}
