import { useEffect, useState, type CSSProperties } from "react";
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
import { AUTO_SWITCH_INTRO, AutoSwitchCandidateCheckbox, AutoSwitchToggle } from "./AccountAutoSwitchSettings";

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

/** What a screen reader hears for an account: its name and address. */
function lookAlikeKey(profile: CliAccountProfile): string {
  return `${profile.label}\u0000${profile.email ?? ""}`;
}

function repeatedKeys(keys: string[]): Set<string> {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const key of keys) (seen.has(key) ? repeated : seen).add(key);
  return repeated;
}

// The panel's own text runs at 12px, the label size of every other settings
// tab, and everything secondary (notes, meta lines, buttons) steps down to the
// xs token. Keep new text on these two sizes: the auto-switch labels used to
// inherit the browser's 16px and read larger than the rest of the dialog.
const noteStyle: CSSProperties = {
  margin: 0,
  color: "var(--cmux-text-dim)",
  fontSize: "var(--cmux-font-size-xs)",
};

// 候補 | account | actions, shared by a list's header and its rows.
const accountGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "44px minmax(0, 1fr) auto",
  alignItems: "center",
  columnGap: "var(--cmux-space-4)",
  paddingRight: "var(--cmux-space-5)",
};

const listFrameStyle: CSSProperties = {
  border: "1px solid var(--cmux-border)",
  borderRadius: "var(--cmux-radius-md)",
  overflow: "hidden",
};

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
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--cmux-space-7)", fontSize: 12 }}>
      <div style={{ display: "grid", gap: "var(--cmux-space-3)" }}>
        <p style={noteStyle}>
          CLI (claude / codex / grok コマンド) が今どのアカウントでログインしているかを表示し、登録済みアカウントへ切り替えます。切り替えは PC 全体に効きます (新しく起動するセッションから反映)。切り替え前には認証ファイルを自動バックアップします。
        </p>
        <p style={noteStyle}>{AUTO_SWITCH_INTRO}</p>
      </div>

      <div style={{ display: "grid" }}>
        {PROVIDER_ORDER.map((provider, index) => (
          <ProviderPanel key={provider} provider={provider} divided={index > 0} />
        ))}
      </div>

      {orphans.length > 0 && <OrphanSnapshots orphans={orphans} />}

      {fetchError && (
        <div style={{ color: "var(--cmux-usage-danger)", fontSize: "var(--cmux-font-size-xs)" }}>{fetchError}</div>
      )}
      {operationError && (
        <div style={{ display: "grid", gap: "var(--cmux-space-2)" }}>
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
        <div style={{ display: "grid", gap: "var(--cmux-space-2)", color: "var(--cmux-text-dim)", fontSize: "var(--cmux-font-size-xs)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--cmux-space-3)" }}>
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

      <p
        style={{
          ...noteStyle,
          borderTop: "1px solid var(--cmux-border-hairline)",
          paddingTop: "var(--cmux-space-5)",
        }}
      >
        補足: 「現在のログインを登録/更新」は、すでに <code>claude /login</code> / <code>codex login</code> / <code>grok login</code> でログイン済みのアカウントを取り込むためのボタンです。Codex の切り替えは auth.json 全体を入れ替えるため、OPENAI_API_KEY を手動設定している場合はそれも切り替わります (切り替え前の内容はバックアップに残ります)。
      </p>
    </div>
  );
}

/**
 * One provider: who is logged in, whether mycmux may switch on its own, and
 * the registered accounts with a 候補 tick for each. Adding an account opens
 * the CLI login in a pane whose config directory points at a staging copy, so
 * the account that is currently logged in is never disturbed.
 */
