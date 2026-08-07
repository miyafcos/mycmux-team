import { useCliAccountStore } from "../../stores/cliAccountStore";
import { usePaneMetadataStore } from "../../stores/paneMetadataStore";
import type { CliAccountProfile, CliProvider } from "../../lib/ipc";
import {
  PROVIDER_ORDER,
  PROVIDER_TITLE,
  liveForProvider,
  runningAgentCounts,
  switchWarningText,
} from "../../lib/cliAccounts";

type CliAccountMenuProps = {
  closing?: boolean;
  onClose: () => void;
};

export function CliAccountMenu({ closing = false, onClose }: CliAccountMenuProps) {
  const lastError = useCliAccountStore((state) => state.lastError);
  const lastSwitchResult = useCliAccountStore((state) => state.lastSwitchResult);

  return (
    <div
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

      {(lastError || (lastSwitchResult && lastSwitchResult.warnings.length > 0)) && (
        <div
          style={{
            padding: "6px 10px",
            borderTop: "1px solid var(--cmux-border-hairline)",
            fontSize: 11,
            display: "grid",
            gap: 2,
          }}
        >
          {lastError && <div style={{ color: "var(--cmux-usage-danger)" }}>{lastError}</div>}
          {lastSwitchResult?.warnings.map((warning) => (
            <div key={warning} style={{ color: "var(--cmux-usage-warn)" }}>
              {warning}
            </div>
          ))}
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
  const profiles = allProfiles.filter((profile) => profile.provider === provider);
  const busyProfileId = useCliAccountStore((state) => state.busyProfileId);
  const switchTo = useCliAccountStore((state) => state.switchTo);
  const capture = useCliAccountStore((state) => state.capture);
  const paneMetadata = usePaneMetadataStore((state) => state.metadata);

  const captureBusyKey = `capture:${provider}`;
  const anyBusy = busyProfileId !== null;
  const liveUnregistered = Boolean(live?.present && !live.error && !live.matched_profile_id);

  const handleSwitch = async (profile: CliAccountProfile) => {
    if (anyBusy || profile.needs_relogin) return;
    const count = runningAgentCounts(paneMetadata)[provider];
    const warning = switchWarningText(count, provider);
    if (warning && !window.confirm(warning)) return;
    const result = await switchTo(provider, profile.id);
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

      {profiles.length === 0 && (
        <div style={{ color: "var(--cmux-text-dim)", fontSize: 11 }}>登録済みアカウントはありません</div>
      )}

      {profiles.map((profile) => {
        const isActive = live?.matched_profile_id === profile.id;
        const isBusy = busyProfileId === profile.id;
        const disabled = anyBusy || profile.needs_relogin || isActive;
        return (
          <button
            key={profile.id}
            onClick={() => void handleSwitch(profile)}
            disabled={disabled && !isActive}
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
              <span style={{ color: "var(--cmux-usage-warn)", fontSize: 10, flexShrink: 0 }}>要再ログイン</span>
            )}
            {isBusy && (
              <span style={{ color: "var(--cmux-text-tertiary)", fontSize: 10, flexShrink: 0 }}>切替中…</span>
            )}
          </button>
        );
      })}

      {liveUnregistered && (
        <div style={{ color: "var(--cmux-usage-warn)", fontSize: 11 }}>現在のログインは未登録です</div>
      )}

      <button
        onClick={() => void capture(provider)}
        disabled={anyBusy || !live?.present}
        style={{
          alignSelf: "start",
          padding: "3px 8px",
          borderRadius: 4,
          border: "1px solid var(--cmux-border)",
          background: "none",
          color: live?.present ? "var(--cmux-text-secondary)" : "var(--cmux-text-dim)",
          cursor: anyBusy || !live?.present ? "default" : "pointer",
          fontSize: 11,
          fontFamily: "inherit",
        }}
      >
        {busyProfileId === captureBusyKey ? "登録中…" : "現在のログインを登録/更新"}
      </button>
    </div>
  );
}
