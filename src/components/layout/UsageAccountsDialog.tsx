import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { open } from "@tauri-apps/plugin-shell";
import {
  completeOauthLogin,
  listUsageAccounts,
  removeUsageAccount,
  setUsageAccountEnabled,
  startOauthLogin,
  type UsageAccountMeta,
} from "../../lib/ipc";
import { useUsageStore } from "../../stores/usageStore";
import { OVERLAY_EXIT_MS, useDeferredUnmount } from "../../hooks/useDeferredUnmount";
import { useToastStore } from "../../stores/toastStore";
import { friendlyOauthError, isOauthRateLimited, needsFreshOauthLogin } from "../../lib/oauthErrors";

// Shared add/re-auth state machine: idle -> starting -> waiting -> exchanging
// -> (idle on success | error). "Add account" and "re-authenticate an
// existing account" are the same flow from the frontend's perspective -- the
// backend matches the completed login against an existing account by email
// when applicable.
type FlowState = "idle" | "starting" | "waiting" | "exchanging" | "error";

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

// Server-side 429s on the OAuth token endpoint are IP-scoped and decay on
// their own schedule; we persist the last occurrence so the dialog can show
// an advisory countdown even after being closed and reopened.
// Live observations (2026-07): the block can persist for hours to over a day,
// and each retry consumes more of the rate budget — the countdown below is a
// MINIMUM estimate, not a promised release time.
const OAUTH_429_STORAGE_KEY = "mycmux.oauth429At";
const OAUTH_429_COOLDOWN_MS = 30 * 60 * 1000;

