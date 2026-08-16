import { useEffect, useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { CliLoginProgress } from "../common/CliLoginProgress";
import { useCliAccountStore } from "../../stores/cliAccountStore";
import { useCliLoginStore } from "../../stores/cliLoginStore";
import { useToastStore } from "../../stores/toastStore";
import { usePaneMetadataStore } from "../../stores/paneMetadataStore";
import { revealInExplorer, type CliAccountProfile, type CliOrphanSnapshot, type CliProvider } from "../../lib/ipc";
import {
  PROVIDER_ORDER,
  PROVIDER_TITLE,
  addAccountLabel,
  canSwitchCliAccount,
  cliAccountProfileActivity,
  cliAccountMessage,
  executeCliAccountSwitch,
  liveForProvider,
  orderCliAccountProfiles,
  runningAgentCounts,
  runningAgentPaneDetails,
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

function formatLastSwitched(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "切替履歴なし";
  return `最終切替: ${formatDate(value)}`;
}

export function CliAccountsPanel() {
  const fetchError = useCliAccountStore((state) => state.fetchError);
  const operationError = useCliAccountStore((state) => state.operationError);
  const lastSwitchResult = useCliAccountStore((state) => state.lastSwitchResult);
  const orphans = useCliAccountStore((state) => state.orphans);
  const backupRoot = useCliAccountStore((state) => state.backupRoot);
  const fetchAccounts = useCliAccountStore((state) => state.fetch);
  const dismissOperationError = useCliAccountStore((state) => state.dismissOperationError);
  const dismissSwitchWarnings = useCliAccountStore((state) => state.dismissSwitchWarnings);

  useEffect(() => {
    void fetchAccounts();
  }, [fetchAccounts]);

  const openBackup = async (path?: string) => {
    const target = path ?? lastSwitchResult?.backup_dir ?? backupRoot;
    if (!target) return;
    try {
      await revealInExplorer(target);
    } catch {
      useToastStore.getState().pushToast(
        `原因: バックアップフォルダーを開けませんでした。次にすること: エクスプローラーで「${target}」を開いてください。`,
        "warning",
      );
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, fontSize: 12 }}>
      <div style={{ color: "var(--cmux-text-dim)", fontSize: 11 }}>
        CLI (claude / codex コマンド) が今どのアカウントでログインしているかを表示し、
        登録済みアカウントへ切り替えます。切り替えは PC 全体に効きます (新しく起動する
        セッションから反映)。切り替え前には認証ファイルを自動バックアップします。
      </div>

      <AddAccountSection />

      {PROVIDER_ORDER.map((provider) => (
        <ProviderPanel key={provider} provider={provider} />
      ))}

      {orphans.length > 0 && <OrphanSnapshots orphans={orphans} />}

      {fetchError && (
        <div style={{ color: "var(--cmux-usage-danger)", fontSize: 11 }}>{fetchError}</div>
      )}
      {operationError && (
        <div style={{ display: "grid", gap: 4 }}>
          <NoticeWithClose
            text={operationError}
            color="var(--cmux-usage-danger)"
            onClose={dismissOperationError}
          />
          {backupRoot && (
            <button type="button" onClick={() => void openBackup(backupRoot)} style={{ ...inlineButtonStyle, justifySelf: "start" }}>
              バックアップフォルダーを開く
            </button>
          )}
        </div>
      )}
      {lastSwitchResult && (
        <div style={{ color: "var(--cmux-text-dim)", fontSize: 11 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span>直近の切り替え: {lastSwitchResult.profile.label}</span>
            <button type="button" onClick={() => void openBackup()} style={inlineButtonStyle}>
              バックアップフォルダーを開く
            </button>
          </div>
          {lastSwitchResult.warnings.length > 0 && (
            <NoticeWithClose
              text={lastSwitchResult.warnings.map(cliAccountMessage).join(" ")}
              color="var(--cmux-usage-warn)"
              onClose={dismissSwitchWarnings}
            />
          )}
          <div title={lastSwitchResult.backup_dir}>バックアップ: {lastSwitchResult.backup_dir}</div>
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
        補足: 「現在のログインを登録/更新」は、すでに <code>claude /login</code> または{" "}
        <code>codex login</code> でログイン済みのアカウントを取り込むためのボタンです。
        Codex の切り替えは auth.json 全体を入れ替えるため、OPENAI_API_KEY を手動設定して
        いる場合はそれも切り替わります (切り替え前の内容はバックアップに残ります)。
      </div>
    </div>
  );
}

/**
 * The direct way to add an account: mycmux opens the CLI login in a pane with
 * its config directory pointed at a staging copy, so the account that is
 * currently logged in is never disturbed.
 */
function AddAccountSection() {
  const busyByProvider = useCliAccountStore((state) => state.busyByProvider);
  const loginByProvider = useCliLoginStore((state) => state.byProvider);
  const startLogin = useCliLoginStore((state) => state.start);

  return (
    <section style={{ display: "grid", gap: 6 }} aria-label="アカウントの追加">
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {PROVIDER_ORDER.map((provider) => (
          <button
            key={provider}
            type="button"
            onClick={() => void startLogin(provider, "new")}
            disabled={busyByProvider[provider] !== null}
            style={{
              ...inlineButtonStyle,
              opacity: busyByProvider[provider] !== null ? 0.6 : 1,
              cursor: busyByProvider[provider] !== null ? "default" : "pointer",
            }}
          >
            + {addAccountLabel(provider)}
          </button>
        ))}
      </div>
      {PROVIDER_ORDER.filter((provider) => loginByProvider[provider]).map((provider) => (
        <CliLoginProgress key={provider} provider={provider} />
      ))}
    </section>
  );
}

function ProviderPanel({ provider }: { provider: CliProvider }) {
  // Stable-reference selectors; derive per-provider views outside (see
  // CliAccountMenu.tsx for the rationale).
  const allLive = useCliAccountStore((state) => state.live);
  const allProfiles = useCliAccountStore((state) => state.profiles);
  const live = liveForProvider(allLive, provider);
  const profiles = orderCliAccountProfiles(allProfiles.filter((profile) => profile.provider === provider));
  const intendedActiveId = useCliAccountStore((state) => state.active[provider]);
  const fetchError = useCliAccountStore((state) => state.fetchError);
  const busyProfileId = useCliAccountStore((state) => state.busyByProvider[provider]);
  const capture = useCliAccountStore((state) => state.capture);
  const providerBusy = busyProfileId !== null;
  const captureBusyKey = `capture:${provider}`;
  const intendedProfile = intendedActiveId
    ? allProfiles.find((profile) => profile.id === intendedActiveId)
    : null;
  const intendedMismatch = Boolean(
    !fetchError
      && intendedActiveId
      && live
      && !live.error
      && intendedActiveId !== live.matched_profile_id,
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span style={{ fontWeight: 700 }}>{PROVIDER_TITLE[provider]}</span>
        <span style={{ color: "var(--cmux-text-tertiary)", fontSize: 11 }}>
          {live?.error
            ? cliAccountMessage(live.error)
            : live?.present
              ? `ログイン中: ${live.email ?? live.identity_key ?? "(不明)"}${live.matched_profile_id ? "" : " (未登録)"}`
              : "未ログイン"}
        </span>
      </div>

      {intendedMismatch && (
        <div style={{ color: "var(--cmux-usage-warn)", fontSize: 11 }}>
          前回選択: {intendedProfile?.label ?? "削除済みのアカウント"}（現在のログインと不一致）
        </div>
      )}

      {profiles.length === 0 && (
        <div style={{ color: "var(--cmux-text-dim)", fontSize: 11 }}>登録済みアカウントはありません</div>
      )}

      {profiles.map((profile) => {
        const activity = cliAccountProfileActivity(
          intendedActiveId,
          profile.id,
          live,
          fetchError,
        );
        return (
          <ProfileRow
            key={profile.id}
            profile={profile}
            active={activity.active}
            possiblyActive={activity.possiblyActive}
          />
        );
      })}

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
        {busyProfileId === captureBusyKey ? "登録中…" : "現在のログインを登録/更新"}
      </button>
    </div>
  );
}

function ProfileRow({
  profile,
  active,
  possiblyActive,
}: {
  profile: CliAccountProfile;
  active: boolean;
  possiblyActive: boolean;
}) {
  const busyProfileId = useCliAccountStore((state) => state.busyByProvider[profile.provider]);
  const switchTo = useCliAccountStore((state) => state.switchTo);
  const remove = useCliAccountStore((state) => state.remove);
  const rename = useCliAccountStore((state) => state.rename);
  const startLogin = useCliLoginStore((state) => state.start);
  const paneMetadata = usePaneMetadataStore((state) => state.metadata);
  const volatilePaneMetadata = usePaneMetadataStore((state) => state.volatileMetadata);
  const [editing, setEditing] = useState(false);
  const [labelDraft, setLabelDraft] = useState(profile.label);
  const providerBusy = busyProfileId !== null;

  const handleSwitch = async () => {
    if (!canSwitchCliAccount(active, providerBusy, profile.needs_relogin)) return;
    const count = runningAgentCounts(paneMetadata)[profile.provider];
    const paneDetails = runningAgentPaneDetails(paneMetadata, profile.provider, volatilePaneMetadata);
    const warning = switchWarningText(count, profile.provider, profile.label, paneDetails);
    await executeCliAccountSwitch(
      active,
      providerBusy,
      profile.needs_relogin,
      () =>
        confirm(warning, {
          title: "CLI アカウントを切り替える",
          kind: "warning",
          okLabel: "切り替える",
          cancelLabel: "キャンセル",
        }).catch(() => false),
      () => switchTo(profile.provider, profile.id),
    );
  };

  const handleDelete = async () => {
    if (providerBusy) return;
    const body = active
      ? `「${profile.label}」は現在ログイン中です。現在のログイン状態は変わりませんが、登録情報と保存済みスナップショットを削除します。別のアカウントへ切り替えた後は、この状態へ戻せません。この操作は取り消せません。`
      : possiblyActive
        ? `「${profile.label}」は前回選択されたアカウントですが、現在のログイン状態を確認できません。現在ログイン中の可能性があります。登録情報と保存済みスナップショットを削除すると、この状態へ戻せなくなります。この操作は取り消せません。`
        : `「${profile.label}」の登録情報と保存済みスナップショットを削除します。削除後はこのアカウントへ切り替えられず、この操作は取り消せません。`;
    const accepted = await confirm(body, {
      title: "CLI アカウントを削除する",
      kind: "warning",
      okLabel: "削除する",
      cancelLabel: "キャンセル",
    }).catch(() => false);
    if (!accepted) return;
    await remove(profile.provider, profile.id);
  };

  const handleRename = async () => {
    const trimmed = labelDraft.trim();
    if (!trimmed || trimmed === profile.label) {
      setEditing(false);
      setLabelDraft(profile.label);
      return;
    }
    const ok = await rename(profile.provider, profile.id, trimmed);
    if (ok) {
      setLabelDraft(trimmed);
      setEditing(false);
    }
  };

  const cancelRename = () => {
    setEditing(false);
    setLabelDraft(profile.label);
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
        background: active ? "var(--cmux-hover)" : "none",
      }}
    >
      <span style={{ width: 12, flexShrink: 0 }}>{active ? "✓" : ""}</span>

      <div style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 1 }}>
        {editing ? (
          <span
            style={{ display: "flex", gap: 4 }}
            onBlur={(event) => {
              if (!providerBusy && !event.currentTarget.contains(event.relatedTarget as Node | null)) cancelRename();
            }}
          >
            <input
              value={labelDraft}
              onChange={(event) => setLabelDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) void handleRename();
                if (event.key === "Escape" && !event.nativeEvent.isComposing) {
                  cancelRename();
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
            <RowButton label="保存" onClick={() => void handleRename()} disabled={providerBusy} />
            <RowButton label="取消" onClick={cancelRename} disabled={providerBusy} />
          </span>
        ) : (
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {profile.label}
            {profile.needs_relogin && (
              <span style={{ color: "var(--cmux-usage-warn)", marginLeft: 6, fontSize: "var(--cmux-font-size-xs)" }}>要再ログイン</span>
            )}
          </span>
        )}
        <span style={{ color: "var(--cmux-text-tertiary)", fontSize: "var(--cmux-font-size-xs)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {[profile.email, profile.plan, `登録: ${formatDate(profile.captured_at)}`, formatLastSwitched(profile.last_switched_at)]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>

      <span style={{ display: "flex", gap: 4, flexShrink: 0 }}>
        {/*
          A profile that lost its refresh token is kept rather than deleted, so
          this button repairs it in place: same id, same label, new credentials.
        */}
        {profile.needs_relogin && (
          <RowButton
            label="再ログイン"
            onClick={() => void startLogin(profile.provider, "reauth", profile.id)}
            disabled={providerBusy}
          />
        )}
        {!active && (
          <RowButton
            label={busyProfileId === profile.id ? "切替中…" : "切り替え"}
            onClick={() => void handleSwitch()}
            disabled={providerBusy || profile.needs_relogin}
          />
        )}
        {!editing && <RowButton label="名前" onClick={() => { setLabelDraft(profile.label); setEditing(true); }} disabled={providerBusy} />}
        <RowButton label="削除" onClick={() => void handleDelete()} disabled={providerBusy} danger />
      </span>
    </div>
  );
}

function OrphanSnapshots({ orphans }: { orphans: CliOrphanSnapshot[] }) {
  return (
    <section style={{ display: "grid", gap: 6 }} aria-label="未登録の保存情報">
      <div style={{ fontWeight: 700 }}>未登録の保存情報</div>
      <div style={{ color: "var(--cmux-text-dim)", fontSize: 11 }}>
        切り替え前に保護した未登録ログインです。必要なものは登録し、不要なものは破棄してください。
      </div>
      {orphans.map((orphan) => <OrphanRow key={orphan.id} orphan={orphan} />)}
    </section>
  );
}

function OrphanRow({ orphan }: { orphan: CliOrphanSnapshot }) {
  const busyByProvider = useCliAccountStore((state) => state.busyByProvider);
  const resolveOrphan = useCliAccountStore((state) => state.resolveOrphan);
  const busy = orphan.provider ? busyByProvider[orphan.provider] !== null : false;

  const register = async () => {
    if (!orphan.provider || busy) return;
    const ok = await resolveOrphan(orphan, "register");
    if (ok) useToastStore.getState().pushToast("未登録の保存情報をアカウント一覧へ登録しました。", "info");
  };

  const discard = async () => {
    if (busy) return;
    const accepted = await confirm(
      "この未登録の保存情報を破棄します。保存されている認証情報は削除され、元に戻せません。現在のログイン状態は変わりません。",
      {
        title: "未登録の保存情報を破棄する",
        kind: "warning",
        okLabel: "破棄する",
        cancelLabel: "キャンセル",
      },
    ).catch(() => false);
    if (!accepted) return;
    const ok = await resolveOrphan(orphan, "discard");
    if (ok) useToastStore.getState().pushToast("未登録の保存情報を破棄しました。", "info");
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", border: "1px solid var(--cmux-border-hairline)", borderRadius: 4 }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div>{orphan.provider ? PROVIDER_TITLE[orphan.provider] : "読み取り不能"} · {orphan.email ?? orphan.identity_key ?? orphan.id}</div>
        <div style={{ color: "var(--cmux-text-tertiary)", fontSize: "var(--cmux-font-size-xs)" }}>
          保存: {formatDate(orphan.captured_at)}
          {orphan.error ? ` · ${cliAccountMessage(orphan.error)}` : ""}
        </div>
      </div>
      <span style={{ display: "flex", gap: 4 }}>
        <RowButton label={busy ? "処理中…" : "登録する"} onClick={() => void register()} disabled={busy || !orphan.provider || Boolean(orphan.error)} />
        <RowButton label="破棄する" onClick={() => void discard()} disabled={busy} danger />
      </span>
    </div>
  );
}

function NoticeWithClose({ text, color, onClose }: { text: string; color: string; onClose: () => void }) {
  return (
    <div style={{ display: "flex", alignItems: "start", gap: 6, color, fontSize: 11 }}>
      <span style={{ flex: 1 }}>{text}</span>
      <button type="button" onClick={onClose} aria-label="この通知を閉じる" title="閉じる" style={{ ...inlineButtonStyle, padding: 0, border: 0 }}>
        ×
      </button>
    </div>
  );
}

const inlineButtonStyle = {
  padding: "2px 7px",
  borderRadius: 3,
  border: "1px solid var(--cmux-border)",
  background: "none",
  color: "var(--cmux-text-secondary)",
  cursor: "pointer",
  fontSize: 11,
  fontFamily: "inherit",
} as const;

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
