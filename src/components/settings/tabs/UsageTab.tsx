import { useMemo, useState } from "react";
import { UsageAccountsPanel } from "../../layout/UsageAccountsDialog";
import { usageSourceLabel } from "../../layout/AccountsPanel";
import { CliAccountsPanel } from "../CliAccountsPanel";
import { buildUnifiedAccounts, accountNoticeMessage, type UnifiedAccount } from "../../../lib/unifiedAccounts";
import { PROVIDER_SHORT } from "../../../lib/cliAccounts";
import { useCliAccountStore } from "../../../stores/cliAccountStore";
import { useUsageStore } from "../../../stores/usageStore";

// CLI login and usage registration remain distinct concepts, but the unified
// account row keeps that distinction in separate columns instead of separate
// page sections. Detailed mutation flows stay in the disclosure below.
export function UsageTab() {
  const profiles = useCliAccountStore((state) => state.profiles);
  const live = useCliAccountStore((state) => state.live);
  const active = useCliAccountStore((state) => state.active);
  const cliFetchError = useCliAccountStore((state) => state.fetchError);
  const usageAccounts = useUsageStore((state) => state.accounts);
  const usageAccountsError = useUsageStore((state) => state.accountsError);
  const summary = useUsageStore((state) => state.summary);
  const summaryError = useUsageStore((state) => state.lastError);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const view = useMemo(
    () => buildUnifiedAccounts({
      profiles,
      live,
      active,
      usageAccounts,
      summary,
      cliFetchError,
      usageAccountsError,
      summaryError,
    }),
    [profiles, live, active, usageAccounts, summary, cliFetchError, usageAccountsError, summaryError],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <section style={{ display: "grid", gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: 13 }}>アカウントと使用量</h3>
        <div style={{ color: "var(--cmux-text-dim)", fontSize: 11 }}>
          CLI のログイン状態と mycmux への使用量登録を、同じアカウントの行で確認できます。
        </div>
        <div style={{ overflowX: "auto", border: "1px solid var(--cmux-border)", borderRadius: 6 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead>
              <tr style={{ background: "var(--cmux-bg-hover, rgba(127,127,127,0.08))" }}>
                <TableHeader>CLI ログイン</TableHeader>
                <TableHeader>使用量登録</TableHeader>
                <TableHeader>操作</TableHeader>
              </tr>
            </thead>
            <tbody>
              {view.rows.length === 0 ? (
                <tr>
                  <td colSpan={3} style={{ padding: 10, color: "var(--cmux-text-dim)" }}>
                    アカウント情報がありません。
                  </td>
                </tr>
              ) : view.rows.map((row) => (
                <UnifiedAccountRow
                  key={row.key}
                  row={row}
                  onOpenDetails={() => setDetailsOpen(true)}
                />
              ))}
            </tbody>
          </table>
        </div>
        {view.unattributedSummary.length > 0 && (
          <div style={{ color: "var(--cmux-usage-warn)", fontSize: 11 }}>
            {accountNoticeMessage("summary_unattributed")}
          </div>
        )}
      </section>

      <details
        open={detailsOpen}
        onToggle={(event) => setDetailsOpen(event.currentTarget.open)}
        style={{ borderTop: "1px solid var(--cmux-border)", paddingTop: 14 }}
      >
        <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 700 }}>
          詳細操作（CLI・使用量）
        </summary>
        <div style={{ display: "flex", flexDirection: "column", gap: 18, marginTop: 14 }}>
          <section>
            <h3 style={{ margin: "0 0 8px", fontSize: 13 }}>CLI ログイン詳細</h3>
            <CliAccountsPanel />
          </section>
          <section style={{ borderTop: "1px solid var(--cmux-border)", paddingTop: 14 }}>
            <h3 style={{ margin: "0 0 8px", fontSize: 13 }}>使用量登録詳細</h3>
            <UsageAccountsPanel />
          </section>
        </div>
      </details>
    </div>
  );
}

function UnifiedAccountRow({ row, onOpenDetails }: { row: UnifiedAccount; onOpenDetails: () => void }) {
  const cliStatus = row.cli.source === "none"
    ? "未登録"
    : row.cli.active ? "使用中"
      : row.cli.possiblyActive ? "使用中（確認中）" : row.cli.source === "live" ? "未登録ログイン" : "登録済み";
  const usageStatus = row.usage.source === "oauth-account"
    ? row.usage.needsReauth ? "要再認証" : row.usage.enabled ? "登録済み" : "無効"
    : "未登録";

  return (
    <tr style={{ borderTop: "1px solid var(--cmux-border-hairline)" }}>
      <TableCell>
        <div style={{ display: "grid", gap: 2 }}>
          <span style={{ color: "var(--cmux-text-tertiary)", fontSize: 10 }}>
            {PROVIDER_SHORT[row.provider]}
          </span>
          <span>{row.label}</span>
          {row.email && <span style={{ color: "var(--cmux-text-dim)", fontSize: 10 }}>{row.email}</span>}
          <span style={{ color: row.cli.source !== "none" && row.cli.active ? "var(--cmux-usage-ok)" : "var(--cmux-text-dim)" }}>
            {cliStatus}
          </span>
        </div>
      </TableCell>
      <TableCell>
        <div style={{ display: "grid", gap: 3 }}>
          <span>{usageStatus}</span>
          {row.usage.source !== "none" && (
            <span style={{ color: "var(--cmux-text-tertiary)", fontSize: 10 }}>
              数値の出所: {usageSourceLabel(row.usage.source)}
            </span>
          )}
          {row.notices.map((notice) => (
            <span key={notice} style={{ color: "var(--cmux-text-dim)", fontSize: 10 }}>
              {accountNoticeMessage(notice)}
            </span>
          ))}
        </div>
      </TableCell>
      <TableCell>
        <button type="button" onClick={onOpenDetails} style={detailButtonStyle}>
          詳細で操作
        </button>
      </TableCell>
    </tr>
  );
}

function TableHeader({ children }: { children: string }) {
  return (
    <th style={{ padding: "7px 8px", textAlign: "left", fontWeight: 700, whiteSpace: "nowrap" }}>
      {children}
    </th>
  );
}

function TableCell({ children }: { children: React.ReactNode }) {
  return <td style={{ padding: "8px", verticalAlign: "top", minWidth: 130 }}>{children}</td>;
}

const detailButtonStyle = {
  padding: "3px 8px",
  borderRadius: 4,
  border: "1px solid var(--cmux-border)",
  background: "none",
  color: "var(--cmux-text-secondary)",
  cursor: "pointer",
  fontSize: 11,
  fontFamily: "inherit",
} as const;
