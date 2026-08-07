import { useEffect, useRef } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import type { CliAccountProfile, CliProvider } from "../../lib/ipc";
import {
  PROVIDER_ORDER,
  PROVIDER_TITLE,
  canSwitchCliAccount,
  cliAccountMessage,
  executeCliAccountSwitch,
  liveForProvider,
  runningAgentCounts,
  runningAgentPaneDetails,
  switchWarningText,
} from "../../lib/cliAccounts";
import {
  accountNoticeMessage,
  type UnifiedAccount,
  type UnifiedAccountsView,
  type UsageFacet,
} from "../../lib/unifiedAccounts";
import { useCliAccountStore } from "../../stores/cliAccountStore";
import { usePaneMetadataStore } from "../../stores/paneMetadataStore";
import { useUsageStore } from "../../stores/usageStore";
import { formatDate, UsageRow, UsageSection } from "./UsagePopover";

type AccountsPanelProps = {
  closing?: boolean;
  view: UnifiedAccountsView;
  onClose: () => void;
  onOpenUsageManagement: (accountId?: string) => void;
};

export function AccountsPanel({
  closing = false,
  view,
  onClose,
  onOpenUsageManagement,
}: AccountsPanelProps) {
  const fetchError = useCliAccountStore((state) => state.fetchError);
  const operationError = useCliAccountStore((state) => state.operationError);
  const lastSwitchResult = useCliAccountStore((state) => state.lastSwitchResult);
  const dismissOperationError = useCliAccountStore((state) => state.dismissOperationError);
  const dismissSwitchWarnings = useCliAccountStore((state) => state.dismissSwitchWarnings);
  const summary = useUsageStore((state) => state.summary);
  const summaryError = useUsageStore((state) => state.lastError);
  const accountsError = useUsageStore((state) => state.accountsError);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (closing) return;
    const frame = window.requestAnimationFrame(() => {
      const firstButton = menuRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])");
      (firstButton ?? menuRef.current)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [closing]);

  const usageTimestamps = [summary?.generated_at ?? "", ...view.rows
    .map((row) => row.usage.source === "none" ? "" : row.usage.fetchedAt)
  ]
    .filter(Boolean)
    .sort();
  const updatedAt = usageTimestamps[usageTimestamps.length - 1] ?? "";

  return (
    <div
      id="accounts-panel"
      ref={menuRef}
      role="dialog"
      aria-label="アカウントと使用量"
      tabIndex={-1}
      className={`cmux-popover-panel${closing ? " is-closing" : ""}`}
      inert={closing ? true : undefined}
      aria-hidden={closing ? true : undefined}
      style={{
        position: "absolute",
        top: "100%",
        right: 0,
        marginTop: 4,
        width: 430,
        maxWidth: "min(430px, calc(100vw - 16px))",
        maxHeight: "min(620px, calc(100vh - 56px))",
        overflowX: "hidden",
        overflowY: "auto",
        background: "var(--cmux-popover)",
        border: "1px solid var(--cmux-border)",
        borderRadius: 6,
        zIndex: 100,
        boxShadow: "var(--cmux-shadow-popover)",
        fontSize: 12,
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        color: "var(--cmux-text)",
      }}
    >
      <div
        style={{
          padding: "8px 10px",
          borderBottom: "1px solid var(--cmux-border-hairline)",
          display: "flex",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 700 }}>アカウントと使用量</span>
        <span style={{ color: "var(--cmux-text-tertiary)", fontSize: 11 }}>クリックで切り替え</span>
      </div>

      <div
        style={{
          padding: "8px 10px",
          display: "grid",
          gap: 12,
        }}
      >
        {PROVIDER_ORDER.map((provider) => (
          <ProviderSection
            key={provider}
            provider={provider}
            rows={view.rows.filter((row) => row.provider === provider)}
            onClose={onClose}
            onOpenUsageManagement={onOpenUsageManagement}
          />
        ))}

        {view.unattributedSummary.map((entry) => (
          <div key={entry.provider} style={{ color: "var(--cmux-usage-warn)", fontSize: 11 }}>
            {PROVIDER_TITLE[entry.provider]}: {accountNoticeMessage("summary_unattributed")}
          </div>
        ))}
      </div>

      {(fetchError || operationError || summaryError || accountsError ||
        (lastSwitchResult && lastSwitchResult.warnings.length > 0)) && (
        <div
          style={{
            padding: "6px 10px",
            borderTop: "1px solid var(--cmux-border-hairline)",
            fontSize: 11,
            display: "grid",
            gap: 3,
          }}
        >
          {fetchError && <DismissibleNotice color="var(--cmux-usage-danger)" text={fetchError} />}
          {summaryError && <DismissibleNotice color="var(--cmux-usage-danger)" text={summaryError} />}
          {accountsError && <DismissibleNotice color="var(--cmux-usage-danger)" text={accountsError} />}
          {operationError && (
            <DismissibleNotice
              color="var(--cmux-usage-danger)"
              text={operationError}
              onDismiss={dismissOperationError}
            />
          )}
          {lastSwitchResult && lastSwitchResult.warnings.length > 0 && (
            <DismissibleNotice
              color="var(--cmux-usage-warn)"
              text={lastSwitchResult.warnings.map(cliAccountMessage).join(" ")}
              onDismiss={dismissSwitchWarnings}
            />
          )}
        </div>
      )}

      <div
        style={{
          padding: "7px 10px",
          borderTop: "1px solid var(--cmux-border-hairline)",
          display: "grid",
          gap: 5,
          color: "var(--cmux-text-tertiary)",
          fontSize: 11,
        }}
      >
        <div>切り替えは新しく起動するセッションから反映されます。</div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <span>更新 {formatDate(updatedAt)}</span>
          <button
            type="button"
            onClick={() => onOpenUsageManagement()}
            style={footerButtonStyle}
          >
            設定で管理
          </button>
        </div>
      </div>
    </div>
  );
}

