import type { FeedSessionPayload, SessionAttentionKind, SessionUiState } from "../../src/lib/ipc";
import type { SessionActivity } from "../../src/lib/sessionStatusSignals";
import { useSessionAttentionStore } from "../../src/stores/sessionAttentionStore";

export const PET_TEST_NOW = 1_800_000_000_000;

export interface PetFeedOptions {
  kind?: SessionAttentionKind;
  uiState?: SessionUiState;
  activity?: SessionActivity;
  lastOutputAt?: number;
  stateSince?: number;
  attentionId?: string;
}

/** The real status.changed wire shape, including the optional activity fields. */
export function petFeedSession(sessionId: string, revision = 1, options: PetFeedOptions = {}): FeedSessionPayload {
  const kind = options.kind ?? "none";
  const signals = {
    activity: options.activity ?? "idle",
    last_output_at: options.lastOutputAt ?? null,
    health: "fresh",
  };
  return {
    session_id: sessionId,
    session_revision: revision,
    status: {
      ...signals,
      session_epoch: 1,
      lifecycle: "alive",
      attention: {
        attention_id: kind === "none" ? null : options.attentionId ?? `${sessionId}:${revision}:${kind}`,
        kind,
        detail: null,
        state_since: options.stateSince ?? PET_TEST_NOW - 60_000,
      },
      ui_state: options.uiState ?? (kind === "done" ? "done" : kind === "none" ? "idle" : "waiting"),
    },
  };
}

export function publishPetFeed(sessionId: string, options: PetFeedOptions): void {
  const store = useSessionAttentionStore.getState();
  const revision = (store.attentionBySession[sessionId]?.sessionRevision ?? 0) + 1;
  store.applyChanged({
    ...petFeedSession(sessionId, revision, options),
    v: 2,
    kind: "event",
    event: "status.changed",
    server_epoch: "pet-test-server",
    seq: store.lastSeq + 1,
  });
}
