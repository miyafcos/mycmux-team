import type { PaneVolatileMetadata } from "../stores/paneMetadataStore";

/** Presentation only: reattachment has no agent observation yet. */
export function resolveAgentConversationKind(
  live: PaneVolatileMetadata | undefined,
  metadataKind: string | undefined,
  savedKind: string | undefined,
): string {
  const saved = metadataKind ?? savedKind ?? "none";
  // Invalidation can temporarily have no owner; it is not a confirmed exit.
  if (live?.liveAgentObservationKnown === false) return saved;
  if (live?.ptyAlive === false) return "none";
  if (live?.ptyAlive === true && live.liveAgentKind !== undefined) return live.liveAgentKind ?? "none";
  return saved;
}
