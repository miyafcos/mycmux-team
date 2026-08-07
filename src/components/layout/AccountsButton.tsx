import { useEffect, useMemo, useRef, useState } from "react";
import { OVERLAY_EXIT_MS, useDeferredUnmount } from "../../hooks/useDeferredUnmount";
import type { AccountUsage, CliProvider } from "../../lib/ipc";
import { PROVIDER_SHORT } from "../../lib/cliAccounts";
import {
  accountNoticeMessage,
  buildUnifiedAccounts,
  type UnifiedAccount,
  type UsageWindows,
} from "../../lib/unifiedAccounts";
import { buildChipLabels, capVisible, resolveMeterMode } from "../../lib/usageAccounts";
import { useCliAccountStore } from "../../stores/cliAccountStore";
import { useUsageStore, type WindowStat } from "../../stores/usageStore";
import { AccountsPanel } from "./AccountsPanel";

type AccountsButtonMode = "full" | "medium" | "compact" | "extreme";

export function AccountsButton() {
  const profiles = useCliAccountStore((state) => state.profiles);
  const live = useCliAccountStore((state) => state.live);
  const active = useCliAccountStore((state) => state.active);
  const cliFetchError = useCliAccountStore((state) => state.fetchError);
  const summary = useUsageStore((state) => state.summary);
  const summaryError = useUsageStore((state) => state.lastError);
  const usageAccounts = useUsageStore((state) => state.accounts);
  const usageAccountsError = useUsageStore((state) => state.accountsError);
  const [isOpen, setIsOpen] = useState(false);
  const { mounted: panelMounted, closing: panelClosing } = useDeferredUnmount(isOpen, OVERLAY_EXIT_MS);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

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
  const hasAccountChips = view.rows.length > 0;
  const mode = useAccountsButtonMode(hasAccountChips);

  useEffect(() => {
    if (!isOpen) return;
    const onMouseDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isOpen]);

  const projected = view.rows.map(projectAccountUsage);
  const chipLabels = buildChipLabels(projected);
  const attentionMessages = [
    view.attentionMessage,
    view.unattributedSummary.length > 0 ? accountNoticeMessage("summary_unattributed") : null,
    ...view.rows.filter((row) => row.attention).map((row) => `要対応: ${row.label}`),
    ...view.rows
      .filter((row) => row.usage.source === "oauth-account" && !row.usage.enabled)
      .map((row) => `使用量登録が無効: ${row.label}`),
    summaryError,
    usageAccountsError,
  ].filter((message): message is string => Boolean(message));
  const hasAttention = attentionMessages.length > 0;
  const attention = [...new Set(attentionMessages)].join("\n") || "アカウントと使用量";

  const openUsageManagement = (accountId?: string) => {
    setIsOpen(false);
    window.requestAnimationFrame(() => {
      triggerRef.current?.focus();
      window.requestAnimationFrame(() => {
        useUsageStore.getState().openAccountsDialog(accountId);
      });
    });
  };

  const closeAndFocus = () => {
    setIsOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  return (
    <div
      ref={rootRef}
      style={{ position: "relative", height: 24, display: "flex", alignItems: "center" }}
    >
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen((value) => !value)}
        title={attention}
        aria-label={hasAttention ? `アカウントと使用量。${attention}` : "アカウントと使用量"}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls="accounts-panel"
        className="cmux-title-btn"
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          gap: 7,
          minWidth: 0,
          maxWidth: mode === "full" ? 520 : mode === "medium" ? 360 : 220,
          padding: "3px 6px",
          border: 0,
          borderRadius: 3,
          background: "none",
          color: "var(--cmux-text-secondary)",
          cursor: "pointer",
          fontSize: 11,
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          whiteSpace: "nowrap",
          overflow: "hidden",
        }}
      >
        <AccountsButtonLabel mode={mode} rows={view.rows} chipLabels={chipLabels} />
        {hasAttention && (
          <span
            title={attention}
            role="img"
            aria-label={attention}
            style={{
              width: 5,
              height: 5,
              flexShrink: 0,
              borderRadius: "50%",
              background: summaryError || usageAccountsError
                ? "var(--cmux-usage-danger)"
                : "var(--cmux-usage-warn)",
            }}
          />
        )}
      </button>

      {panelMounted && (
        <AccountsPanel
          closing={panelClosing}
          view={view}
          onClose={closeAndFocus}
          onOpenUsageManagement={openUsageManagement}
        />
      )}
    </div>
  );
}

function AccountsButtonLabel({
  mode,
  rows,
  chipLabels,
}: {
  mode: AccountsButtonMode;
  rows: UnifiedAccount[];
  chipLabels: Map<string, string>;
}) {
  if (mode === "extreme") {
    return <span>{`${PROVIDER_SHORT.claude}·${PROVIDER_SHORT.codex}`}</span>;
  }

  return (
    <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
      <ProviderSummary
        provider="claude"
        rows={rows}
        chipLabels={chipLabels}
        mode={mode}
      />
      <span aria-hidden="true">·</span>
      <ProviderSummary
        provider="codex"
        rows={rows}
        chipLabels={chipLabels}
        mode={mode}
      />
    </span>
  );
}

