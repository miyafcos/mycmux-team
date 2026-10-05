import type { ProfileUsage } from "../../lib/ipc";
import {
  subscriptionCheckedLabel, subscriptionLabel, subscriptionTitle,
} from "../../lib/accountSubscription";

export function AccountSubscriptionDetails({ row }: { row: ProfileUsage }) {
  return (
    <span
      data-account-subscription={row.profile_id}
      title={subscriptionTitle(row)}
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) auto",
        gap: "var(--cmux-space-3)",
        minWidth: 0,
        fontSize: "var(--cmux-font-size-xs)",
        color: "var(--cmux-text-dim)",
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {subscriptionLabel(row)}
      </span>
      <span style={{ whiteSpace: "nowrap" }}>
        {subscriptionCheckedLabel(row.subscription)}
      </span>
    </span>
  );
}
