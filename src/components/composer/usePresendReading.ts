import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { v4 as uuid } from "uuid";
import type { ComposerTarget, ComposerTargetInput } from "../../lib/composerSend";
import { cancelPresendReading, requestPresendReading } from "../../lib/presendReadingClient";
import { PRESEND_DELAY_MS, ensurePresendTab, presendDraftFingerprint, presendTab, samePresendRevision, setPresendTabEnabled, shouldReadPresend, subscribePresendTabs,
  type PresendReading, type PresendRevision } from "../../lib/presendReading";
import { useAiSettingsStore } from "../../stores/aiSettingsStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useComposerStore } from "../../stores/composerStore";
import { usePaneMetadataStore, type PaneMetadataState } from "../../stores/paneMetadataStore";

function observedNonAgent(state: PaneMetadataState, sessionId: string): boolean {
  const live = state.volatileMetadata[sessionId];
  return live?.liveAgentObservationKnown === true && live.liveAgentKind === null;
}

export function usePresendReading(
  sessionId: string,
  draft: string,
  resolvedTarget: ComposerTarget,
  _launch?: ComposerTargetInput,
) {
  const target = usePaneMetadataStore(state => observedNonAgent(state, sessionId)) ? "shell" : resolvedTarget;
  const featureEnabled = useSettingsStore(state => state.presendReadingEnabled);
  const aiEnabled = useAiSettingsStore(state => state.aiEnabled);
  const enabled = featureEnabled && aiEnabled;
  const provider = useSettingsStore(state => state.presendReadingProvider);
  const tabEnabled = useSyncExternalStore(subscribePresendTabs, () => presendTab(sessionId)?.enabled ?? true);
  const [composing, setComposing] = useState(false);
  const composingRef = useRef(false);
  const [value, setValue] = useState<{ identity: PresendRevision; result: PresendReading } | null>(null);
  const [pending, setPending] = useState(false);
  const revision = useRef(0);
  const localEdit = useRef<{ sessionId: string; draft: string } | null>(null);
  const identity = useRef<PresendRevision>({ sessionId, draft, target, revision: 0, provider });
  identity.current = { sessionId, draft, target, revision: revision.current, provider };

  useEffect(() => {
    composingRef.current = false;
    setComposing(false);
  }, [sessionId]);

  useEffect(() => {
    const current: PresendRevision = { sessionId, draft, target, provider, revision: ++revision.current };
    identity.current = current;
    setValue(null);
    setPending(false);
    const existing = presendTab(sessionId);
    if (!draft) existing?.attempted.clear();
    if (target === "shell" || localEdit.current?.sessionId !== sessionId || localEdit.current.draft !== draft) {
      localEdit.current = null;
      return;
    }
    if (!shouldReadPresend({ enabled, tabEnabled, target, draft, composing,
      quietMs: PRESEND_DELAY_MS, attempted: existing?.attempted })) return;
    const tab = existing ?? ensurePresendTab(sessionId);
    let disposed = false;
    let requestId: string | null = null;
    let finished = false;
    const isCurrent = Object.assign(() => {
      const settings = useSettingsStore.getState();
      return !disposed && !composingRef.current && useAiSettingsStore.getState().aiEnabled
        && settings.presendReadingEnabled && settings.paneComposerEnabled
        && presendTab(sessionId) === tab && tab.enabled && settings.presendReadingProvider === provider
        && !observedNonAgent(usePaneMetadataStore.getState(), sessionId)
        && (useComposerStore.getState().draftBySession[sessionId] ?? "") === draft
        && samePresendRevision(current, identity.current);
    }, { requireForegroundAgent: true });
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    const attempt = () => {
      if (!isCurrent()) return;
      const quietMs = Date.now() - started;
      if (quietMs < PRESEND_DELAY_MS) {
        timer = setTimeout(attempt, PRESEND_DELAY_MS - quietMs);
        return;
      }
      if (!shouldReadPresend({ enabled, tabEnabled, target, draft, composing, quietMs, attempted: tab.attempted })) return;
      requestId = `presend-${uuid()}`;
      setPending(true);
      let dropped = false;
      void requestPresendReading(requestId, sessionId, draft, provider, isCurrent).then(result => {
        dropped = result === null;
        if (isCurrent() && result) setValue({ identity: current, result });
      }).catch(() => undefined).finally(() => {
        finished = true;
        if (isCurrent()) {
          if (!dropped) tab.attempted.add(presendDraftFingerprint(draft));
          setPending(false);
        }
      });
    };
    timer = setTimeout(attempt, PRESEND_DELAY_MS);
    return () => {
      disposed = true;
      clearTimeout(timer);
      if (requestId && !finished) cancelPresendReading(requestId);
    };
  }, [sessionId, draft, target, enabled, provider, tabEnabled, composing]);

  const valid = enabled && tabEnabled && !composing && value && samePresendRevision(value.identity, identity.current);
  return {
    enabled, tabEnabled, pending: enabled && tabEnabled && !composing && pending,
    reading: valid ? value.result : null,
    recordEdit: (draft: string) => { localEdit.current = { sessionId, draft }; },
    toggle: () => { if (enabled) setPresendTabEnabled(sessionId, !tabEnabled); },
    compositionStart: () => { composingRef.current = true; setComposing(true); },
    compositionEnd: () => { composingRef.current = false; setComposing(false); },
  };
}
