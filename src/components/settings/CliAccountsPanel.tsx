import { useState } from "react";
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

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function formatDate(value: string | null): string {
  if (!value) return "-";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : dateFormatter.format(parsed);
}

export function CliAccountsPanel() {
  const lastError = useCliAccountStore((state) => state.lastError);
  const lastSwitchResult = useCliAccountStore((state) => state.lastSwitchResult);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, fontSize: 12 }}>
      <div style={{ color: "var(--cmux-text-dim)", fontSize: 11 }}>
        CLI (claude / codex コマンド) が今どのアカウントでログインしているかを表示し、
        登録済みアカウントへ切り替えます。切り替えは PC 全体に効きます (新しく起動する
        セッションから反映)。切り替え前には認証ファイルを自動バックアップします。
      </div>

      {PROVIDER_ORDER.map((provider) => (
        <ProviderPanel key={provider} provider={provider} />
      ))}

      {lastError && (
        <div style={{ color: "var(--cmux-usage-danger)", fontSize: 11 }}>{lastError}</div>
      )}
      {lastSwitchResult && (
        <div style={{ color: "var(--cmux-text-dim)", fontSize: 11 }}>
          直近の切り替え: {lastSwitchResult.profile.label}
          {lastSwitchResult.warnings.length > 0 && (
            <span style={{ color: "var(--cmux-usage-warn)" }}>
              {" "}
              ({lastSwitchResult.warnings.join(" / ")})
            </span>
          )}
          <div>バックアップ: {lastSwitchResult.backup_dir}</div>
        </div>
      )}

      <div
        style={{
          fontSize: 11,
          color: "var(--cmux-text-dim)",
          borderTop: "1px solid var(--cmux-border)",
          paddingTop: 10,
        }}
      >
        注意: 登録は「CLI で通常ログインした状態」をスナップショット保存する方式です。
        アカウントを追加するには、先に <code>claude /login</code> または{" "}
        <code>codex login</code> で対象アカウントにログインしてから「現在のログインを
        登録/更新」を押してください。Codex の切り替えは auth.json 全体を入れ替えるため、
        OPENAI_API_KEY を手動設定している場合はそれも切り替わります (切り替え前の内容は
        バックアップに残ります)。
      </div>
    </div>
  );
}

function ProviderPanel({ provider }: { provider: CliProvider }) {
  // Stable-reference selectors; derive per-provider views outside (see
  // CliAccountMenu.tsx for the rationale).
  const allLive = useCliAccountStore((state) => state.live);
  const allProfiles = useCliAccountStore((state) => state.profiles);
  const live = liveForProvider(allLive, provider);
  const profiles = allProfiles.filter((profile) => profile.provider === provider);
  const busyProfileId = useCliAccountStore((state) => state.busyProfileId);
  const capture = useCliAccountStore((state) => state.capture);
  const anyBusy = busyProfileId !== null;
  const captureBusyKey = `capture:${provider}`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span style={{ fontWeight: 700 }}>{PROVIDER_TITLE[provider]}</span>
        <span style={{ color: "var(--cmux-text-tertiary)", fontSize: 11 }}>
          {live?.error
            ? `読み取りエラー: ${live.error}`
            : live?.present
              ? `ログイン中: ${live.email ?? live.identity_key ?? "(不明)"}${live.matched_profile_id ? "" : " (未登録)"}`
              : "未ログイン"}
        </span>
      </div>

      {profiles.length === 0 && (
        <div style={{ color: "var(--cmux-text-dim)", fontSize: 11 }}>登録済みアカウントはありません</div>
      )}

      {profiles.map((profile) => (
        <ProfileRow
          key={profile.id}
          profile={profile}
          active={live?.matched_profile_id === profile.id}
        />
      ))}

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

function ProfileRow({ profile, active }: { profile: CliAccountProfile; active: boolean }) {
  const busyProfileId = useCliAccountStore((state) => state.busyProfileId);
  const switchTo = useCliAccountStore((state) => state.switchTo);
  const remove = useCliAccountStore((state) => state.remove);
  const rename = useCliAccountStore((state) => state.rename);
  const paneMetadata = usePaneMetadataStore((state) => state.metadata);
  const [editing, setEditing] = useState(false);
  const [labelDraft, setLabelDraft] = useState(profile.label);
  const anyBusy = busyProfileId !== null;

  const handleSwitch = async () => {
    if (anyBusy || active || profile.needs_relogin) return;
    const count = runningAgentCounts(paneMetadata)[profile.provider];
    const warning = switchWarningText(count, profile.provider);
    if (warning && !window.confirm(warning)) return;
    await switchTo(profile.provider, profile.id);
  };

  const handleDelete = async () => {
    if (anyBusy) return;
    if (!window.confirm(`「${profile.label}」の登録とスナップショットを削除します。よろしいですか？`)) return;
    await remove(profile.id);
  };

  const handleRename = async () => {
    const trimmed = labelDraft.trim();
    if (!trimmed || trimmed === profile.label) {
      setEditing(false);
      setLabelDraft(profile.label);
      return;
    }
    const ok = await rename(profile.id, trimmed);
    if (ok) setEditing(false);
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "5px 8px",
        borderRadius: 4,
        border: "1px solid var(--cmux-border-hairline)",
        background: active ? "var(--cmux-bg-hover, rgba(127,127,127,0.12))" : "none",
      }}
    >
      <span style={{ width: 12, flexShrink: 0 }}>{active ? "✓" : ""}</span>

      <div style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 1 }}>
        {editing ? (
          <span style={{ display: "flex", gap: 4 }}>
            <input
              value={labelDraft}
              onChange={(event) => setLabelDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleRename();
                if (event.key === "Escape") {
                  setEditing(false);
                  setLabelDraft(profile.label);
                }
              }}
              autoFocus
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 12,
                fontFamily: "inherit",
                background: "var(--cmux-bg)",
                color: "var(--cmux-text)",
                border: "1px solid var(--cmux-border)",
                borderRadius: 3,
                padding: "1px 4px",
              }}
            />
            <RowButton label="保存" onClick={() => void handleRename()} disabled={anyBusy} />
          </span>
        ) : (
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {profile.label}
            {profile.needs_relogin && (
              <span style={{ color: "var(--cmux-usage-warn)", marginLeft: 6, fontSize: 10 }}>要再ログイン</span>
            )}
          </span>
        )}
        <span style={{ color: "var(--cmux-text-tertiary)", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {[profile.email, profile.plan, `登録: ${formatDate(profile.captured_at)}`]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>

      <span style={{ display: "flex", gap: 4, flexShrink: 0 }}>
        {!active && (
          <RowButton
            label={busyProfileId === profile.id ? "切替中…" : "切り替え"}
            onClick={() => void handleSwitch()}
            disabled={anyBusy || profile.needs_relogin}
          />
        )}
        {!editing && <RowButton label="名前" onClick={() => setEditing(true)} disabled={anyBusy} />}
        <RowButton label="削除" onClick={() => void handleDelete()} disabled={anyBusy} danger />
      </span>
    </div>
  );
}

function RowButton({
  label,
  onClick,
  disabled,
  danger = false,
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "2px 7px",
        borderRadius: 3,
        border: "1px solid var(--cmux-border)",
        background: "none",
        color: danger ? "var(--cmux-usage-danger)" : "var(--cmux-text-secondary)",
        cursor: disabled ? "default" : "pointer",
        fontSize: 11,
        fontFamily: "inherit",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {label}
    </button>
  );
}
