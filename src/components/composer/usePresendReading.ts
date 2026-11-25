import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { v4 as uuid } from "uuid";
import type { ComposerTarget } from "../../lib/composerSend";
import { cancelPresendReading, requestPresendReading } from "../../lib/presendReadingClient";
import { codexRestoreNoticeEpoch, codexRestoreNoticeRevision } from "../../lib/codexRestoreLifecycle";
import {
  PRESEND_DELAY_MS, currentPresendAttemptLedger, ensurePresendTab, pausePresendTab, presendAttemptKey,
  presendAttemptLedger, presendTab, presendTabPreferenceRevision, rememberedPresendShell, samePresendRevision, setPresendTabEnabled,
  sharedPresendTabEnabled, shouldReadPresend,
  subscribePresendTabs, type PresendConversation, type PresendReading, type PresendRevision,
} from "../../lib/presendReading";
import { useAiSettingsStore } from "../../stores/aiSettingsStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useComposerStore } from "../../stores/composerStore";
import { usePaneMetadataStore, type PaneVolatileMetadata } from "../../stores/paneMetadataStore";

function isShell(sessionId: string, observation?: PaneVolatileMetadata): boolean {
  return observation?.liveAgentObservationKnown
    ? observation.liveAgentKind === null
    : rememberedPresendShell(sessionId, codexRestoreNoticeEpoch(sessionId));
}

function conversationOf(observation?: PaneVolatileMetadata): PresendConversation | null {
  if (!observation?.liveAgentObservationKnown || !observation.liveAgentKind || !observation.liveAgentSessionId) return null;
  return { agentKind: observation.liveAgentKind, agentSessionId: observation.liveAgentSessionId };
}

function keyForConversation(conversation: PresendConversation | null): string {
  return JSON.stringify(conversation);
}

