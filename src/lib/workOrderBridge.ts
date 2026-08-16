import { handleSocketCommand } from "../components/layout/socketCommands";
import { useUiStore } from "../stores/uiStore";
import type { AgentSessionKind } from "../types";
import { workorderSpawnResult } from "./ipc";

export interface SpawnRequest {
  requestId: string;
  workOrderId: string;
  planVersion: number;
  workItemId: string;
  cwd: string;
  agentKind: AgentSessionKind;
  launchEnv: Record<string, string>;
  label: string;
}

type SpawnTabResult = {
  sessionId?: string;
};

const requests = new Map<string, Promise<void>>();
const REQUEST_LIMIT = 256;

function retainRequest(requestId: string, request: Promise<void>): void {
  requests.set(requestId, request);
  if (requests.size > REQUEST_LIMIT) {
    const oldest = requests.keys().next().value;
    if (oldest) requests.delete(oldest);
  }
}

/**
 * Creates the one integrator as a background tab and always records the
 * frontend outcome. The existing socket command owns tab lifecycle and does
 * not move the active tab when `activate` is false.
 */
export function handleWorkOrderSpawnRequest(payload: SpawnRequest): Promise<void> {
  const existing = requests.get(payload.requestId);
  if (existing) return existing;

  let succeeded = false;
  const request = (async () => {
    try {
      const anchorSessionId = useUiStore.getState().activePaneId;
      if (!anchorSessionId) throw new Error("no active session is available to anchor WorkOrder spawn");
      const promptFile = payload.launchEnv.MYCMUX_HANDOFF_PROMPT_FILE;
      if (!promptFile) throw new Error("WorkOrder spawn request is missing MYCMUX_HANDOFF_PROMPT_FILE");
      const spawned = await handleSocketCommand("pane.spawn_tab", {
        anchorSessionId,
        target: payload.agentKind,
        cwd: payload.cwd,
        label: payload.label,
        promptFile,
        activate: false,
      }) as SpawnTabResult;
      if (!spawned.sessionId) throw new Error("background WorkOrder tab did not return a session id");
      await workorderSpawnResult(payload.requestId, { sessionId: spawned.sessionId });
      succeeded = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await workorderSpawnResult(payload.requestId, { error: message });
    }
  })();
  retainRequest(payload.requestId, request);
  void request.then(
    () => {
      if (!succeeded && requests.get(payload.requestId) === request) {
        requests.delete(payload.requestId);
      }
    },
    () => {
      if (requests.get(payload.requestId) === request) {
        requests.delete(payload.requestId);
      }
    },
  );
  return request;
}
