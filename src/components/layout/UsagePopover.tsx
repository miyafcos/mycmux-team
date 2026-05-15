import type { ReactNode } from "react";
import type { UsageSummary, WindowStat } from "../../stores/usageStore";

type UsagePopoverProps = {
  summary: UsageSummary;
  lastError: string | null;
};

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
          Live API
        </span>
      </div>

      <div style={{ padding: "8px 10px", display: "grid", gap: 7 }}>
        {summary.claude_available && (
          <UsageSection title="Claude Code">
            <UsageRow label="5h" stat={summary.claude_5h} />
            <UsageRow label="7d" stat={summary.claude_7d} />
            <UsageRow label="7d Sonnet" stat={summary.claude_7d_sonnet} />
            <UsageRow label="7d Opus" stat={summary.claude_7d_opus} />
          </UsageSection>
        )}
        {summary.codex_available && (
          <UsageSection title="Codex">
            <UsageRow label="5h" stat={summary.codex_5h} />
            <UsageRow label="7d" stat={summary.codex_7d} />
          </UsageSection>
        )}
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
          Updated {formatDate(summary.generated_at)}
        </span>
      </div>

      {(summary.claude_error || summary.codex_error || lastError) && (
        <div
          style={{
            padding: "7px 10px",
            borderTop: "1px solid var(--cmux-border)",
            color: "var(--cmux-usage-danger)",
            fontSize: 11,
          }}
        >
          {summary.claude_error && <div>Claude: {summary.claude_error}</div>}
          {summary.codex_error && <div>Codex: {summary.codex_error}</div>}
          {lastError && <div>{lastError}</div>}
        </div>
      )}
    </div>
  );
}

function UsageSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 5 }}>
      <div style={{ color: "var(--cmux-text-secondary)", fontSize: 11, fontWeight: 700 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function UsageRow({ label, stat }: { label: string; stat: WindowStat | null }) {
  if (!stat) {
    return null;
  }

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
          <span>{stat.pct.toFixed(1)}%</span>
        </div>
        <div style={{ color: "var(--cmux-text-tertiary)", fontSize: 11, marginTop: 2 }}>
          Resets at {formatDate(stat.resets_at)}
        </div>
      </div>
    </div>
  );
}

function formatDate(value: string): string {
  if (!value) {
    return "unknown";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return resetFormatter.format(date);
}