function readOauth429At(): number | null {
  try {
    const raw = window.localStorage.getItem(OAUTH_429_STORAGE_KEY);
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

const dialogButtonStyle: React.CSSProperties = {
  padding: "6px 10px",
  fontSize: 12,
  borderRadius: 6,
  border: "1px solid var(--cmux-border)",
  background: "transparent",
  color: "var(--cmux-text)",
  cursor: "pointer",
};

// Content-only panel: shared by the standalone modal below and by the host
// SettingsDialog, which embeds this directly inside its own layout. Fully
// self-contained (reads/writes the usage store itself) and loads its account
// list on mount, so it works whether or not accountsDialogOpen ever flips.
export function UsageAccountsPanel(): JSX.Element {
  const reauthTargetId = useUsageStore((s) => s.reauthTargetId);

  const [accounts, setAccounts] = useState<UsageAccountMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>("");

  const [flowState, setFlowState] = useState<FlowState>("idle");
  const [loginId, setLoginId] = useState<string | null>(null);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [pastedCode, setPastedCode] = useState("");
  const [flowError, setFlowError] = useState<string | null>(null);
  const [flowErrorRaw, setFlowErrorRaw] = useState<string | null>(null);
  const [rateLimitedAt, setRateLimitedAt] = useState<number | null>(() => readOauth429At());
  const [now, setNow] = useState<number>(() => Date.now());

  const resetFlow = useCallback(() => {
    setFlowState("idle");
    setLoginId(null);
    setAuthorizeUrl(null);
    setPastedCode("");
    setFlowError(null);
    setFlowErrorRaw(null);
  }, []);

  // Advisory countdown for the IP-scoped 429 on the OAuth token endpoint.
  // Ticks once per second while a 429 is on record; stops ticking once the
  // advisory window has fully elapsed.
  const rateLimitRemainingMs = rateLimitedAt !== null
    ? rateLimitedAt + OAUTH_429_COOLDOWN_MS - now
    : null;
  useEffect(() => {
    if (rateLimitedAt === null) return;
    if (rateLimitedAt + OAUTH_429_COOLDOWN_MS - Date.now() <= 0) return;
    const interval = window.setInterval(() => {
      const tick = Date.now();
      setNow(tick);
      if (rateLimitedAt + OAUTH_429_COOLDOWN_MS - tick <= 0) window.clearInterval(interval);
    }, 1000);
    return () => window.clearInterval(interval);
  }, [rateLimitedAt]);

  const recordRateLimit = useCallback(() => {
    const at = Date.now();
    try {
      window.localStorage.setItem(OAUTH_429_STORAGE_KEY, String(at));
    } catch { /* storage unavailable — countdown just won't persist */ }
    setRateLimitedAt(at);
    setNow(at);
  }, []);

  const clearRateLimit = useCallback(() => {
    try {
      window.localStorage.removeItem(OAUTH_429_STORAGE_KEY);
    } catch { /* ignore */ }
    setRateLimitedAt(null);
  }, []);

  const loadAccounts = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const list = await listUsageAccounts();
      setAccounts(list);
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  // Load on mount. The standalone dialog below mounts this panel exactly
  // once per open (it's conditionally rendered, not just visually toggled),
  // and the embedded SettingsDialog case mounts it once as well — so a
  // mount-keyed load never double-fires in either case.
  useEffect(() => {
    setStatusMessage("");
    setRateLimitedAt(readOauth429At());
    setNow(Date.now());
    void loadAccounts();
  }, [loadAccounts]);

  const startFlow = async () => {
    setFlowState("starting");
    setFlowError(null);
    try {
      const { authorize_url, login_id } = await startOauthLogin();
      setAuthorizeUrl(authorize_url);
      setLoginId(login_id);
      setPastedCode("");
      open(authorize_url).catch((err) => console.error("Failed to open authorize URL:", err));
      setFlowState("waiting");
    } catch (error) {
      console.error("[mycmux] OAuth start failed:", error);
      const raw = errorMessage(error);
      if (isOauthRateLimited(raw)) recordRateLimit();
      setFlowErrorRaw(raw);
      setFlowError(friendlyOauthError(raw));
      setFlowState("error");
    }
  };

  const handleReopenUrl = () => {
    if (authorizeUrl) {
      open(authorizeUrl).catch((err) => console.error("Failed to open authorize URL:", err));
    }
  };

  const handleCompleteLogin = async () => {
    if (!loginId || !pastedCode.trim()) {
      return;
    }
    setFlowState("exchanging");
    setFlowError(null);
    try {
      await completeOauthLogin(loginId, pastedCode.trim());
      setStatusMessage("アカウント情報を更新しました");
      clearRateLimit();
      await loadAccounts();
      void useUsageStore.getState().fetchAccounts();
      resetFlow();
    } catch (error) {
      // Same loginId stays live so the user can fix a mis-pasted code.
      console.error("[mycmux] OAuth exchange failed:", error);
      const raw = errorMessage(error);
      if (isOauthRateLimited(raw)) recordRateLimit();
      setFlowErrorRaw(raw);
      setFlowError(friendlyOauthError(raw));
      setFlowState("error");
    }
  };

  // 429 / expired-login killed the one-time code — only a fresh authorize
  // flow can recover, so re-pasting the old code would fail forever.
  const errorNeedsFreshLogin = flowErrorRaw !== null && needsFreshOauthLogin(flowErrorRaw);

  const handleRetry = () => {
    if (loginId && !errorNeedsFreshLogin) {
      setFlowState("waiting");
      setFlowError(null);
      setFlowErrorRaw(null);
    } else {
      void startFlow();
    }
  };

  const handleToggleEnabled = async (account: UsageAccountMeta, checked: boolean) => {
    const prevAccounts = accounts;
    setAccounts((current) =>
      current.map((a) => (a.account_id === account.account_id ? { ...a, enabled: checked } : a)),
    );
    setTogglingId(account.account_id);
    try {
      await setUsageAccountEnabled(account.account_id, checked);
      void useUsageStore.getState().fetchAccounts();
    } catch (error) {
      setAccounts(prevAccounts);
      useToastStore
        .getState()
        .pushToast(`「${account.label}」の更新に失敗しました: ${errorMessage(error)}`, "error");
    } finally {
      setTogglingId(null);
    }
  };

  const handleDelete = async (account: UsageAccountMeta) => {
    if (!window.confirm(`アカウント ${account.label} を削除しますか？`)) {
      return;
    }
    setDeletingId(account.account_id);
    try {
      await removeUsageAccount(account.account_id);
      setStatusMessage(`「${account.label}」を削除しました`);
      await loadAccounts();
      void useUsageStore.getState().fetchAccounts();
    } catch (error) {
      useToastStore
        .getState()
        .pushToast(`「${account.label}」の削除に失敗しました: ${errorMessage(error)}`, "error");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div>
      {rateLimitRemainingMs !== null && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            fontSize: 12,
            padding: "8px 10px",
            marginBottom: 12,
            borderRadius: 6,
            border: "1px solid color-mix(in srgb, var(--cmux-usage-warn) 45%, transparent)",
            background: "color-mix(in srgb, var(--cmux-usage-warn) 10%, transparent)",
            color: "var(--cmux-usage-warn)",
          }}
        >
          {rateLimitRemainingMs > 0 ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span>Anthropic レート制限中 — 解除まで最短でも</span>
                <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>
                  あと {formatCountdown(rateLimitRemainingMs)}
                </span>
              </div>
              <div style={{ fontSize: 11, opacity: 0.85 }}>
                実際には解除まで数時間〜1日以上かかる場合があります。再試行を繰り返すと制限が延長される可能性があるため、間隔を空けて1回ずつお試しください。
              </div>
            </>
          ) : (
            <span>
              最短目安 (30分) を過ぎました。解除には数時間〜1日以上かかる場合もあります。「認証をやり直す」は間隔を空けて1回ずつお試しください。
            </span>
          )}
        </div>
      )}

      {flowState !== "idle" && (
        <div
          style={{
            border: "1px solid var(--cmux-border)",
            borderRadius: 6,
            padding: 12,
            marginBottom: 14,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          {flowState === "starting" && (
            <div style={{ fontSize: 12, color: "var(--cmux-text-dim)" }}>認証を開始しています…</div>
          )}

          {flowState === "waiting" && (
            <>
              <div style={{ fontSize: 12 }}>
                ブラウザで認証後、表示されたコード（code#state 形式）を貼り付けてください。
              </div>
              <input
                type="text"
                value={pastedCode}
                onChange={(e) => setPastedCode(e.target.value)}
                placeholder="code#state"
                style={{
                  padding: "6px 8px",
                  borderRadius: 6,
                  border: "1px solid var(--cmux-border)",
                  background: "var(--cmux-popover)",
                  color: "var(--cmux-text)",
                  fontSize: 12,
                  fontFamily: "Menlo, Consolas, monospace",
                }}
              />
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  onClick={() => void handleCompleteLogin()}
                  disabled={!pastedCode.trim()}
                  style={{
                    ...dialogButtonStyle,
                    opacity: pastedCode.trim() ? 1 : 0.5,
                    cursor: pastedCode.trim() ? "pointer" : "not-allowed",
                  }}
                >
                  認証を完了
                </button>
                <button onClick={resetFlow} style={dialogButtonStyle}>
                  キャンセル
                </button>
                <button onClick={handleReopenUrl} style={dialogButtonStyle}>
                  URLを再度開く
                </button>
              </div>
            </>
          )}

          {flowState === "exchanging" && (
            <div style={{ fontSize: 12, color: "var(--cmux-text-dim)" }}>確認中…</div>
          )}

          {flowState === "error" && (
            <>
              <div style={{ fontSize: 12, color: "var(--cmux-usage-danger)", whiteSpace: "pre-line" }}>{flowError}</div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={handleRetry} style={dialogButtonStyle}>
                  {errorNeedsFreshLogin ? "認証をやり直す" : "再試行"}
                </button>
                <button onClick={resetFlow} style={dialogButtonStyle}>
                  キャンセル
                </button>
              </div>
              {errorNeedsFreshLogin && rateLimitRemainingMs !== null && rateLimitRemainingMs > 0 && (
                <div style={{ fontSize: 11, color: "var(--cmux-text-dim)" }}>
                  制限中の再試行は制限を延長する可能性があります。急がない場合はカウントダウン経過後にお試しください。
                </div>
              )}
            </>
          )}
        </div>
      )}

      {(flowState === "idle" || flowState === "error") && (
        <button onClick={() => void startFlow()} style={{ ...dialogButtonStyle, marginBottom: 12 }}>
          + アカウントを追加
        </button>
      )}

      {statusMessage && (
        <div style={{ fontSize: 12, color: "var(--cmux-text-dim)", marginBottom: 10 }}>{statusMessage}</div>
      )}

      {loading && <div style={{ fontSize: 12, color: "var(--cmux-text-dim)" }}>読み込み中…</div>}
      {loadError && (
        <div style={{ fontSize: 12, color: "var(--cmux-usage-danger)", marginBottom: 10 }}>{loadError}</div>
      )}

      {!loading && !loadError && accounts.length === 0 && (
        <div style={{ fontSize: 12, color: "var(--cmux-text-dim)" }}>登録済みのアカウントはありません</div>
      )}

      {!loading && accounts.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
          {accounts.map((account) => (
            <AccountRow
              key={account.account_id}
              account={account}
              highlighted={account.account_id === reauthTargetId}
              toggling={togglingId === account.account_id}
              deleting={deletingId === account.account_id}
              onToggle={(checked) => void handleToggleEnabled(account, checked)}
              onReauth={() => void startFlow()}
              onDelete={() => void handleDelete(account)}
            />
          ))}
        </div>
      )}

      <div
        style={{
          fontSize: 11,
          color: "var(--cmux-text-dim)",
          borderTop: "1px solid var(--cmux-border)",
          paddingTop: 10,
          marginTop: 4,
        }}
      >
        注意: 使用状況の取得は非公式 API を利用します。複数アカウントの追加・自動取得により Anthropic
        によるアカウント制限・停止のリスクがゼロではありません。自己責任でご利用ください。
      </div>
    </div>
  );
}

