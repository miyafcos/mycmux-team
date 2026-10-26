import type { LiveSessionBrief } from "./livebrief";
import type { PaneMetadata } from "../stores/paneMetadataStore";
import type { SessionAttention, AttentionCategory } from "../stores/sessionAttentionStore";
import type { StallEntry } from "../stores/stallStore";

interface ManualDoneEvidence {
  brief?: LiveSessionBrief;
  attention?: Pick<SessionAttention, "stateSince">;
  attentionCategory?: AttentionCategory | null;
  operationalState?: string;
  lastActivityAt: number;
  stall?: Pick<StallEntry, "reason" | "since">;
}

export function sessionLastActivityAt(metadata?: Pick<PaneMetadata, "screenStatusAt" | "agentStatusAt">, lastLogAt = 0): number {
  return Math.max(lastLogAt, metadata?.screenStatusAt ?? 0, metadata?.agentStatusAt ?? 0);
}

function finiteTimestamp(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 手動完了マーク後に届いた活動だけを無効化の根拠にする。
 * ターン状態のある brief は意味イベントの時刻を使い、定期的な読取では解除しない。
 * 旧 brief の時刻の扱いは維持する。
 */
export function isManualDoneMarkValid(card: ManualDoneEvidence, markedAt: number): boolean {
  if (!Number.isFinite(markedAt)) return false;
  const autonomy = card.brief?.autonomy;
  const turnStartedAt = finiteTimestamp(autonomy?.turnStartedAt);
  if (turnStartedAt !== null && turnStartedAt > markedAt) return false;
  if (autonomy && Object.prototype.hasOwnProperty.call(autonomy, "turnStartedAt") && autonomy.turnState !== "active"
    && !autonomy.openToolCount && !autonomy.armedBackgroundCount && !autonomy.pendingNotificationCount) {
    // A delayed completion envelope belongs to the same turn, even if the PTY
    // output or attention clock moved after the user marked it complete.
    if ((card.operationalState === "needsHuman" || card.attentionCategory === "error")
      && Math.max(card.brief?.lastEventAt ?? 0, card.attention?.stateSince ?? 0) > markedAt) return false;
    return !(card.stall?.reason === "queued_input" && card.stall.since > markedAt);
  }
  const activityTimes = [
    finiteTimestamp(card.lastActivityAt),
    finiteTimestamp(card.attention?.stateSince),
    finiteTimestamp(card.brief?.lastEventAt),
    finiteTimestamp(card.brief?.autonomy ? null : card.brief?.lastSuccessfulReadAt),
    finiteTimestamp(card.brief?.autonomy ? null : card.brief?.updatedAt),
  ].filter((value): value is number => value !== null);
  return !activityTimes.some((activityAt) => activityAt > markedAt);
}
