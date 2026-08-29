import { useEffect, useRef, useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import type { ProfileUsage, WindowStat } from "../../lib/ipc";
import {
  PROVIDER_ORDER,
  addAccountLabel,
  canSwitchCliAccount,
  cliAccountMessage,
  executeCliAccountSwitch,
  loginRemainingLabel,
  runningAgentCounts,
  runningAgentPaneDetails,
  switchWarningText,
} from "../../lib/cliAccounts";
import {
  PROVIDER_SHORT,
  SHARED_RESET_TITLE,
  displayWindows,
  formatPct,
  formatResetShort,
  formatUpdatedAt,
  rowMessage,
  sharedResetAt,
  staleWindowsNote,
  usageBarColor,
  usageColor,
} from "../../lib/accountRows";
import { CliLoginProgress } from "../common/CliLoginProgress";
import { useCliAccountStore } from "../../stores/cliAccountStore";
import { useCliLoginStore } from "../../stores/cliLoginStore";
import { usePaneMetadataStore } from "../../stores/paneMetadataStore";
import { useUsageStore } from "../../stores/usageStore";

type AccountsPanelProps = {
  closing?: boolean;
  rows: ProfileUsage[];
  onClose: () => void;
  onOpenUsageSettings: () => void;
};

export function AccountsPanel({
  closing = false,
  rows,
  onClose,
  onOpenUsageSettings,
}: AccountsPanelProps) {
  const fetchError = useCliAccountStore((state) => state.fetchError);
  const operationError = useCliAccountStore((state) => state.operationError);
  const lastSwitchResult = useCliAccountStore(
    (state) => state.lastSwitchResult,
  );
  const dismissOperationError = useCliAccountStore(
    (state) => state.dismissOperationError,
  );
  const dismissSwitchWarnings = useCliAccountStore(
    (state) => state.dismissSwitchWarnings,
  );
  const usageError = useUsageStore((state) => state.lastError);
  const generatedAt = useUsageStore((state) => state.generatedAt);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (closing) return;
    const frame = window.requestAnimationFrame(() => {
      const firstButton = menuRef.current?.querySelector<HTMLButtonElement>(
        "button:not([disabled])",
      );
      (firstButton ?? menuRef.current)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [closing]);

  return (
    <div
      id="accounts-panel"
      ref={menuRef}
      role="dialog"
      aria-label="アカウントと使用量"
      tabIndex={-1}
      className={`cmux-popover-panel${closing ? " is-closing" : ""}`}
      style={{
        position: "absolute",
        top: "100%",
        right: 0,
        marginTop: 4,
        width: 400,
        maxWidth: "min(400px, calc(100vw - 16px))",
        maxHeight: "min(560px, calc(100vh - 56px))",
        overflowX: "hidden",
        overflowY: "auto",
        background: "var(--cmux-popover)",
        border: "1px solid var(--cmux-border)",
        borderRadius: "var(--cmux-radius-md)",
        zIndex: 100,
        boxShadow: "var(--cmux-shadow-popover)",
        fontSize: "var(--cmux-font-size-sm)",
        color: "var(--cmux-text)",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: "var(--cmux-space-4)",
          padding: "var(--cmux-space-4) var(--cmux-space-5)",
          borderBottom: "1px solid var(--cmux-border-hairline)",
        }}
      >
        <span style={{ fontSize: "var(--cmux-font-size-xs)", fontWeight: 700 }}>
          アカウント
        </span>
        <span
          style={{
            fontSize: "var(--cmux-font-size-xs)",
            color: "var(--cmux-text-tertiary)",
          }}
        >
          更新 {formatUpdatedAt(generatedAt)}
        </span>
      </header>

      {rows.length === 0 ? (
        <div
          style={{
            padding: "var(--cmux-space-5)",
            color: "var(--cmux-text-dim)",
            fontSize: "var(--cmux-font-size-xs)",
          }}
        >
          アカウント情報がありません。
        </div>
      ) : (
        <div>
          {rows.map((row) => (
            <AccountRow key={row.profile_id} row={row} onClose={onClose} />
          ))}
        </div>
      )}

      {(fetchError ||
        usageError ||
        operationError ||
        (lastSwitchResult?.warnings.length ?? 0) > 0) && (
        <div
          style={{
            display: "grid",
            gap: "var(--cmux-space-1)",
            padding: "var(--cmux-space-3) var(--cmux-space-5)",
            borderTop: "1px solid var(--cmux-border-hairline)",
            fontSize: "var(--cmux-font-size-xs)",
          }}
        >
          {fetchError && (
            <div style={{ color: "var(--cmux-usage-danger)" }}>
              {fetchError}
            </div>
          )}
          {usageError && (
            <div style={{ color: "var(--cmux-usage-danger)" }}>
              {usageError}
            </div>
          )}
          {operationError && (
            <Dismissable
              color="var(--cmux-usage-danger)"
              onDismiss={dismissOperationError}
            >
              {operationError}
            </Dismissable>
          )}
          {lastSwitchResult?.warnings.map((warning) => (
            <Dismissable
              key={warning}
              color="var(--cmux-usage-warn)"
              onDismiss={dismissSwitchWarnings}
            >
              {cliAccountMessage(warning)}
            </Dismissable>
          ))}
        </div>
      )}

      <Footer onOpenUsageSettings={onOpenUsageSettings} />
    </div>
  );
}

function AccountRow({
  row,
  onClose,
}: {
  row: ProfileUsage;
  onClose: () => void;
}) {
  const busyProfileId = useCliAccountStore(
    (state) => state.busyByProvider[row.provider],
  );
  const switchTo = useCliAccountStore((state) => state.switchTo);
  const capture = useCliAccountStore((state) => state.capture);
  const paneMetadata = usePaneMetadataStore((state) => state.metadata);
  const volatilePaneMetadata = usePaneMetadataStore((state) => state.volatileMetadata);
  const providerBusy = busyProfileId !== null;
  const isBusy = busyProfileId === row.profile_id;

  // An unregistered live login is offered as a one-click capture instead of a
  // switch: it is already the account in use, it just is not saved yet.
  const disabled = row.is_active
    ? true
    : row.registered
      ? providerBusy || row.needs_relogin
      : providerBusy;

  const handleClick = async () => {
    if (row.is_active) return;
    if (!row.registered) {
      await capture(row.provider);
      return;
    }
    if (!canSwitchCliAccount(row.is_active, providerBusy, row.needs_relogin))
      return;
    const count = runningAgentCounts(paneMetadata)[row.provider];
    const paneDetails = runningAgentPaneDetails(paneMetadata, row.provider, volatilePaneMetadata);
    const warning = switchWarningText(
      count,
      row.provider,
      row.label,
      paneDetails,
    );
    const result = await executeCliAccountSwitch(
      row.is_active,
      providerBusy,
      row.needs_relogin,
      () =>
        confirm(warning, {
          title: "CLI アカウントを切り替える",
          kind: "warning",
          okLabel: "切り替える",
          cancelLabel: "キャンセル",
        }).catch(() => false),
      () => switchTo(row.provider, row.profile_id),
    );
    if (result && result.warnings.length === 0) onClose();
  };

  const message = rowMessage(row);
  const staleNote = staleWindowsNote(row);
  const windows = displayWindows(row);
  // The panel is 400px wide and every row stays on one line, so each extra
  // window (per-model weekly limits) has to buy its space from the bars
  // themselves. Without this the meter line's min-content grew past the panel
  // and pushed the "使用中" label of the line above out of view.
  const dense = windows.length >= 4 ? "tight" : windows.length >= 3 ? "snug" : "roomy";
  const cells = dense === "tight" ? 3 : dense === "snug" ? 5 : 10;
  const sharedReset = sharedResetAt(windows.map((window) => window.stat));
  const sharedResetLabel = sharedReset ? formatResetShort(sharedReset) : "";
  const collapseReset = Boolean(sharedResetLabel);
  const action = row.is_active
    ? "使用中"
    : isBusy
      ? "処理中…"
      : row.registered
        ? "切替 ›"
        : "登録";

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      title={row.email ?? row.label}
      style={{
        display: "grid",
        // minmax(0, 1fr): a wide meter line must never widen the row's only
        // column, or the line above is laid out at that width and its trailing
        // label is clipped by the panel's overflow.
        gridTemplateColumns: "minmax(0, 1fr)",
        gap: "var(--cmux-space-1)",
        width: "100%",
        padding: "var(--cmux-space-3) var(--cmux-space-5)",
        border: 0,
        borderBottom: "1px solid var(--cmux-border-hairline)",
        background: "none",
        color: "inherit",
        font: "inherit",
        textAlign: "left",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled && !row.is_active ? 0.6 : 1,
      }}
    >
      <span
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: "var(--cmux-space-3)",
          minWidth: 0,
        }}
      >
        <span
          aria-hidden="true"
          style={{
            flexShrink: 0,
            fontSize: "var(--cmux-font-size-xs)",
            fontWeight: 700,
            color: "var(--cmux-text-tertiary)",
          }}
        >
          {PROVIDER_SHORT[row.provider]}
        </span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: "var(--cmux-font-size-xs)",
            fontWeight: 700,
            color: "var(--cmux-text-secondary)",
          }}
        >
          {row.email ?? row.label}
        </span>
        {row.plan && (
          <span
            style={{
              flexShrink: 0,
              fontSize: "var(--cmux-font-size-xs)",
              color: "var(--cmux-text-tertiary)",
            }}
          >
            {row.plan}
          </span>
        )}
        <span
          style={{
            flexShrink: 0,
            fontSize: "var(--cmux-font-size-xs)",
            color: row.is_active
              ? "var(--cmux-text)"
              : "var(--cmux-text-tertiary)",
          }}
        >
          {action}
        </span>
      </span>

      {staleNote ? (
        <>
          <span
            style={{
              display: "flex",
              gap: dense === "roomy" ? "var(--cmux-space-5)" : "var(--cmux-space-3)",
              alignItems: "center",
              minWidth: 0,
              opacity: 0.55,
            }}
          >
            {windows.map(({ key, ...window }) => (
              <UsageBar
                key={key}
                {...window}
                cells={cells}
                dense={dense}
                showReset={!collapseReset}
              />
            ))}
            {collapseReset && <SharedResetMark label={sharedResetLabel} />}
          </span>
          <span
            style={{
              fontSize: "var(--cmux-font-size-xs)",
              color: "var(--cmux-text-dim)",
            }}
          >
            {staleNote}
          </span>
        </>
      ) : message ? (
        <span
          style={{
            fontSize: "var(--cmux-font-size-xs)",
            color:
              row.state === "needs_relogin" || row.state === "error"
                ? "var(--cmux-usage-warn)"
                : "var(--cmux-text-dim)",
          }}
        >
          {message}
        </span>
      ) : (
        <span
          style={{
            display: "flex",
            gap: dense === "roomy" ? "var(--cmux-space-5)" : "var(--cmux-space-3)",
            alignItems: "center",
            minWidth: 0,
          }}
        >
          {windows.length > 0 ? (
            windows.map(({ key, ...window }) => (
              <UsageBar
                key={key}
                {...window}
                cells={cells}
                dense={dense}
                showReset={!collapseReset}
              />
            ))
          ) : (
            <span style={{ color: "var(--cmux-text-tertiary)" }}>—</span>
          )}
          {collapseReset && <SharedResetMark label={sharedResetLabel} />}
          <span
            title={`取得 ${formatUpdatedAt(row.fetched_at)}`}
            style={{
              marginLeft: "auto",
              paddingLeft: "var(--cmux-space-2)",
              fontSize: "var(--cmux-font-size-xs)",
              color: "var(--cmux-text-dim)",
              whiteSpace: "nowrap",
            }}
          >
            {dense === "roomy" ? "取得 " : ""}
            {formatResetShort(row.fetched_at) ||
              formatUpdatedAt(row.fetched_at)}
          </span>
        </span>
      )}
    </button>
  );
}