export function usePresendReading(
  sessionId: string,
  draft: string,
  resolvedTarget: ComposerTarget,
  visible = true,
) {
  const ptyRevision = usePaneMetadataStore(() => codexRestoreNoticeRevision(sessionId));
  const observation = usePaneMetadataStore(state => state.volatileMetadata[sessionId]);
  const target = isShell(sessionId, observation) ? "shell" : resolvedTarget;
  const conversationKey = keyForConversation(conversationOf(observation));
  const featureEnabled = useSettingsStore(state => state.presendReadingEnabled);
  const aiEnabled = useAiSettingsStore(state => state.aiEnabled);
  const enabled = featureEnabled && aiEnabled;
  const provider = useSettingsStore(state => state.presendReadingProvider);
  const tabEnabled = useSyncExternalStore(subscribePresendTabs, () => presendTab(sessionId)?.enabled ?? true);
  const pause = useSyncExternalStore(subscribePresendTabs, () => presendTab(sessionId)?.paused);
  const preferenceUpdate = useRef(0);
  const retryPreference = useRef<(() => void) | null>(null);
  const verifiedPreference = useRef<Promise<boolean> | null>(null);
  const [composing, setComposing] = useState(false);
  const composingRef = useRef(false);
  const blockedComposition = useRef<{ committedDraft?: string } | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const [value, setValue] = useState<{ identity: PresendRevision; result: PresendReading } | null>(null);
  const [pending, setPending] = useState(false);
  const revision = useRef(0);
  const localEdit = useRef<{
    sessionId: string; draft: string; ptyRevision: number; generation: number | null;
    editedAtMs: number; conversation: PresendConversation | null;
  } | null>(null);
  const identity = useRef<PresendRevision>({ sessionId, draft, target, revision: 0, provider, ptyRevision, conversationKey });
  identity.current = { sessionId, draft, target, revision: revision.current, provider, ptyRevision, conversationKey };

  useEffect(() => {
    if (!enabled || !visible) return;
    let mounted = true;
    const verify = () => {
      retryPreference.current = null;
      const update = preferenceUpdate.current;
      const preferenceRevision = presendTabPreferenceRevision(sessionId);
      const failed = () => {
        if (mounted) retryPreference.current = verify;
        return false;
      };
      verifiedPreference.current = sharedPresendTabEnabled(sessionId).then(value => {
        if (!mounted || typeof value !== "boolean") return failed();
        if (preferenceUpdate.current === update && presendTabPreferenceRevision(sessionId) === preferenceRevision
          && !presendTab(sessionId)?.paused && value !== (presendTab(sessionId)?.enabled ?? true)) {
          setPresendTabEnabled(sessionId, value);
        }
        return true;
      }, failed);
    };
    verify();
    return () => { mounted = false; verifiedPreference.current = null; retryPreference.current = null; };
  }, [enabled, ptyRevision, sessionId, visible]);

  useEffect(() => {
    composingRef.current = false;
    blockedComposition.current = null;
    setComposing(false);
  }, [sessionId, ptyRevision]);

  useEffect(() => {
    const current: PresendRevision = { sessionId, draft, target, provider, ptyRevision, conversationKey, revision: ++revision.current };
    identity.current = current;
    setValue(null);
    setPending(false);
    const existing = presendTab(sessionId);
    const edit = localEdit.current;
    if (!draft || (edit?.sessionId === sessionId && edit.ptyRevision !== ptyRevision)) existing?.attempted.clear();
    if (!visible || !enabled || !tabEnabled || target === "shell"
      || edit?.sessionId !== sessionId || edit.draft !== draft || edit.ptyRevision !== ptyRevision
      || keyForConversation(edit.conversation) !== conversationKey) {
      localEdit.current = null;
      return;
    }
    if (!shouldReadPresend({ enabled, tabEnabled, target, draft, composing, provider, quietMs: PRESEND_DELAY_MS })) return;
    const tab = existing ?? ensurePresendTab(sessionId);
    const ledger = presendAttemptLedger(tab, edit.generation);
    const attemptKey = presendAttemptKey(draft, provider);
    if (tab.attempted.has(attemptKey)) return;
    let disposed = false;
    let requestId: string | null = null;
    let finished = false;
    const isCurrent = Object.assign(() => {
      const settings = useSettingsStore.getState();
      const live = usePaneMetadataStore.getState().volatileMetadata[sessionId];
      return !disposed && visibleRef.current && !composingRef.current && useAiSettingsStore.getState().aiEnabled
        && settings.presendReadingEnabled && settings.paneComposerEnabled
        && presendTab(sessionId) === tab && tab.enabled && settings.presendReadingProvider === provider
        && codexRestoreNoticeRevision(sessionId) === ptyRevision
        && !isShell(sessionId, live) && keyForConversation(conversationOf(live)) === conversationKey
        && (useComposerStore.getState().draftBySession[sessionId] ?? "") === draft
        && samePresendRevision(current, identity.current);
    }, {
      requireForegroundAgent: true, generationAtEdit: edit.generation, editedAtMs: edit.editedAtMs,
      conversationAtEdit: edit.conversation,
    });
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    const attempt = async () => {
      if (!isCurrent()) return;
      const quietMs = Date.now() - started;
      if (quietMs < PRESEND_DELAY_MS) {
        timer = setTimeout(attempt, PRESEND_DELAY_MS - quietMs);
        return;
      }
      if (!await verifiedPreference.current || !isCurrent()
        || !shouldReadPresend({ enabled, tabEnabled, target, draft, composing, provider, quietMs, attempted: tab.attempted })) return;
      const pendingAttempt = ledger.pending.get(attemptKey);
      if (pendingAttempt) {
        void pendingAttempt.then(attempt);
        return;
      }
      requestId = `presend-${uuid()}`;
      setPending(true);
      let attempted = true;
      const submission = requestPresendReading(requestId, sessionId, draft, provider, isCurrent).then(result => {
        const reading = result && "reading" in result ? result : null;
        attempted = result !== null && ("reading" in result || result.disposition === "attempted" || result.attempted === true);
        if (isCurrent() && reading) setValue({ identity: current, result: reading });
      }).catch(() => undefined).finally(() => {
        finished = true;
        ledger.pending.delete(attemptKey);
        const currentTab = presendTab(sessionId);
        if (attempted && currentTab && currentPresendAttemptLedger(currentTab) === ledger
          && (codexRestoreNoticeEpoch(sessionId) ?? null) === edit.generation) {
          currentTab.attempted.add(attemptKey);
        }
        if (isCurrent()) setPending(false);
      });
      ledger.pending.set(attemptKey, submission);
    };
    timer = setTimeout(attempt, PRESEND_DELAY_MS);
    return () => {
      disposed = true;
      clearTimeout(timer);
      if (requestId && !finished) cancelPresendReading(requestId);
    };
  }, [sessionId, draft, target, enabled, provider, tabEnabled, composing, ptyRevision, conversationKey, visible]);

  const canRead = visible && enabled && tabEnabled && target !== "shell";
  const valid = canRead && !composing && value && samePresendRevision(value.identity, identity.current);
  return {
    enabled, tabEnabled, pause, pending: canRead && !composing && pending,
    waitingForAgent: tabEnabled && target === "shell",
    reading: valid ? value.result : null,
    recordEdit: (draft: string) => {
      const blocked = blockedComposition.current;
      if (!canRead || (blocked && (composingRef.current || blocked.committedDraft === draft))) {
        localEdit.current = null;
        return;
      }
      if (!composingRef.current) blockedComposition.current = null;
      retryPreference.current?.();
      localEdit.current = {
        sessionId, draft, ptyRevision: codexRestoreNoticeRevision(sessionId),
        generation: codexRestoreNoticeEpoch(sessionId) ?? null,
        editedAtMs: Date.now(),
        conversation: conversationOf(usePaneMetadataStore.getState().volatileMetadata[sessionId]),
      };
    },
    toggle: () => {
      if (!enabled) return;
      const update = ++preferenceUpdate.current;
      if (tabEnabled || pause) {
        pausePresendTab(sessionId);
        return;
      }
      const tab = ensurePresendTab(sessionId);
      const preferenceRevision = presendTabPreferenceRevision(sessionId);
      void sharedPresendTabEnabled(sessionId, true).then(allowed => {
        if (allowed === true && update === preferenceUpdate.current && presendTab(sessionId) === tab
          && presendTabPreferenceRevision(sessionId) === preferenceRevision) {
          verifiedPreference.current = Promise.resolve(true);
          setPresendTabEnabled(sessionId, true);
        }
      }).catch(() => undefined);
    },
    compositionStart: () => {
      composingRef.current = true;
      blockedComposition.current = canRead ? null : {};
      if (!canRead) localEdit.current = null;
      setComposing(true);
    },
    compositionEnd: (text: string) => {
      composingRef.current = false;
      if (blockedComposition.current) {
        blockedComposition.current.committedDraft = text;
        localEdit.current = null;
      }
      setComposing(false);
    },
  };
}
