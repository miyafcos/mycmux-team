import { memo } from "react";
import { useShallow } from "zustand/react/shallow";

import { tabGroupingStrings } from "../dashboard/dashboardStrings";
import { usePaneMetadataStore } from "../../stores/paneMetadataStore";
import {
  groupingLiveInfo,
  type GroupingLiveInfo,
  type GroupingLiveStatus,
} from "./groupingLineage";
import { formatLastOutputAgeCompact } from "./tabSweep";

type AttentionCategory = "waiting" | "error" | "done" | null | undefined;

export function useGroupingLiveInfo(
  sessionId: string,
  options: {
    declared: boolean;
    attentionCategory: AttentionCategory;
    tabAgentKind: string | null;
  },
): GroupingLiveInfo {
  const { metadata, volatile } = usePaneMetadataStore(useShallow((state) => ({
    metadata: state.metadata[sessionId],
    volatile: state.volatileMetadata[sessionId],
  })));
  return groupingLiveInfo({
    declared: options.declared,
    metadata,
    volatile,
    attentionCategory: options.attentionCategory,
    tabAgentKind: options.tabAgentKind,
  });
}

function statusLabel(status: GroupingLiveStatus): string {
  if (status === "working") return tabGroupingStrings.liveStatusWorking;
  if (status === "waiting") return tabGroupingStrings.liveStatusWaiting;
  if (status === "done") return tabGroupingStrings.liveStatusDone;
  if (status === "error") return tabGroupingStrings.liveStatusError;
  return tabGroupingStrings.liveStatusIdle;
}

function statusMark(status: GroupingLiveStatus): string {
  if (status === "working") return "●";
  if (status === "waiting") return "◐";
  if (status === "done") return "✓";
  if (status === "error") return "✗";
  return "";
}

export type GroupingLiveChipBadgeProps = {
  sessionId: string;
  declared: boolean;
  attentionCategory: AttentionCategory;
  tabAgentKind: string | null;
  now: number;
};

function GroupingLiveChipBadgeView({
  sessionId,
  declared,
  attentionCategory,
  tabAgentKind,
  now,
}: GroupingLiveChipBadgeProps) {
  const live = useGroupingLiveInfo(sessionId, {
    declared,
    attentionCategory,
    tabAgentKind,
  });
  const age = formatLastOutputAgeCompact(live.lastOutputAt, now);
  return (
    <span
      className="cmux-tab-grouping-live"
      data-status={live.status}
      role="img"
      aria-label={tabGroupingStrings.liveChipAriaDescription(statusLabel(live.status), age)}
    >
      <span className="cmux-tab-grouping-live-mark">{statusMark(live.status)}</span>
      {live.agentKind ? <span className="cmux-tab-grouping-live-agent">{live.agentKind}</span> : null}
      {age ? <span className="cmux-tab-grouping-live-age">{age}</span> : null}
    </span>
  );
}

export const GroupingLiveChipBadge = memo(GroupingLiveChipBadgeView);