function ProviderSection({
  provider,
  rows,
  onClose,
  onOpenUsageManagement,
}: {
  provider: CliProvider;
  rows: UnifiedAccount[];
  onClose: () => void;
  onOpenUsageManagement: (accountId?: string) => void;
}) {
  const busyProfileId = useCliAccountStore((state) => state.busyByProvider[provider]);
  const switchTo = useCliAccountStore((state) => state.switchTo);
  const capture = useCliAccountStore((state) => state.capture);
  const allLive = useCliAccountStore((state) => state.live);
  const paneMetadata = usePaneMetadataStore((state) => state.metadata);
  const live = liveForProvider(allLive, provider);
  const captureBusyKey = `capture:${provider}`;
  const providerBusy = busyProfileId !== null;

  const handleSwitch = async (profile: CliAccountProfile, isActive: boolean) => {
    if (isActive) return;
    if (!canSwitchCliAccount(isActive, providerBusy, profile.needs_relogin)) return;
    const count = runningAgentCounts(paneMetadata)[provider];
    const paneDetails = runningAgentPaneDetails(paneMetadata, provider);
    const warning = switchWarningText(count, provider, profile.label, paneDetails);
    const result = await executeCliAccountSwitch(
      isActive,
      providerBusy,
      profile.needs_relogin,
      () => confirm(warning, {
        title: "CLI アカウントを切り替える",
        kind: "warning",
        okLabel: "切り替える",
        cancelLabel: "キャンセル",
      }).catch(() => false),
      () => switchTo(provider, profile.id),
    );
    if (result && result.warnings.length === 0) onClose();
  };

  return (
    <section style={{ display: "grid", gap: 7 }} aria-label={PROVIDER_TITLE[provider]}>
      <div style={{ fontWeight: 700, fontSize: 11 }}>{PROVIDER_TITLE[provider]}</div>

      {rows.length === 0 && (
        <div style={{ color: "var(--cmux-text-dim)", fontSize: 11 }}>アカウント情報がありません。</div>
      )}

      {rows.map((row) => {
        const profile = row.cli.source === "profile" ? row.cli.profile : null;
        const possiblyActive = row.cli.source !== "none" && row.cli.possiblyActive;
        const isActive = row.cli.source !== "none" && (row.cli.active || possiblyActive);
        const isBusy = profile ? busyProfileId === profile.id : false;
        const disabled = providerBusy || Boolean(profile?.needs_relogin) || isActive;
        const plan = row.cli.source === "profile"
          ? row.cli.profile.plan
          : row.cli.source === "live" ? row.cli.live.plan : null;

        return (
          <UsageSection
            key={row.key}
            title={row.email ?? row.label}
            badge={plan ? { text: plan, color: "var(--cmux-text-tertiary)" } : null}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <span style={{ color: isActive ? "var(--cmux-text)" : "var(--cmux-text-dim)", fontSize: 11 }}>
                {isActive ? (possiblyActive ? "✓ 使用中の可能性" : "✓ 使用中") : row.cli.source === "none" ? "CLI 未登録" : "登録済み"}
              </span>
              {profile && !isActive && (
                <button
                  type="button"
                  onClick={() => void handleSwitch(profile, isActive)}
                  disabled={disabled}
                  style={rowButtonStyle(disabled)}
                >
                  {isBusy ? "切替中…" : "切り替える"}
                </button>
              )}
            </div>

            {profile?.needs_relogin && (
              <div style={{ color: "var(--cmux-usage-warn)", fontSize: 10 }}>
                要再ログイン。CLIで再ログイン後、「現在のログインを登録/更新」を押してください。
              </div>
            )}

            {row.usage.source !== "none" && (
              <div style={{ display: "grid", gap: 4 }}>
                <div style={{ color: "var(--cmux-text-tertiary)", fontSize: 10 }}>
                  {usageSourceLabel(row.usage.source)}
                  {row.usage.source === "oauth-account" && !row.usage.enabled ? "（無効）" : ""}
                </div>
                {row.usage.source === "oauth-account" && row.usage.needsReauth ? (
                  <button
                    type="button"
                    onClick={() => onOpenUsageManagement(row.usage.source === "oauth-account" ? row.usage.accountId : undefined)}
                    style={{ ...footerButtonStyle, justifySelf: "start" }}
                  >
                    再認証
                  </button>
                ) : null}
                {row.usage.error && (
                  <div style={{ color: "var(--cmux-usage-danger)", fontSize: 11 }}>{row.usage.error}</div>
                )}
                {!(row.usage.source === "oauth-account" && (!row.usage.enabled || row.usage.needsReauth)) && (
                  <>
                    <UsageRow label="5h" stat={row.usage.windows.five_hour} />
                    <UsageRow label="7d" stat={row.usage.windows.seven_day} />
                    {provider === "claude" && (
                      <>
                        <UsageRow label="7d Sonnet" stat={row.usage.windows.seven_day_sonnet} />
                        <UsageRow label="7d Opus" stat={row.usage.windows.seven_day_opus} />
                      </>
                    )}
                  </>
                )}
              </div>
            )}

            {row.notices.map((notice) => (
              <div key={notice} style={{ color: "var(--cmux-text-dim)", fontSize: 10 }}>
                ⓘ {accountNoticeMessage(notice)}
              </div>
            ))}
          </UsageSection>
        );
      })}

      <button
        type="button"
        onClick={() => void capture(provider)}
        disabled={providerBusy || !live?.present}
        style={{ ...footerButtonStyle, justifySelf: "start", opacity: providerBusy || !live?.present ? 0.6 : 1 }}
      >
        {busyProfileId === captureBusyKey
          ? "登録中…"
          : live?.present ? "現在のログインを登録/更新" : "先にログインが必要です"}
      </button>
    </section>
  );
}

