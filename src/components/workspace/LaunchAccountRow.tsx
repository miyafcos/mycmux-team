import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEventHandler, type Ref } from "react";
import { isLaunchAccountTarget } from "../../lib/agentCatalog";
import {
  launchAccountChoices, openAccountManagement, readLaunchAccounts,
  tabRegistrationLabels, useAccountListRefresh, useTokenExpiryClock,
  type AccountListChange, type LaunchAccountData, type LaunchAccountListListener, type LaunchAccountListResult,
} from "../../lib/tabAccounts";
import { launcherStrings as S } from "./launcherStrings";

export const ACCOUNT_MANAGEMENT_CHIP = ":account-management";

export function useLaunchAccounts(
  target: string | null | undefined, visible = true, focused?: boolean, onRead?: LaunchAccountListListener, slot = 0,
) {
  const [display, setDisplay] = useState<{ result: LaunchAccountListResult; signal: AbortSignal; subscribed: boolean }>();
  const read = useCallback((signal: AbortSignal, _change: AccountListChange | undefined, subscribed: boolean) => {
    if (!isLaunchAccountTarget(target)) return;
    onRead?.(slot, signal);
    const apply = (data: LaunchAccountData | null) => {
      if (signal.aborted) return;
      // Discard an old check as soon as its display read settles, even before React commits the new list.
      onRead?.(slot, AbortSignal.abort(), data === null ? false : undefined);
      setDisplay({ result: { target, data }, signal, subscribed });
    };
    void readLaunchAccounts(target).then(apply, () => apply(null));
  }, [target, onRead, slot]);
  const dispose = useCallback(() => {
    onRead?.(slot, AbortSignal.abort(), false);
  }, [onRead, slot]);
  const { refresh } = useAccountListRefresh(read, visible && isLaunchAccountTarget(target), focused, dispose);
  useLayoutEffect(() => {
    if (!display || display.signal.aborted) return;
    onRead?.(slot, display.result, display.subscribed && display.result.data !== null);
  }, [display, onRead, slot]);
  const current = display?.result.target === target ? display?.result : undefined;
  const data = current?.data;
  const now = useTokenExpiryClock(data?.tokens ?? []);
  const all = data && isLaunchAccountTarget(target) ? launchAccountChoices(data, target, now) : [];
  const choices = all.filter(choice => choice.available || choice.state === "expired" || choice.state === "mismatch");
  return {
    target, choices, refresh, loading: !current, failed: current?.data === null,
    showManagement: current !== undefined && (all.length === 0 || all.some(choice => !choice.available)),
  };
}

const chip: CSSProperties = {
  maxWidth: "100%", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  borderWidth: 1, borderStyle: "solid", borderColor: "var(--cmux-border)", borderRadius: 999, padding: "3px 8px", background: "transparent",
  fontFamily: "inherit", fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-text-secondary)", cursor: "pointer",
};

export function LaunchAccountRow({ accounts, value, onChange, error, highlighted = false, cursorId, cursorChipRef, labelRef, onMouseDown, onOpenManagement }: {
  accounts: ReturnType<typeof useLaunchAccounts>;
  value: string;
  onChange: (id: string) => void;
  error?: string | null;
  highlighted?: boolean;
  cursorId?: string;
  cursorChipRef?: Ref<HTMLButtonElement>;
  labelRef?: Ref<HTMLDivElement>;
  onMouseDown?: MouseEventHandler<HTMLButtonElement>;
  onOpenManagement?: () => void;
}) {
  const [managementFailed, setManagementFailed] = useState(false);
  const managementPress = useRef(0);
  const { target } = accounts;
  if (!isLaunchAccountTarget(target)) return null;
  const buttonStyle = (selected: boolean, focused: boolean): CSSProperties => ({
    ...chip, outline: focused ? "1px solid var(--cmux-accent)" : undefined,
    ...(selected ? { borderColor: "var(--cmux-accent)", background: "var(--cmux-selected)", color: "var(--cmux-text)" } : {}),
  });
  return (
    <div data-launch-account-row="true" style={{ display: "grid", gap: 4, minWidth: 0, fontSize: "var(--cmux-font-size-xs)" }}>
      <div ref={labelRef} style={{ color: highlighted ? "var(--cmux-accent-text)" : "var(--cmux-text-tertiary)" }}>{S.accountLabel}</div>
      {(error || accounts.failed) && <div role="alert">{error ?? S.accountReadFailed}</div>}
      {managementFailed && <div role="alert">{S.accountManagementFailed}</div>}
      {accounts.loading && <div role="status" style={{ color: "var(--cmux-text-tertiary)" }}>{S.accountLoading}</div>}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 4, minWidth: 0 }}>
        <button ref={cursorId === "" ? cursorChipRef : undefined} type="button" aria-pressed={value === ""} onMouseDown={onMouseDown}
          onClick={() => onChange("")} style={buttonStyle(value === "", highlighted && cursorId === "")}>{S.specDefault}</button>
        {accounts.choices.map(choice => (
          <span key={choice.id} data-launch-account-choice={choice.id} style={{ display: "grid", justifyItems: "start", gap: 2, minWidth: 0, maxWidth: "100%" }}>
            <button ref={cursorId === choice.id ? cursorChipRef : undefined} type="button" title={choice.label}
              disabled={!choice.available} aria-pressed={value === choice.id}
              aria-current={highlighted && cursorId === choice.id ? "true" : undefined}
              onMouseDown={onMouseDown} onClick={() => onChange(choice.id)}
              style={{ ...buttonStyle(value === choice.id, highlighted && cursorId === choice.id),
                ...(!choice.available ? { color: "var(--cmux-text-dim)", cursor: "default" } : {}) }}>{choice.label}</button>
            {!choice.available && <span style={{ color: "var(--cmux-text-tertiary)" }}>{tabRegistrationLabels[choice.state]}</span>}
          </span>
        ))}
      </div>
      {accounts.showManagement && <button type="button" title={S.accountManagement} data-launch-account-management="true"
        ref={cursorId === ACCOUNT_MANAGEMENT_CHIP ? cursorChipRef : undefined}
        aria-current={highlighted && cursorId === ACCOUNT_MANAGEMENT_CHIP ? "true" : undefined}
        onMouseDown={onMouseDown} onClick={() => {
          onOpenManagement?.();
          const press = ++managementPress.current;
          setManagementFailed(false);
          void openAccountManagement(target).catch(() => {
            if (managementPress.current === press) setManagementFailed(true);
          });
        }}
        style={{ ...buttonStyle(false, highlighted && cursorId === ACCOUNT_MANAGEMENT_CHIP), justifySelf: "start" }}>
        {S.accountManagement}
      </button>}
      {target === "claude" && value !== "" && <div style={{ color: "var(--cmux-text-tertiary)" }}>{S.accountClaudeLimitations}</div>}
    </div>
  );
}
