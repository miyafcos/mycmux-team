import { useEffect, useRef } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { useCliAccountStore } from "../../stores/cliAccountStore";
import { usePaneMetadataStore } from "../../stores/paneMetadataStore";
import type { CliAccountProfile, CliProvider } from "../../lib/ipc";
import {
  PROVIDER_ORDER,
  PROVIDER_TITLE,
  canSwitchCliAccount,
  cliAccountMessage,
  executeCliAccountSwitch,
  liveForProvider,
  orderCliAccountProfiles,
  runningAgentCounts,
  runningAgentPaneDetails,
  switchWarningText,
} from "../../lib/cliAccounts";

type CliAccountMenuProps = {
  closing?: boolean;
  onClose: () => void;
};

export function CliAccountMenu({ closing = false, onClose }: CliAccountMenuProps) {
  const fetchError = useCliAccountStore((state) => state.fetchError);
  const operationError = useCliAccountStore((state) => state.operationError);
  const lastSwitchResult = useCliAccountStore((state) => state.lastSwitchResult);
  const dismissOperationError = useCliAccountStore((state) => state.dismissOperationError);
  const dismissSwitchWarnings = useCliAccountStore((state) => state.dismissSwitchWarnings);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (closing) return;
    const frame = window.requestAnimationFrame(() => {
      const firstButton = menuRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])");
      (firstButton ?? menuRef.current)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [closing]);

  return (
    <div
      id="cli-account-menu"
      ref={menuRef}
      role="dialog"
      aria-label="CLI ログインアカウント"
      tabIndex={-1}
      className={`cmux-popover-panel${closing ? " is-closing" : ""}`}
      inert={closing ? true : undefined}
      aria-hidden={closing ? true : undefined}
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
          borderBottom: "1px solid var(--cmux-border-hairline)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 700 }}>CLI ログイン</span>
        <span style={{ color: "var(--cmux-text-tertiary)", fontSize: 11 }}>クリックで切り替え</span>
      </div>
      <div style={{ padding: "6px 10px", color: "var(--cmux-text-dim)", fontSize: 10 }}>
        切り替えは新しく起動するセッションから反映されます。
      </div>

      <div
        style={{
          padding: "8px 10px",
          display: "grid",
          gap: 10,
          maxHeight: "min(420px, calc(100vh - 120px))",
          overflowY: "auto",
        }}
      >
        {PROVIDER_ORDER.map((provider) => (
          <ProviderSection key={provider} provider={provider} onClose={onClose} />
        ))}
      </div>

      {(fetchError || operationError || (lastSwitchResult && lastSwitchResult.warnings.length > 0)) && (
        <div
          style={{
            padding: "6px 10px",
            borderTop: "1px solid var(--cmux-border-hairline)",
            fontSize: 11,
            display: "grid",
            gap: 2,
          }}
        >
          {fetchError && <DismissibleNotice color="var(--cmux-usage-danger)" text={fetchError} />}
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
    </div>
  );
}

function ProviderSection({ provider, onClose }: { provider: CliProvider; onClose: () => void }) {
  // Select stable references only; deriving (find/filter) inside the selector
  // would return a fresh value every run and re-render unconditionally.
  const allLive = useCliAccountStore((state) => state.live);
  const allProfiles = useCliAccountStore((state) => state.profiles);
  const live = liveForProvider(allLive, provider);
  const profiles = orderCliAccountProfiles(allProfiles.filter((profile) => profile.provider === provider));
  const busyProfileId = useCliAccountStore((state) => state.busyByProvider[provider]);
  const switchTo = useCliAccountStore((state) => state.switchTo);
  const capture = useCliAccountStore((state) => state.capture);
  const paneMetadata = usePaneMetadataStore((state) => state.metadata);

  const captureBusyKey = `capture:${provider}`;
  const providerBusy = busyProfileId !== null;
  const liveUnregistered = Boolean(live?.present && !live.error && !live.matched_profile_id);

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
    <div style={{ display: "grid", gap: 4 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <span style={{ fontWeight: 700, fontSize: 11 }}>{PROVIDER_TITLE[provider]}</span>
        <span
          style={{
            color: "var(--cmux-text-tertiary)",
            fontSize: 11,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: 170,
          }}
          title={live?.email ?? undefined}
        >
          {live?.error ? "読み取りエラー" : live?.present ? (live.email ?? live.identity_key ?? "") : "未ログイン"}
        </span>
      </div>

      {live?.error && (
        <div style={{ color: "var(--cmux-usage-danger)", fontSize: 10 }}>
          {cliAccountMessage(live.error)}
        </div>
      )}

      {profiles.length === 0 && (
        <div style={{ color: "var(--cmux-text-dim)", fontSize: 11 }}>
          {live?.present
            ? "登録済みアカウントはありません。下のボタンで現在のログインを登録してください。"
            : "先にターミナルでログインしてください。ログイン後にこのメニューを開き直すと登録できます。"}
        </div>
      )}

      {profiles.map((profile) => {
        const isActive = live?.matched_profile_id === profile.id;
        const isBusy = busyProfileId === profile.id;
        const disabled = providerBusy || profile.needs_relogin || isActive;
        return (
          <button
            key={profile.id}
            onClick={() => void handleSwitch(profile, isActive)}
            disabled={disabled}
            title={profile.email ?? profile.identity_key}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "4px 6px",
              borderRadius: 4,
              border: "1px solid var(--cmux-border-hairline)",
              background: isActive ? "var(--cmux-bg-hover, rgba(127,127,127,0.12))" : "none",
              color: profile.needs_relogin ? "var(--cmux-text-dim)" : "var(--cmux-text)",
              cursor: disabled ? "default" : "pointer",
              textAlign: "left",
              fontSize: 12,
              fontFamily: "inherit",
            }}
          >
            <span style={{ width: 12, flexShrink: 0 }}>{isActive ? "✓" : ""}</span>
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
              {profile.label}
            </span>
            {profile.plan && (
              <span style={{ color: "var(--cmux-text-tertiary)", fontSize: 10, flexShrink: 0 }}>{profile.plan}</span>
            )}
            {profile.needs_relogin && (
              <span
                style={{ color: "var(--cmux-usage-warn)", fontSize: 10, flexShrink: 0 }}
                title="CLIで再ログイン後、現在のログインを登録/更新してください"
              >
                要再ログイン
              </span>
            )}
            {isBusy && (
              <span style={{ color: "var(--cmux-text-tertiary)", fontSize: 10, flexShrink: 0 }}>切替中…</span>
            )}
          </button>
        );
      })}

      {profiles.some((profile) => profile.needs_relogin) && (
        <div style={{ color: "var(--cmux-usage-warn)", fontSize: 10 }}>
          CLIで再ログインした後、「現在のログインを登録/更新」を押してください。
        </div>
      )}

      {liveUnregistered && (
        <div style={{ color: "var(--cmux-usage-warn)", fontSize: 11 }}>現在のログインは未登録です</div>
      )}

      <button
        onClick={() => void capture(provider)}
        disabled={providerBusy || !live?.present}
        style={{
          alignSelf: "start",
          padding: "3px 8px",
          borderRadius: 4,
          border: "1px solid var(--cmux-border)",
          background: "none",
          color: live?.present ? "var(--cmux-text-secondary)" : "var(--cmux-text-dim)",
          cursor: providerBusy || !live?.present ? "default" : "pointer",
          fontSize: 11,
          fontFamily: "inherit",
        }}
      >
        {busyProfileId === captureBusyKey
          ? "登録中…"
          : live?.present ? "現在のログインを登録/更新" : "先にログインが必要です"}
      </button>
    </div>
  );
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
