import { useCallback, useEffect, useState } from "react";

import {
  finalizeSavepoint,
  onSavepointPublishProgress,
  publishSavepoint,
  type PublishSavepointResult,
  type SavepointCloseReason,
  type SavepointPublishStage,
} from "../lib/ipc";
import { savepointIdentityKey, type SavepointAgentKind } from "../components/online/onlineSavepoints";

export interface SavepointPublishState {
  publishing: boolean;
  stage: SavepointPublishStage | null;
  result: PublishSavepointResult | null;
}

export interface SavepointPublishRequest {
  cwd: string;
  agentKind: SavepointAgentKind;
  agentSessionId: string;
  summary?: string;
  nextStep?: string;
  recordKind?: "current" | "final";
  closedReason?: SavepointCloseReason;
}

export type SavepointPublishOutcome =
  | { ok: true; result: PublishSavepointResult }
  | { ok: false; error: unknown };

type UseSavepointPublishOptions =
  | { mode: "single"; identity: string | null }
  | { mode: "keyed" };

const IDLE_STATE: SavepointPublishState = {
  publishing: false,
  stage: null,
  result: null,
};

export function useSavepointPublish(options: UseSavepointPublishOptions) {
  const identity = options.mode === "single" ? options.identity : null;
  const [state, setState] = useState<SavepointPublishState>(IDLE_STATE);
  const [stateByIdentity, setStateByIdentity] = useState<
    Record<string, SavepointPublishState>
  >({});

  useEffect(() => {
    if (options.mode === "single") {
      setState((current) => ({ ...current, stage: null, result: null }));
      if (!identity) return;
    }

    const unlisten = onSavepointPublishProgress((progress) => {
      const progressIdentity = savepointIdentityKey(
        progress.agent_kind,
        progress.agent_session_id,
      );
      if (options.mode === "single") {
        if (progressIdentity === identity) {
          setState((current) => ({ ...current, stage: progress.stage }));
        }
        return;
      }

      setStateByIdentity((current) => {
        const publishState = current[progressIdentity];
        if (!publishState?.publishing) return current;
        return {
          ...current,
          [progressIdentity]: { ...publishState, stage: progress.stage },
        };
      });
    });
    return () => {
      void unlisten.then((dispose) => dispose()).catch(() => undefined);
    };
  }, [identity, options.mode]);

  const run = useCallback(
    async (request: SavepointPublishRequest): Promise<SavepointPublishOutcome> => {
      const requestIdentity = savepointIdentityKey(
        request.agentKind,
        request.agentSessionId,
      );
      const runningState: SavepointPublishState = {
        publishing: true,
        stage: null,
        result: null,
      };

      if (options.mode === "single") {
        setState(runningState);
      } else {
        setStateByIdentity((current) => ({
          ...current,
          [requestIdentity]: runningState,
        }));
      }

      try {
        const result = request.recordKind === "final"
          ? await finalizeSavepoint({
              cwd: request.cwd,
              agentKind: request.agentKind,
              agentSessionId: request.agentSessionId,
              summary: request.summary,
              nextStep: request.nextStep,
              closedReason: request.closedReason,
            })
          : await publishSavepoint({
              cwd: request.cwd,
              agentKind: request.agentKind,
              agentSessionId: request.agentSessionId,
              summary: request.summary,
              nextStep: request.nextStep,
            });

        if (options.mode === "single") {
          setState((current) => ({ ...current, publishing: false, result }));
        } else {
          setStateByIdentity((current) => ({
            ...current,
            [requestIdentity]: { publishing: false, stage: "done", result },
          }));
        }
        return { ok: true, result };
      } catch (error) {
        if (options.mode === "single") {
          setState(IDLE_STATE);
        } else {
          setStateByIdentity((current) => ({
            ...current,
            [requestIdentity]: IDLE_STATE,
          }));
        }
        return { ok: false, error };
      }
    },
    [options.mode],
  );

  return { state, stateByIdentity, run };
}
