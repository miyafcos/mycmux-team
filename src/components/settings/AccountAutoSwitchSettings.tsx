import { PROVIDER_ORDER, PROVIDER_TITLE } from "../../lib/cliAccounts";
import { useAccountAutoSwitchStore } from "../../stores/accountAutoSwitchStore";

export function AccountAutoSwitchSettings() {
  const enabled = useAccountAutoSwitchStore((state) => state.enabled);
  const status = useAccountAutoSwitchStore((state) => state.status);
  const setEnabled = useAccountAutoSwitchStore((state) => state.setEnabled);
  return (
    <section style={{ display: "grid", gap: 10 }} aria-labelledby="account-auto-switch-heading">
      <h3 id="account-auto-switch-heading" style={{ margin: 0, fontSize: "var(--cmux-font-size-md)" }}>
        アカウントの自動切り替え
      </h3>
      <p style={{ margin: 0, color: "var(--cmux-text-dim)", fontSize: "var(--cmux-font-size-xs)" }}>
        5 分以内に取得した使用量で上限 (100%) に達していたら、まだ空きのある登録済みアカウントへ
        自動で切り替えます。空きがいちばん多いアカウントを選び、5 分間は次の切り替えをしません。
      </p>
      <p style={{ margin: 0, color: "var(--cmux-text-dim)", fontSize: "var(--cmux-font-size-xs)" }}>
        切り替えは PC 全体に効きます (新しく起動するセッションから反映)。動いているセッションは
        そのままです。切り替えに失敗したときと、切り替えても上限が続くときは自動でオフにします。
      </p>
      {PROVIDER_ORDER.map((provider) => (
        <div key={provider} style={{ display: "grid", gap: 4 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input type="checkbox" role="switch" checked={enabled[provider] === true}
              onChange={(event) => setEnabled(provider, event.target.checked)} />
            {PROVIDER_TITLE[provider]}
          </label>
          <span role="status" style={{ color: "var(--cmux-text-dim)", fontSize: "var(--cmux-font-size-xs)" }}>
            {status[provider] ?? (enabled[provider] ? "監視しています" : "オフ")}
          </span>
        </div>
      ))}
    </section>
  );
}
