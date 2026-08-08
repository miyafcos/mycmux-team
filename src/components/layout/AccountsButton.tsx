import { useEffect, useMemo, useRef, useState } from "react";
import { OVERLAY_EXIT_MS, useDeferredUnmount } from "../../hooks/useDeferredUnmount";
import { useDismissOnOutside } from "../../hooks/useDismissOnOutside";
import type { CliProvider, ProfileUsage, WindowStat } from "../../lib/ipc";
import {
  PROVIDER_SHORT,
  formatPct,
  orderAccountRows,
  rowHasWindows,
  rowMessage,
  rowNeedsAttention,
  usageBarColor,
} from "../../lib/accountRows";
import { buildChipLabels, capVisible, resolveMeterMode } from "../../lib/usageAccounts";
import { useUsageStore } from "../../stores/usageStore";
import { AccountsPanel } from "./AccountsPanel";

type AccountsButtonMode = "full" | "medium" | "compact" | "extreme";

export function AccountsButton({ onOpenUsageSettings }: { onOpenUsageSettings: () => void }) {
  const accounts = useUsageStore((state) => state.accounts);
  const lastError = useUsageStore((state) => state.lastError);
  const [isOpen, setIsOpen] = useState(false);
  const { mounted: panelMounted, closing: panelClosing } = useDeferredUnmount(isOpen, OVERLAY_EXIT_MS);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const rows = useMemo(() => orderAccountRows(accounts), [accounts]);
  const chipLabels = useMemo(() => buildChipLabels(rows), [rows]);
  const mode = useAccountsButtonMode(rows.length > 0);

  useDismissOnOutside(
    isOpen,
    rootRef,
    (reason) => {
      setIsOpen(false);
      // Escape is a keyboard gesture, so focus goes back to the trigger. An
      // outside click already moved focus wherever the user clicked.
      if (reason === "escape") triggerRef.current?.focus();
    },
    { preventDefaultOnEscape: true },
  );

  const attentionMessages = [
    lastError,
    ...rows.filter(rowNeedsAttention).map((row) => `${row.label}: ${rowMessage(row)}`),
  ].filter((message): message is string => Boolean(message));
  const hasAttention = attentionMessages.length > 0;
  const attention = [...new Set(attentionMessages)].join("\n") || "アカウントと使用量";

  // Two frames: hand focus back to the trigger before the dialog claims it, so
  // closing the dialog returns the user where they started.
  const openUsageSettings = () => {
    setIsOpen(false);
    window.requestAnimationFrame(() => {
      triggerRef.current?.focus();
      window.requestAnimationFrame(onOpenUsageSettings);
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
          gap: "var(--cmux-space-3)",
          minWidth: 0,
          maxWidth: mode === "full" ? 520 : mode === "medium" ? 360 : 220,
          padding: "3px var(--cmux-space-2)",
          border: 0,
          borderRadius: "var(--cmux-radius-sm)",
          background: "none",
          color: "var(--cmux-text-secondary)",
          cursor: "pointer",
          fontSize: "var(--cmux-font-size-xs)",
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          whiteSpace: "nowrap",
          overflow: "hidden",
        }}
      >
        <AccountsButtonLabel mode={mode} rows={rows} chipLabels={chipLabels} />
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
              background: lastError ? "var(--cmux-usage-danger)" : "var(--cmux-usage-warn)",
            }}
          />
        )}
      </button>

      {panelMounted && (
        <AccountsPanel
          closing={panelClosing}
          rows={rows}
          onClose={closeAndFocus}
          onOpenUsageSettings={openUsageSettings}
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
  rows: ProfileUsage[];
  chipLabels: Map<string, string>;
}) {
  if (mode === "extreme") {
    return <span>{`${PROVIDER_SHORT.claude}·${PROVIDER_SHORT.codex}`}</span>;
  }

  return (
    <span
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--cmux-space-3)",
        minWidth: 0,
      }}
    >
      <ProviderSummary provider="claude" rows={rows} chipLabels={chipLabels} mode={mode} />
      <span aria-hidden="true">·</span>
      <ProviderSummary provider="codex" rows={rows} chipLabels={chipLabels} mode={mode} />
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
  rows: ProfileUsage[];
  chipLabels: Map<string, string>;
  mode: Exclude<AccountsButtonMode, "extreme">;
}) {
  const providerRows = rows.filter((row) => row.provider === provider);
  const activeRow = providerRows.find((row) => row.is_active);
  const prioritized = activeRow
    ? [activeRow, ...providerRows.filter((row) => row !== activeRow)]
    : providerRows;
  const row = capVisible(prioritized, 1).visible[0];
  const label = row ? (chipLabels.get(row.profile_id) ?? row.label.slice(0, 4)) : "—";
  const showLabel = mode !== "compact" || provider === "claude";

  return (
    <span
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--cmux-space-2)",
        minWidth: 0,
      }}
    >
      <span>{PROVIDER_SHORT[provider]}</span>
      {showLabel && (
        <span style={{ maxWidth: 54, overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
      )}
      <ProviderUsageSummary row={row} mode={mode} />
    </span>
  );
}

function ProviderUsageSummary({
  row,
  mode,
}: {
  row: ProfileUsage | undefined;
  mode: Exclude<AccountsButtonMode, "extreme">;
}) {
  // A cooldown row still holds its last successful numbers -- show those
  // rather than a dash for up to half an hour.
  const showsNumbers =
    row && (row.state === "ok" || (row.state === "cooldown" && rowHasWindows(row)));
  const fiveHour = showsNumbers ? row.five_hour : null;
  const sevenDay = showsNumbers ? row.seven_day : null;
  if (!fiveHour && !sevenDay) {
    return <span style={{ color: "var(--cmux-text-tertiary)" }}>—</span>;
  }

  if (mode === "full") {
    return (
      <>
        {fiveHour && <WindowChip label="5h" stat={fiveHour} />}
        {sevenDay && <WindowChip label="7d" stat={sevenDay} />}
      </>
    );
  }

  if (mode === "medium") {
    return (
      <span>
        {fiveHour ? formatPct(fiveHour.pct) : "—"}/{sevenDay ? formatPct(sevenDay.pct) : "—"}
      </span>
    );
  }

  if (fiveHour) return <span>{formatPct(fiveHour.pct)}</span>;
  return <span>7d {sevenDay ? formatPct(sevenDay.pct) : "—"}</span>;
}

function WindowChip({ label, stat }: { label: string; stat: WindowStat }) {
  return (
    <span
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--cmux-space-1)",
      }}
    >
      <span>{label}</span>
      <MiniBar stat={stat} />
      <span>{formatPct(stat.pct)}</span>
    </span>
  );
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
            background: cell < activeCells ? usageBarColor(stat.pct) : "var(--cmux-border)",
          }}
        />
      ))}
    </span>
  );
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
