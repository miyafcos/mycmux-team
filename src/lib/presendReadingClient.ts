import { invoke } from "@tauri-apps/api/core";
import { useAiSettingsStore } from "../stores/aiSettingsStore";
import { useSettingsStore } from "../stores/settingsStore";
import { usePaneMetadataStore } from "../stores/paneMetadataStore";
import { useWorkspaceListStore } from "../stores/workspaceListStore";
import { scrubPresendCredentials } from "./scrubCredentials";
import { getLiveBriefs, getLiveEvents, LIVE_EVENT_DETAIL_LIMIT } from "./livebrief";
import { PRESEND_CONTEXT_CHARS, presendWorkdirName, unicodeTail, type PresendReading, type PresendReadingProvider } from "./presendReading";
import { withTerminalDeadline } from "./terminalDeadline";

const PRESEND_CONTEXT_TIMEOUT_MS = 3_000;
let configuration = "";
let configured: Promise<unknown> = Promise.resolve();

function canRead(): boolean {
  const settings = useSettingsStore.getState();
  return settings.presendReadingEnabled && settings.paneComposerEnabled && useAiSettingsStore.getState().aiEnabled;
}

function syncConfiguration(force = false): Promise<unknown> {
  const settings = useSettingsStore.getState();
  const enabled = settings.presendReadingEnabled && settings.paneComposerEnabled && useAiSettingsStore.getState().aiEnabled;
  const provider = settings.presendReadingProvider;
  const key = `${enabled}:${provider}`;
  if (force || key !== configuration) {
    configuration = key;
    configured = configured.catch(() => undefined).then(() => invoke("configure_presend_reading", { enabled, provider }))
      .catch(error => {
        // Do not retry this draft. A later, different draft may configure again.
        if (configuration === key) configuration = "";
        throw error;
      });
  }
  return configured;
}

useSettingsStore.subscribe((state, previous) => {
  if (state.presendReadingEnabled === previous.presendReadingEnabled
    && state.presendReadingProvider === previous.presendReadingProvider
    && state.paneComposerEnabled === previous.paneComposerEnabled) return;
  // No IPC at all on the unchanged default-off path.
  if (!state.presendReadingEnabled && !previous.presendReadingEnabled && !configuration) return;
  void syncConfiguration().catch(() => undefined);
});

useAiSettingsStore.subscribe((state, previous) => {
  if (state.aiEnabled === previous.aiEnabled) return;
  if (!useSettingsStore.getState().presendReadingEnabled && !configuration) return;
  void syncConfiguration().catch(() => undefined);
});

function currentPtyGeneration(sessionId: string): Promise<number | null> {
  return invoke("get_codex_restore_epoch", { sessionId });
}

async function confirmedReply(sessionId: string, generation: number, isCurrent: () => boolean) {
  const batch = (await getLiveEvents([sessionId], LIVE_EVENT_DETAIL_LIMIT)).find(item => item.ptySessionId === sessionId);
  if (!isCurrent() || batch?.telemetryHealth !== "live") return;
  const event = [...batch.events].reverse().find(item => item.kind.type === "agentMessage");
  if (event?.kind.type !== "agentMessage" || !Number.isSafeInteger(event.occurredAt) || event.occurredAt <= 0) return;
  // The batch has no binding; the same brief revision identifies its snapshot.
  const brief = (await getLiveBriefs()).find(item => item.ptySessionId === sessionId);
  if (!isCurrent() || brief?.telemetryHealth !== "live" || brief.operationalState === "ended"
    || brief.briefRevision !== batch.briefRevision || brief.ptyGeneration !== generation
    || !brief.agentKind || !brief.agentSessionId) return;
  const owner = await invoke<string | null>("get_agent_conversation_owner", {
    kind: brief.agentKind, agentSessionId: brief.agentSessionId,
  });
  if (!isCurrent() || owner !== sessionId) return;
  const confirmedGeneration = await currentPtyGeneration(sessionId);
  if (!isCurrent() || confirmedGeneration !== generation) return;
  return {
    text: event.kind.text,
    source: {
      ptyGeneration: generation, agentKind: brief.agentKind, agentSessionId: brief.agentSessionId,
      occurredAt: event.occurredAt,
    },
  };
}

async function readContext(sessionId: string, isCurrent: () => boolean) {
  let active = true;
  let ptyGeneration: number | null = null;
  const canContinue = () => active && isCurrent();
  const collect = async () => {
    const generation = await currentPtyGeneration(sessionId);
    if (!canContinue() || generation === null || !Number.isSafeInteger(generation) || generation <= 0) return;
    ptyGeneration = generation;
    return confirmedReply(sessionId, generation, canContinue);
  };
  try {
    const reply = await withTerminalDeadline(collect(), "pre-send reply context", PRESEND_CONTEXT_TIMEOUT_MS);
    return { ptyGeneration, reply };
  } catch {
    // Keep the initial generation if a later lookup failed or timed out.
    return { ptyGeneration, reply: undefined };
  } finally {
    active = false;
  }
}

export async function requestPresendReading(
  requestId: string, sessionId: string, draft: string, provider: PresendReadingProvider,
  isCurrent: (() => boolean) & { requireForegroundAgent?: boolean },
): Promise<PresendReading | null> {
  let active = true;
  const current = () => active && isCurrent() && canRead();
  try {
    // Observe the PTY while configuration is pending. Submission waits for both.
    const configurationReady = syncConfiguration(true);
    const context = current() ? readContext(sessionId, current) : undefined;
    await configurationReady;
    if (!context || !current()) return null;
    const { ptyGeneration, reply } = await context;
    if (!current()) return null;
    let cwd = usePaneMetadataStore.getState().metadata[sessionId]?.cwd ?? "";
    if (!cwd) {
      const pane = useWorkspaceListStore.getState().workspaces.flatMap(workspace => workspace.panes)
        .find(candidate => candidate.tabs.some(tab => tab.sessionId === sessionId));
      cwd = pane?.tabs.find(candidate => candidate.sessionId === sessionId)?.cwd || pane?.cwd || "";
    }
    return invoke<PresendReading | null>("run_presend_reading", {
      requestId, sessionId, ptyGeneration, provider,
      ...(isCurrent.requireForegroundAgent ? { requireForegroundAgent: true } : {}),
      draft: scrubPresendCredentials(draft),
      conversationExcerpt: unicodeTail(scrubPresendCredentials(reply?.text ?? ""), PRESEND_CONTEXT_CHARS),
      replySource: reply?.source,
      workdirName: scrubPresendCredentials(presendWorkdirName(cwd)),
      workdirIsBasename: true,
    });
  } finally {
    active = false;
  }
}

export function cancelPresendReading(requestId: string): void {
  void invoke("cancel_presend_reading", { requestId }).catch(() => undefined);
}
