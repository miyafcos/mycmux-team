import type { ReactNode } from "react";
import type { UsageSummary, WindowStat } from "../../stores/usageStore";
import { useUsageStore } from "../../stores/usageStore";
import type { AccountUsage } from "../../lib/ipc";

type UsagePopoverProps = {
  summary: UsageSummary;
  lastError: string | null;
  accounts: AccountUsage[];
  accountsError: string | null;
};

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function UsagePopover({ summary, lastError, accounts, accountsError }: UsagePopoverProps) {
  return (
    <div
      className="cmux-popover-panel"
      style={{
        position: "absolute",
        top: "100%",
        right: 0,
        marginTop: 4,
        width: 300,
        maxWidth: "min(300px, calc(100vw - 16px))",
        background: "var(--cmux-popover)",
        border: "1px solid var(--cmux-border)",
        borderRadius: 6,
        zIndex: 100,
        boxShadow: "var(--cmux-shadow-popover)",
        fontSize: 12,
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        color: "var(--cmux-text)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "8px 10px",
          borderBottom: "1px solid var(--cmux-border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 700 }}>Usage</span>
        <span style={{ color: "var(--cmux-text-tertiary)", fontSize: 11 }}>
          Live API
        </span>
      </div>

      <div
        style={{
          padding: "8px 10px",
          display: "grid",
          gap: 7,
          maxHeight: "min(400px, calc(100vh - 120px))",
          overflowY: "auto",
        }}
      >
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
        {accounts.map((account) => (
          <AccountSection key={account.account_id} account={account} />
        ))}
      </div>

      {(summary.claude_error || summary.codex_error || lastError || accountsError) && (
        <div
          style={{
            padding: "6px 10px",
            borderTop: "1px solid var(--cmux-border)",
            color: "var(--cmux-usage-danger)",
            fontSize: 11,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={[summary.claude_error, summary.codex_error, lastError, accountsError]
            .filter(Boolean)
            .join("\n")}
        >
          {summary.claude_error && <div>Claude: {summary.claude_error}</div>}
          {summary.codex_error && <div>Codex: {summary.codex_error}</div>}
          {lastError && <div>{lastError}</div>}
          {accountsError && <div>Accounts: {accountsError}</div>}
        </div>
      )}

      <div
        style={{
          padding: "7px 10px",
          borderTop: "1px solid var(--cmux-border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          color: "var(--cmux-text-tertiary)",
          fontSize: 11,
        }}
      >
        <span>Updated {formatDate(summary.generated_at)}</span>
      </div>
    </div>
  );
}

type SectionBadge = {
  text: string;
  color: string;
};

function UsageSection({
  title,
  badge,
  children,
}: {
  title: string;
  badge?: SectionBadge | null;
  children: ReactNode;
}) {
  return (
    <div style={{ display: "grid", gap: 5 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span
          style={{
            color: "var(--cmux-text-secondary)",
            fontSize: 11,
            fontWeight: 700,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={title}
        >
          {title}
        </span>
        {badge && (
          <span style={{ color: badge.color, fontSize: 11, fontWeight: 700, flexShrink: 0 }}>
            {badge.text}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function AccountSection({ account }: { account: AccountUsage }) {
  const badge: SectionBadge | null = account.needs_reauth
    ? { text: "要再認証", color: "var(--cmux-usage-warn)" }
    : !account.enabled
      ? { text: "無効", color: "var(--cmux-text-tertiary)" }
      : null;

  return (
    <UsageSection title={account.label} badge={badge}>
      {account.needs_reauth ? (
        <button
          onClick={() => useUsageStore.getState().openAccountsDialog(account.account_id)}
          style={{
            justifySelf: "start",
            padding: "3px 8px",
            fontSize: 11,
            borderRadius: 4,
            border: "1px solid var(--cmux-border)",
            background: "transparent",
            color: "var(--cmux-text)",
            cursor: "pointer",
          }}
        >
          再認証
        </button>
      ) : account.error ? (
        <div style={{ color: "var(--cmux-usage-danger)", fontSize: 11 }}>{account.error}</div>
      ) : (
        <>
          <UsageRow label="5h" stat={account.five_hour} />
          <UsageRow label="7d" stat={account.seven_day} />
          <UsageRow label="7d Sonnet" stat={account.seven_day_sonnet} />
          <UsageRow label="7d Opus" stat={account.seven_day_opus} />
        </>
      )}
    </UsageSection>
  );
}

type UsageRowProps = {
  label: string;
  stat: WindowStat | null;
};

function UsageRow({ label, stat }: UsageRowProps) {
  if (!stat) {
    return null;
  }

  return (
    <div style={{ display: "grid", gap: 3 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <span style={{ fontWeight: 600 }}>{label}</span>
        <span style={{ color: thresholdColor(stat.pct) }}>{stat.pct.toFixed(1)}%</span>
      </div>
      <div style={{ color: "var(--cmux-text-tertiary)", fontSize: 11 }}>
        Resets at {formatDate(stat.resets_at)}
      </div>
    </div>
  );
}

function thresholdColor(pct: number): string {
  if (pct >= 95) {
    return "var(--cmux-usage-danger)";
  }
  if (pct >= 80) {
    return "var(--cmux-usage-warn)";
  }
  return "var(--cmux-text-tertiary)";
}

function formatDate(value: string): string {
  if (!value) {
    return "unknown";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return dateFormatter.format(date);
}
