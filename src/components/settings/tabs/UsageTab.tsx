import { useMemo } from "react";
import { AccountAutoSwitchSettings } from "../AccountAutoSwitchSettings";
import { CliAccountsPanel } from "../CliAccountsPanel";
import type { ProfileUsage, WindowStat } from "../../../lib/ipc";
import {
  PROVIDER_SHORT,
  formatPct,
  formatUpdatedAt,
  orderAccountRows,
  rowMessage,
} from "../../../lib/accountRows";
import { grokAccountStrings, grokProductName } from "../../../lib/grokAccountStrings";
import { useUsageStore } from "../../../stores/usageStore";

// The panel in the titlebar answers "how much is left"; this tab is where the
// per-window breakdown and the account management flows live.
export function UsageTab() {
  const accounts = useUsageStore((state) => state.accounts);
  const lastError = useUsageStore((state) => state.lastError);
  const rows = useMemo(() => orderAccountRows(accounts), [accounts]);
  const hasGrokRows = rows.some((row) => row.provider === "grok");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <AccountAutoSwitchSettings />
      <section style={{ display: "grid", gap: "var(--cmux-space-4)" }}>
        <h3 style={{ margin: 0, fontSize: "var(--cmux-font-size-md)" }}>アカウント別の使用量</h3>
        <div style={{ color: "var(--cmux-text-dim)", fontSize: "var(--cmux-font-size-xs)" }}>
          使用中でないアカウントの使用量を取るため、mycmux が保存済みトークンを更新することがあります。
        </div>
        {lastError && (
          <div style={{ color: "var(--cmux-usage-danger)", fontSize: "var(--cmux-font-size-xs)" }}>
            {lastError}
          </div>
        )}
        <div
          style={{
            overflowX: "auto",
            border: "1px solid var(--cmux-border)",
            borderRadius: "var(--cmux-radius-md)",
          }}
        >
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "var(--cmux-font-size-xs)",
            }}
          >
            <thead>
              <tr style={{ background: "var(--cmux-hover)" }}>
                <TableHeader>アカウント</TableHeader>
                <TableHeader>5h</TableHeader>
                <TableHeader>{hasGrokRows ? grokAccountStrings.weeklyWindowLabel : "7d"}</TableHeader>
                <TableHeader>7d Sonnet</TableHeader>
                <TableHeader>7d Opus</TableHeader>
                <TableHeader>取得時刻</TableHeader>
                <TableHeader>状態</TableHeader>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ padding: 10, color: "var(--cmux-text-dim)" }}>
                    アカウント情報がありません。
                  </td>
                </tr>
              ) : (
                rows.map((row) => <UsageDetailRow key={row.profile_id} row={row} />)
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section style={{ borderTop: "1px solid var(--cmux-border)", paddingTop: 14 }}>
        <h3 style={{ margin: "0 0 8px", fontSize: "var(--cmux-font-size-md)" }}>
          CLI アカウントの管理
        </h3>
        <CliAccountsPanel />
      </section>
    </div>
  );
}

function UsageDetailRow({ row }: { row: ProfileUsage }) {
  const message = rowMessage(row);

  return (
    <>
      <tr style={{ borderTop: "1px solid var(--cmux-border-hairline)" }}>
        <TableCell>
          <div style={{ display: "grid", gap: 2 }}>
            <span style={{ color: "var(--cmux-text-tertiary)" }}>{PROVIDER_SHORT[row.provider]}</span>
            <span>{row.email ?? row.label}</span>
            {row.plan && <span style={{ color: "var(--cmux-text-dim)" }}>{row.plan}</span>}
          </div>
        </TableCell>
        <PctCell stat={row.five_hour} />
        <PctCell stat={row.seven_day} />
        <PctCell stat={row.seven_day_sonnet} />
        <PctCell stat={row.seven_day_opus} />
        <TableCell>{formatUpdatedAt(row.fetched_at)}</TableCell>
        <TableCell>
          <div style={{ display: "grid", gap: 2 }}>
            <span
              style={{
                color: row.is_active ? "var(--cmux-usage-ok)" : "var(--cmux-text-dim)",
              }}
            >
              {row.is_active ? "使用中" : row.registered ? "登録済み" : "CLI 未登録"}
            </span>
            {message && <span style={{ color: "var(--cmux-text-dim)" }}>{message}</span>}
          </div>
        </TableCell>
      </tr>
      {row.model_windows.length > 0 && (
        <tr>
          <td
            colSpan={7}
            style={{
              padding: "0 8px 8px",
              fontSize: "var(--cmux-font-size-xs)",
              color: "var(--cmux-text-dim)",
            }}
          >
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px" }}>
              {row.model_windows.map((named) => (
                <span key={named.key} style={{ whiteSpace: "nowrap" }}>
                  {row.provider === "grok" ? `${grokAccountStrings.breakdownLabel} ${grokProductName(named.key)}` : named.key} {formatPct(named.window.pct)}
                  {named.window.resets_at && (
                    <span> ・リセット {formatUpdatedAt(named.window.resets_at)}</span>
                  )}
                </span>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * A window's own reset time sits under its number: each of the four limits
 * resets on its own clock, so a single shared column could only lie about
 * three of them (and did — an empty resets_at sorted ahead of every real one
 * and blanked the whole column).
 */
function PctCell({ stat }: { stat: WindowStat | null }) {
  return (
    <TableCell>
      {stat ? (
        <div style={{ display: "grid", gap: 2 }}>
          <span>{formatPct(stat.pct)}</span>
          {stat.resets_at && (
            <span style={{ color: "var(--cmux-text-dim)", whiteSpace: "nowrap" }}>
              ↻ {formatUpdatedAt(stat.resets_at)}
            </span>
          )}
        </div>
      ) : (
        "—"
      )}
    </TableCell>
  );
}

function TableHeader({ children }: { children: React.ReactNode }) {
  return (
    <th style={{ padding: "7px 8px", textAlign: "left", fontWeight: 700, whiteSpace: "nowrap" }}>
      {children}
    </th>
  );
}

function TableCell({ children }: { children: React.ReactNode }) {
  return <td style={{ padding: "8px", verticalAlign: "top" }}>{children}</td>;
}