export function usageSourceLabel(source: UsageFacet["source"]): string {
  if (source === "cli-live") return "CLI 使用量";
  if (source === "oauth-account") return "使用量登録";
  return "使用量なし";
}

function DismissibleNotice({
  text,
  color,
  onDismiss,
}: {
  text: string;
  color: string;
  onDismiss?: () => void;
}) {
  return (
    <div style={{ color, display: "flex", alignItems: "start", gap: 6 }}>
      <span style={{ flex: 1 }}>{text}</span>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="この通知を閉じる"
          title="閉じる"
          style={{ border: 0, background: "none", color: "inherit", cursor: "pointer", padding: 0 }}
        >
          ×
        </button>
      )}
    </div>
  );
}

function rowButtonStyle(disabled: boolean) {
  return {
    padding: "3px 8px",
    borderRadius: 4,
    border: "1px solid var(--cmux-border)",
    background: "none",
    color: "var(--cmux-text-secondary)",
    cursor: disabled ? "default" : "pointer",
    fontSize: 11,
    fontFamily: "inherit",
    opacity: disabled ? 0.6 : 1,
  } as const;
}

const footerButtonStyle = {
  padding: "3px 8px",
  borderRadius: 4,
  border: "1px solid var(--cmux-border)",
  background: "none",
  color: "var(--cmux-text-secondary)",
  cursor: "pointer",
  fontSize: 11,
  fontFamily: "inherit",
} as const;