function SharedResetMark({ label }: { label: string }) {
  return (
    <span
      title={SHARED_RESET_TITLE}
      style={{
        color: "var(--cmux-text-dim)",
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      {`↻${label}`}
    </span>
  );
}

function UsageBar({
  label,
  stat,
  hint,
  cells,
  dense = "roomy",
  showReset = true,
}: {
  label: string;
  stat: WindowStat;
  hint: string;
  cells: number;
  dense?: "roomy" | "snug" | "tight";
  showReset?: boolean;
}) {
  return (
    <span
      title={hint}
      style={{
        display: "flex",
        alignItems: "center",
        gap: dense === "tight" ? 2 : "var(--cmux-space-2)",
        fontSize: "var(--cmux-font-size-xs)",
        color: "var(--cmux-text-tertiary)",
        flexShrink: 0,
      }}
    >
      <span>{label}</span>
      <>
        <span
          style={{ display: "flex", alignItems: "center" }}
          aria-hidden="true"
        >
          {Array.from({ length: cells }, (_, cell) => {
            const lit =
              stat.pct <= 0
                ? 0
                : Math.max(
                    1,
                    Math.ceil(Math.min(100, stat.pct) / (100 / cells)),
                  );
            return (
              <span
                key={cell}
                style={{
                  width: 5,
                  height: 6,
                  marginRight: 1,
                  background:
                    cell < lit ? usageBarColor(stat.pct) : "var(--cmux-border)",
                }}
              />
            );
          })}
        </span>
        <span
          style={{
            color: usageColor(stat.pct),
            minWidth: dense === "roomy" ? 30 : 26,
          }}
        >
          {formatPct(stat.pct)}
        </span>
        {/* Per-window reset is the first thing to go when a row is tight and
            the dates differ; `title` still spells it out on hover. A shared
            date is rendered once after the meters instead, even in tight. */}
        {showReset &&
          dense !== "tight" &&
          stat.resets_at &&
          formatResetShort(stat.resets_at) && (
            <span
              style={{ color: "var(--cmux-text-dim)", whiteSpace: "nowrap" }}
            >
              {/* Always the arrow, never the spelled-out word: an account
                  with a single meter sat next to accounts with two, and the
                  odd one out read as a different kind of value. `title`
                  spells it out on hover. */}
              {`↻${formatResetShort(stat.resets_at)}`}
            </span>
          )}
      </>
    </span>
  );
}

function Footer({ onOpenUsageSettings }: { onOpenUsageSettings: () => void }) {
  const loginByProvider = useCliLoginStore((state) => state.byProvider);
  const startLogin = useCliLoginStore((state) => state.start);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Logins made outside the app are picked up by the backend live-sync watcher
  // and registered automatically, so the footer offers no capture button.
  const loginProvider =
    PROVIDER_ORDER.find((provider) => loginByProvider[provider]) ?? null;
  const loginEntry = loginProvider ? loginByProvider[loginProvider] : null;
  const loginInProgress = loginEntry !== null;

  useEffect(() => {
    if (loginEntry?.stage !== "waiting") return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [loginEntry?.stage]);

  useEffect(() => {
    if (loginInProgress) setAddMenuOpen(false);
  }, [loginInProgress]);

  return (
    <footer
      style={{
        display: "grid",
        gap: "var(--cmux-space-2)",
        padding: "var(--cmux-space-3) var(--cmux-space-5)",
        borderTop: "1px solid var(--cmux-border-hairline)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--cmux-space-4)",
        }}
      >
        <div
          style={{
            position: "relative",
            display: "flex",
            gap: "var(--cmux-space-2)",
          }}
        >
          <button
            type="button"
            onClick={() => setAddMenuOpen((open) => !open)}
            disabled={loginInProgress}
            aria-haspopup="menu"
            aria-expanded={addMenuOpen}
            style={{ ...panelButtonStyle, opacity: loginInProgress ? 0.6 : 1 }}
          >
            {loginEntry
              ? loginEntry.stage === "waiting"
                ? `ログイン待機中… ${loginRemainingLabel(loginEntry.startedAt, nowMs)}`
                : loginEntry.stage === "capturing"
                  ? "登録中…"
                  : "ログイン画面を開いています…"
              : "+ アカウントを追加"}
          </button>
          {/* The abort control comes from the shared component so both panels
              agree on when it is offered; the stage text is suppressed because
              the button beside it already shows it. */}
          {loginProvider && (
            <CliLoginProgress provider={loginProvider} compact />
          )}
          {addMenuOpen && !loginInProgress && (
            <div
              role="menu"
              aria-label="追加するアカウントの種類"
              style={{
                position: "absolute",
                bottom: "100%",
                left: 0,
                marginBottom: 4,
                display: "grid",
                gap: 2,
                padding: 4,
                minWidth: 200,
                background: "var(--cmux-popover)",
                border: "1px solid var(--cmux-border)",
                borderRadius: "var(--cmux-radius-sm)",
                boxShadow: "var(--cmux-shadow-popover)",
                zIndex: 110,
              }}
            >
              {PROVIDER_ORDER.map((provider) => (
                <button
                  key={provider}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAddMenuOpen(false);
                    void startLogin(provider, "new");
                  }}
                  style={{
                    ...panelButtonStyle,
                    border: 0,
                    background: "none",
                    textAlign: "left",
                  }}
                >
                  {addAccountLabel(provider)}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onOpenUsageSettings}
          style={panelButtonStyle}
        >
          ⚙ 詳細
        </button>
      </div>
    </footer>
  );
}

function Dismissable({
  color,
  onDismiss,
  children,
}: {
  color: string;
  onDismiss: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: "var(--cmux-space-2)",
        color,
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>{children}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="この通知を閉じる"
        title="閉じる"
        style={{
          border: 0,
          background: "none",
          color: "inherit",
          cursor: "pointer",
          padding: 0,
          font: "inherit",
        }}
      >
        ×
      </button>
    </div>
  );
}

const panelButtonStyle = {
  padding: "3px var(--cmux-space-4)",
  border: "1px solid var(--cmux-border)",
  borderRadius: "var(--cmux-radius-sm)",
  background: "var(--cmux-surface-raised)",
  color: "var(--cmux-text-secondary)",
  cursor: "pointer",
  fontSize: "var(--cmux-font-size-xs)",
  fontFamily: "inherit",
} as const;
