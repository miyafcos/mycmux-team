import { accountLimitLabel, groupAccountRows, type AccountGroupId } from "./accountAvailability";
import { getAccountUsage, type AccountUsageReport, type ProfileUsage } from "./ipc";

export type PresentedAccountUsage = ProfileUsage & {
  availability_group: AccountGroupId;
  availability_order: number;
  availability_label: string | null;
};

export type PresentedAccountUsageReport = Omit<AccountUsageReport, "accounts"> & {
  accounts: PresentedAccountUsage[];
  availability_groups: {
    id: AccountGroupId;
    label: string;
    collapsible: boolean;
    profile_ids: string[];
  }[];
};

/** Add PC presentation without changing raw fields or the source row order. */
export function presentAccountUsage(report: AccountUsageReport): PresentedAccountUsageReport {
  const groups = groupAccountRows(report.accounts);
  const positions = new Map<ProfileUsage, { availability_group: AccountGroupId; availability_order: number }>();
  for (const group of groups) {
    group.rows.forEach((row, index) => positions.set(row, {
      availability_group: group.id, availability_order: index,
    }));
  }
  return {
    ...report,
    accounts: report.accounts.map((row) => ({
      ...row, ...positions.get(row)!, availability_label: accountLimitLabel(row),
    })),
    availability_groups: groups.map((group) => ({
      id: group.id, label: group.label, collapsible: group.collapsible,
      profile_ids: group.rows.map((row) => row.profile_id),
    })),
  };
}

export async function getAccountUsageForApi(): Promise<PresentedAccountUsageReport> {
  return presentAccountUsage(await getAccountUsage(false, "account.usage"));
}