function ProviderPanel({ provider, divided }: { provider: CliProvider; divided: boolean }) {
  // Stable-reference selectors; derive per-provider views outside (see
  // CliAccountMenu.tsx for the rationale).
  const allLive = useCliAccountStore((state) => state.live);
  const allProfiles = useCliAccountStore((state) => state.profiles);
  const live = liveForProvider(allLive, provider);
  const profiles = orderCliAccountProfiles(allProfiles.filter((profile) => profile.provider === provider));
  // Rows another row cannot be told apart from by ear; their 候補 ticks add a row number.
  const lookAlikes = repeatedKeys(profiles.map(lookAlikeKey));
  const intendedActiveId = useCliAccountStore((state) => state.active[provider]);
  const fetchError = useCliAccountStore((state) => state.fetchError);
  const busyProfileId = useCliAccountStore((state) => state.busyByProvider[provider]);
  const capture = useCliAccountStore((state) => state.capture);
  const loginInFlight = useCliLoginStore((state) => Boolean(state.byProvider[provider]));
  const startLogin = useCliLoginStore((state) => state.start);
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
    <section
      aria-label={PROVIDER_TITLE[provider]}
      style={{
        display: "grid",
        gap: "var(--cmux-space-5)",
        ...(divided
          ? {
              marginTop: "var(--cmux-space-7)",
              paddingTop: "var(--cmux-space-7)",
              borderTop: "1px solid var(--cmux-border-hairline)",
            }
          : {}),
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "var(--cmux-space-4)" }}>
        <h4 style={{ margin: 0, fontSize: "inherit", fontWeight: 700 }}>{PROVIDER_TITLE[provider]}</h4>
        <span
          style={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: "var(--cmux-text-tertiary)",
            fontSize: "var(--cmux-font-size-xs)",
          }}
        >
          {live?.error
            ? cliAccountMessage(live.error)
            : live?.present
              ? `ログイン中: ${live.email ?? live.identity_key ?? "(不明)"}${live.matched_profile_id ? "" : " (未登録)"}`
              : "未ログイン"}
        </span>
      </div>

      <AutoSwitchToggle provider={provider} profiles={profiles} live={live} />

      {intendedMismatch && (
        <div style={{ color: "var(--cmux-usage-warn)", fontSize: "var(--cmux-font-size-xs)" }}>
          前回選択: {intendedProfile?.label ?? "削除済みのアカウント"}（現在のログインと不一致）
        </div>
      )}

      {profiles.length === 0 ? (
        <p style={noteStyle}>登録済みアカウントはありません</p>
      ) : (
        <div style={listFrameStyle}>
          <div
            style={{
              ...accountGridStyle,
              padding: "var(--cmux-space-3) var(--cmux-space-5) var(--cmux-space-3) 0",
              background: "var(--cmux-hover)",
              fontSize: "var(--cmux-font-size-xs)",
              fontWeight: 700,
            }}
          >
            <span style={{ textAlign: "center" }} title="自動で切り替えるときの切り替え先にするアカウント">候補</span>
            <span>アカウント</span>
            <span />
          </div>
          {profiles.map((profile, index) => {
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
                candidatePosition={lookAlikes.has(lookAlikeKey(profile)) ? index + 1 : undefined}
              />
            );
          })}
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--cmux-space-3)" }}>
        <button
          type="button"
          onClick={() => void startLogin(provider, "new")}
          disabled={providerBusy}
          aria-label={addAccountLabel(provider)}
          style={{ ...inlineButtonStyle, ...(providerBusy ? disabledButtonStyle : {}) }}
        >
          + アカウントを追加
        </button>
        <button
          type="button"
          onClick={() => void capture(provider)}
          disabled={providerBusy || !live?.present}
          style={{ ...inlineButtonStyle, ...(providerBusy || !live?.present ? disabledButtonStyle : {}) }}
        >
          {busyProfileId === captureBusyKey ? "登録中…" : "現在のログインを登録/更新"}
        </button>
      </div>
      {loginInFlight && <CliLoginProgress provider={provider} />}
    </section>
  );
}