export default function UsageAccountsDialog() {
  const accountsDialogOpen = useUsageStore((s) => s.accountsDialogOpen);
  const { mounted, closing } = useDeferredUnmount(accountsDialogOpen, OVERLAY_EXIT_MS);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // The component stays mounted for the app's lifetime (visibility is
  // toggled via accountsDialogOpen), so focus capture/restore is keyed off
  // that flag rather than component mount/unmount.
  useEffect(() => {
    if (accountsDialogOpen) {
      previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    } else {
      const prev = previouslyFocusedRef.current;
      if (prev && document.contains(prev)) {
        prev.focus();
      }
      previouslyFocusedRef.current = null;
    }
  }, [accountsDialogOpen]);

  // Escape mirrors the existing 閉じる button.
  useEffect(() => {
    if (!accountsDialogOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      useUsageStore.getState().closeAccountsDialog();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [accountsDialogOpen]);

  if (!mounted) {
    return null;
  }

  const handleClose = () => {
    useUsageStore.getState().closeAccountsDialog();
  };

  return (
    <div
      className={`cmux-overlay-backdrop${closing ? " is-closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-hidden={closing ? true : undefined}
      inert={closing ? true : undefined}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          handleClose();
        }
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "var(--cmux-backdrop)",
      }}
    >
      <div
        className={`cmux-overlay-panel${closing ? " is-closing" : ""}`}
        style={{
          width: "min(520px, calc(100vw - 32px))",
          maxHeight: "calc(100vh - 48px)",
          overflow: "auto",
          background: "var(--cmux-popover)",
          border: "1px solid var(--cmux-border)",
          borderRadius: 8,
          boxShadow: "var(--cmux-shadow-dialog)",
          padding: 16,
          color: "var(--cmux-text)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            marginBottom: 12,
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 700 }}>Usage アカウント管理</div>
          <button onClick={handleClose} style={dialogButtonStyle}>
            閉じる
          </button>
        </div>

        <UsageAccountsPanel />
      </div>
    </div>
  );
}

type AccountRowProps = {
  account: UsageAccountMeta;
  highlighted: boolean;
  toggling: boolean;
  deleting: boolean;
  onToggle: (checked: boolean) => void;
  onReauth: () => void;
  onDelete: () => void;
};

function AccountRow({ account, highlighted, toggling, deleting, onToggle, onReauth, onDelete }: AccountRowProps) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr auto auto auto",
        alignItems: "center",
        gap: 8,
        padding: "8px 10px",
        borderRadius: 6,
        border: highlighted ? "1px solid var(--cmux-usage-warn)" : "1px solid var(--cmux-border)",
        background: highlighted
          ? "color-mix(in srgb, var(--cmux-usage-warn) 12%, transparent)"
          : "transparent",
      }}
    >
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        <span
          title={account.email ?? account.label}
          style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }}
        >
          {account.email ?? account.label}
        </span>
        {account.needs_reauth && (
          <span style={{ fontSize: 11, color: "var(--cmux-usage-warn)", fontWeight: 700 }}>要再認証</span>
        )}
      </div>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          fontSize: 11,
          cursor: toggling ? "wait" : "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={account.enabled}
          disabled={toggling}
          onChange={(e) => onToggle(e.target.checked)}
        />
        <span>有効</span>
      </label>
      <button onClick={onReauth} style={{ ...dialogButtonStyle, padding: "4px 8px", fontSize: 11 }}>
        再認証
      </button>
      <button
        onClick={onDelete}
        disabled={deleting}
        style={{
          ...dialogButtonStyle,
          padding: "4px 8px",
          fontSize: 11,
          color: "var(--cmux-red)",
          cursor: deleting ? "wait" : "pointer",
          opacity: deleting ? 0.5 : 1,
        }}
      >
        削除
      </button>
    </div>
  );
}
