import type { CliAccountProfile, CliLiveLogin, CliProvider } from "../../lib/ipc";
import { eligibleTargets } from "../../lib/accountAutoSwitch";
import { PROVIDER_TITLE } from "../../lib/cliAccounts";
import { excludedTargetsFor, useAccountAutoSwitchStore } from "../../stores/accountAutoSwitchStore";
import { checkboxLabelStyle } from "./tabStyles";

// Automatic switching is set per provider, inside that provider's account
// list: the switch, and a 候補 tick on every account it may move to. It used to
// be a separate section above the lists, with no say over the targets.

export const AUTO_SWITCH_INTRO =
  "「自動で切り替える」をオンにすると、使用中のアカウントが上限 (100%) に達したとき、候補にチェックしたアカウントのうち空きがいちばん多いものへ切り替えます。判断には 5 分以内に取得した使用量だけを使い、切り替えたあと 5 分間は次の切り替えをしません。切り替えに失敗したときと、切り替えても上限が続くときは自動でオフにします。";

export function AutoSwitchToggle({
  provider,
  profiles,
  live,
}: {
  provider: CliProvider;
  /** This provider's registered accounts. */
  profiles: CliAccountProfile[];
  live: CliLiveLogin | undefined;
}) {
  const enabled = useAccountAutoSwitchStore((state) => state.enabled[provider] === true);
  const status = useAccountAutoSwitchStore((state) => state.status[provider]);
  const excludedTargets = useAccountAutoSwitchStore((state) => state.excludedTargets);
  const setEnabled = useAccountAutoSwitchStore((state) => state.setEnabled);
  const excluded = excludedTargetsFor({ excludedTargets }, provider);
  // One registered account has nowhere to go. A switch left on from before
  // stays operable so it can still be turned off.
  const unusable = profiles.length < 2;
  const targets = eligibleTargets(provider, profiles, live, excluded);
  const hint = !enabled
    ? unusable ? { text: "アカウントを 2 つ以上登録すると使えます。", tone: "dim" } : null
    : unusable
      ? { text: "切り替え先にできる登録済みアカウントがありません。", tone: "warn" }
      : targets.length > 0
        ? null
        : profiles.some((profile) => profile.needs_relogin && !excluded.includes(profile.id)
            && profile.id !== live?.matched_profile_id)
          ? { text: "候補のアカウントが再ログイン待ちのため、いまは切り替え先がありません。", tone: "warn" }
          : { text: "切り替え先の候補がありません。使用中以外のアカウントにチェックを入れてください。", tone: "warn" };

  const disabled = !enabled && unusable;

  return (
    <div style={{ display: "grid", gap: "var(--cmux-space-1)" }}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          columnGap: "var(--cmux-space-4)",
          rowGap: "var(--cmux-space-1)",
        }}
      >
        <label
          style={{
            ...checkboxLabelStyle,
            padding: 0,
            cursor: disabled ? "not-allowed" : "pointer",
            color: disabled ? "var(--cmux-text-dim)" : "var(--cmux-text)",
          }}
        >
          <input
            type="checkbox"
            role="switch"
            checked={enabled}
            disabled={disabled}
            aria-label={`${PROVIDER_TITLE[provider]} のアカウントを自動で切り替える`}
            onChange={(event) => setEnabled(provider, event.target.checked)}
          />
          <span>自動で切り替える</span>
        </label>
        {/* Outside the label, so the switch's name does not change with the status. */}
        <span role="status" style={{ color: "var(--cmux-text-dim)", fontSize: "var(--cmux-font-size-xs)" }}>
          {status ?? (enabled ? "監視しています" : "オフ")}
        </span>
      </div>
      {hint && (
        <div
          style={{
            fontSize: "var(--cmux-font-size-xs)",
            color: hint.tone === "warn" ? "var(--cmux-usage-warn)" : "var(--cmux-text-dim)",
          }}
        >
          {hint.text}
        </div>
      )}
    </div>
  );
}

export function AutoSwitchCandidateCheckbox({
  profile,
  position,
}: {
  profile: CliAccountProfile;
  /** 1-based row number, given only when another row shows the same name and address. */
  position?: number;
}) {
  const included = useAccountAutoSwitchStore(
    (state) => !excludedTargetsFor(state, profile.provider).includes(profile.id),
  );
  const setTargetIncluded = useAccountAutoSwitchStore((state) => state.setTargetIncluded);
  // Names and addresses may repeat across accounts. The address keeps most of
  // them apart when read out; a pair that still repeats adds its row number.
  const detail = [profile.email, position ? `${position} 件目` : null].filter(Boolean).join("・");
  return (
    <input
      type="checkbox"
      checked={included}
      aria-label={`「${profile.label}」${detail ? `(${detail}) ` : ""}を自動切り替えの候補にする`}
      title={
        profile.needs_relogin
          ? "候補にしても、再ログインするまでは切り替え先になりません"
          : "自動で切り替えるときの切り替え先にします"
      }
      onChange={(event) => setTargetIncluded(profile.provider, profile.id, event.target.checked)}
      style={{ margin: 0, cursor: "pointer" }}
    />
  );
}