function ProfileRow({
  profile,
  active,
  possiblyActive,
  candidatePosition,
}: {
  profile: CliAccountProfile;
  active: boolean;
  possiblyActive: boolean;
  candidatePosition?: number;
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
      data-cli-account-row={profile.id}
      style={{
        ...accountGridStyle,
        padding: "var(--cmux-space-4) var(--cmux-space-5) var(--cmux-space-4) 0",
        borderTop: "1px solid var(--cmux-border-hairline)",
      }}
    >
      <span style={{ display: "flex", justifyContent: "center" }}>
        <AutoSwitchCandidateCheckbox profile={profile} position={candidatePosition} />
      </span>

      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: "var(--cmux-space-1)" }}>
        <span style={{ display: "flex", alignItems: "center", gap: "var(--cmux-space-3)", minWidth: 0 }}>
          {editing ? (
            <span
              style={{ display: "flex", flex: 1, minWidth: 0, gap: "var(--cmux-space-2)" }}
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
                  fontSize: "inherit",
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
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{profile.label}</span>
          )}
          {/* Outside the edit switch: renaming the live account must not hide which one it is. */}
          {active && <StateTag color="var(--cmux-usage-ok)">使用中</StateTag>}
          {profile.needs_relogin && <StateTag color="var(--cmux-usage-warn)">要再ログイン</StateTag>}
        </span>
        <span style={{ color: "var(--cmux-text-tertiary)", fontSize: "var(--cmux-font-size-xs)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {[profile.email, profile.plan, `登録: ${formatDate(profile.captured_at)}`, formatLastSwitched(profile.last_switched_at)]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>

      <span style={{ display: "flex", gap: "var(--cmux-space-2)", flexShrink: 0 }}>
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

function StateTag({ color, children }: { color: string; children: string }) {
  return (
    <span
      style={{
        flexShrink: 0,
        padding: "0 var(--cmux-space-3)",
        border: `1px solid color-mix(in srgb, ${color} 45%, transparent)`,
        borderRadius: "var(--cmux-radius-pill)",
        color,
        fontSize: "var(--cmux-font-size-xs)",
        lineHeight: 1.5,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function OrphanSnapshots({ orphans }: { orphans: CliOrphanSnapshot[] }) {
  return (
    <section style={{ display: "grid", gap: "var(--cmux-space-4)" }} aria-label="未登録の保存情報">
      <h4 style={{ margin: 0, fontSize: "inherit", fontWeight: 700 }}>未登録の保存情報</h4>
      <p style={noteStyle}>
        切り替え前に保護した未登録ログインです。必要なものは登録し、不要なものは破棄してください。
      </p>
      <div style={listFrameStyle}>
        {orphans.map((orphan, index) => <OrphanRow key={orphan.id} orphan={orphan} first={index === 0} />)}
      </div>
    </section>
  );
}

function OrphanRow({ orphan, first }: { orphan: CliOrphanSnapshot; first: boolean }) {
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
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--cmux-space-4)",
        padding: "var(--cmux-space-4) var(--cmux-space-5)",
        borderTop: first ? "none" : "1px solid var(--cmux-border-hairline)",
      }}
    >
      <div style={{ minWidth: 0, flex: 1, display: "grid", gap: "var(--cmux-space-1)" }}>
        <div>{orphan.provider ? PROVIDER_TITLE[orphan.provider] : "読み取り不能"} · {orphan.email ?? orphan.identity_key ?? orphan.id}</div>
        <div style={{ color: "var(--cmux-text-tertiary)", fontSize: "var(--cmux-font-size-xs)" }}>
          保存: {formatDate(orphan.captured_at)}
          {orphan.error ? ` · ${cliAccountMessage(orphan.error)}` : ""}
        </div>
      </div>
      <span style={{ display: "flex", gap: "var(--cmux-space-2)" }}>
        <RowButton label={busy ? "処理中…" : "登録する"} onClick={() => void register()} disabled={busy || !orphan.provider || Boolean(orphan.error)} />
        <RowButton label="破棄する" onClick={() => void discard()} disabled={busy} danger />
      </span>
    </div>
  );
}

function NoticeWithClose({ text, color, onClose }: { text: string; color: string; onClose: () => void }) {
  return (
    <div style={{ display: "flex", alignItems: "start", gap: "var(--cmux-space-3)", color, fontSize: "var(--cmux-font-size-xs)" }}>
      <span style={{ flex: 1 }}>{text}</span>
      <button type="button" onClick={onClose} aria-label="この通知を閉じる" title="閉じる" style={{ ...inlineButtonStyle, padding: 0, border: 0 }}>
        ×
      </button>
    </div>
  );
}

const inlineButtonStyle = {
  padding: "3px 8px",
  borderRadius: 4,
  border: "1px solid var(--cmux-border)",
  background: "none",
  color: "var(--cmux-text-secondary)",
  cursor: "pointer",
  fontSize: "var(--cmux-font-size-xs)",
  fontFamily: "inherit",
} as const;

const disabledButtonStyle = {
  color: "var(--cmux-text-dim)",
  cursor: "default",
  opacity: 0.6,
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
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "2px 7px",
        borderRadius: 3,
        border: "1px solid var(--cmux-border)",
        background: "none",
        color: danger ? "var(--cmux-usage-danger)" : "var(--cmux-text-secondary)",
        cursor: disabled ? "default" : "pointer",
        fontSize: "var(--cmux-font-size-xs)",
        fontFamily: "inherit",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {label}
    </button>
  );
}