function ProviderSummary({
  provider,
  rows,
  chipLabels,
  mode,
}: {
  provider: CliProvider;
  rows: UnifiedAccount[];
  chipLabels: Map<string, string>;
  mode: Exclude<AccountsButtonMode, "extreme">;
}) {
  const providerRows = rows.filter((row) => row.provider === provider);
  const activeRow = providerRows.find(
    (row) => row.cli.source !== "none" && (row.cli.active || row.cli.possiblyActive),
  );
  const prioritized = activeRow
    ? [activeRow, ...providerRows.filter((row) => row !== activeRow)]
    : providerRows;
  const row = capVisible(prioritized, 1).visible[0];
  const windows = row?.usage.source === "none" ||
    (row?.usage.source === "oauth-account" && !row.usage.enabled)
    ? null
    : row?.usage.windows;
  const label = row ? (chipLabels.get(row.key) ?? row.label.slice(0, 4)) : "—";
  const showLabel = mode !== "compact" || provider === "claude";

  return (
    <span style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
      <span>{PROVIDER_SHORT[provider]}</span>
      {showLabel && (
        <span style={{ maxWidth: 54, overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
      )}
      <ProviderUsageSummary windows={windows} mode={mode} />
    </span>
  );
}

function ProviderUsageSummary({
  windows,
  mode,
}: {
  windows: UsageWindows | null | undefined;
  mode: Exclude<AccountsButtonMode, "extreme">;
}) {
  if (!windows || (!windows.five_hour && !windows.seven_day)) {
    return <span style={{ color: "var(--cmux-text-tertiary)" }}>—</span>;
  }

  if (mode === "full") {
    return (
      <>
        {windows.five_hour && (
          <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
            <span>5h</span>
            <MiniBar stat={windows.five_hour} />
            <span>{formatPct(windows.five_hour.pct)}</span>
          </span>
        )}
        {windows.seven_day && (
          <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
            <span>7d</span>
            <MiniBar stat={windows.seven_day} />
            <span>{formatPct(windows.seven_day.pct)}</span>
          </span>
        )}
      </>
    );
  }

  if (mode === "medium") {
    return (
      <span>
        {windows.five_hour ? formatPct(windows.five_hour.pct) : "—"}/
        {windows.seven_day ? formatPct(windows.seven_day.pct) : "—"}
      </span>
    );
  }

  if (windows.five_hour) return <span>{formatPct(windows.five_hour.pct)}</span>;
  return <span>7d {windows.seven_day ? formatPct(windows.seven_day.pct) : "—"}</span>;
}

function MiniBar({ stat }: { stat: WindowStat }) {
  const activeCells = stat.pct <= 0 ? 0 : Math.max(1, Math.ceil(Math.min(100, stat.pct) / 20));
  return (
    <span style={{ display: "flex", alignItems: "center" }} aria-hidden="true">
      {[0, 1, 2, 3, 4].map((cell) => (
        <span
          key={cell}
          style={{
            width: 5,
            height: 5,
            marginRight: 1,
            background: cell < activeCells ? usageColor(stat.pct) : "var(--cmux-border)",
          }}
        />
      ))}
    </span>
  );
}

function projectAccountUsage(row: UnifiedAccount): AccountUsage {
  const windows = row.usage.source === "none"
    ? { five_hour: null, seven_day: null, seven_day_sonnet: null, seven_day_opus: null }
    : row.usage.windows;
  return {
    account_id: row.key,
    label: row.label,
    email: row.email,
    enabled: row.usage.source !== "oauth-account" || row.usage.enabled,
    needs_reauth: row.usage.source === "oauth-account" && row.usage.needsReauth,
    ...windows,
    error: row.usage.source === "none" ? null : row.usage.error,
    fetched_at: row.usage.source === "none" ? "" : row.usage.fetchedAt,
  };
}

function useAccountsButtonMode(hasAccountChips: boolean): AccountsButtonMode {
  const [mode, setMode] = useState<AccountsButtonMode>(() => readAccountsButtonMode(hasAccountChips));

  useEffect(() => {
    const queries = [
      window.matchMedia("(max-width: 700px)"),
      window.matchMedia("(max-width: 900px)"),
      window.matchMedia("(max-width: 1100px)"),
    ];
    const update = () => setMode(readAccountsButtonMode(hasAccountChips));
    queries.forEach((query) => query.addEventListener("change", update));
    update();
    return () => queries.forEach((query) => query.removeEventListener("change", update));
  }, [hasAccountChips]);

  return mode;
}

function readAccountsButtonMode(hasAccountChips: boolean): AccountsButtonMode {
  if (typeof window === "undefined") return "full";
  const flags = {
    max700: window.matchMedia("(max-width: 700px)").matches,
    max900: window.matchMedia("(max-width: 900px)").matches,
    max1100: window.matchMedia("(max-width: 1100px)").matches,
  };
  const resolved = resolveMeterMode(flags, hasAccountChips);
  if (resolved === "hidden") return "extreme";
  if (resolved === "compact" && flags.max900) return "compact";
  if (resolved === "compact") return "medium";
  return "full";
}

function usageColor(pct: number): string {
  if (pct >= 95) return "var(--cmux-usage-danger)";
  if (pct >= 80) return "var(--cmux-usage-warn)";
  return "var(--cmux-usage-ok)";
}

function formatPct(value: number): string {
  return `${Math.min(100, Math.max(0, value)).toFixed(value >= 10 ? 0 : 1)}%`;
}
