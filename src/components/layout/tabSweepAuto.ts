import { invoke } from "@tauri-apps/api/core";
import {
  TOAST_UNDO_DISMISS_MS,
  useToastStore,
  type ToastAction,
  type ToastCategory,
  type ToastKind,
} from "../../stores/toastStore";
import { useAiSettingsStore } from "../../stores/aiSettingsStore";
import {
  applySweep,
  buildJudgePrompt,
  buildSweepRows,
  formatJudgeError,
  parseJudgeOutputResult,
  scanTabs,
  TAB_RESTORE_CLOSED_EVENT,
  TAB_SWEEP_OPEN_EVENT,
  type SweepApplyResult,
  type SweepPlan,
  type SweepReport,
} from "./tabSweep";

type AutoSweepSettings = { aiEnabled: boolean; aiProvider: Parameters<typeof formatJudgeError>[1] };

export interface AutoSweepDependencies {
  settings: () => AutoSweepSettings;
  scanTabs: () => Promise<SweepReport>;
  invokeJudge: (prompt: string, requestId: string) => Promise<string>;
  applySweep: (plan: SweepPlan) => Promise<SweepApplyResult>;
  pushToast: (
    message: string,
    kind: ToastKind,
    actions?: ToastAction[],
    durationMs?: number,
    category?: ToastCategory,
  ) => void;
  restoreClosedTabs: (count: number) => void;
  openDetails: () => void;
  requestId: () => string;
}

export interface AutoSweepRunResult {
  renamed: number;
  closed: number;
  fallback: boolean;
}

function defaultRequestId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const defaultDependencies: AutoSweepDependencies = {
  settings: () => useAiSettingsStore.getState(),
  scanTabs,
  invokeJudge: (prompt, requestId) => invoke<string>("run_tab_sweep_judge", { prompt, requestId }),
  applySweep,
  pushToast: (message, kind, actions, durationMs, category) =>
    useToastStore.getState().pushToast(message, kind, undefined, actions, durationMs, category),
  restoreClosedTabs: (count) => {
    for (let index = 0; index < count; index += 1) {
      window.dispatchEvent(new Event(TAB_RESTORE_CLOSED_EVENT));
    }
  },
  openDetails: () => window.dispatchEvent(new Event(TAB_SWEEP_OPEN_EVENT)),
  requestId: defaultRequestId,
};

function completionMessage(closed: number): string {
  return closed > 0 ? `${closed}件のタブを閉じました` : "掃除するタブはありませんでした";
}

export function createAutoSweepRunner(dependencies: AutoSweepDependencies = defaultDependencies) {
  let running: Promise<AutoSweepRunResult> | null = null;

  const showDetails = (): ToastAction => ({ label: "内訳", run: dependencies.openDetails });
  const fallback = async (reason: unknown, provider: AutoSweepSettings["aiProvider"]): Promise<AutoSweepRunResult> => {
    const report = await dependencies.scanTabs();
    const result = await dependencies.applySweep({ closeDeadTabIds: buildSweepRows(report)
      .filter((row) => row.kind === "DEAD")
      .map((row) => row.tab.id) });
    const prefix = formatJudgeError(reason, provider).summary;
    dependencies.pushToast(
      result.closed > 0
        ? `AI判定を使えなかったため、終了済みの${result.closed}件だけ閉じました。${prefix}`
        : `AI判定を使えなかったため、終了済みのタブだけを対象にしました。${prefix}`,
      "info",
      [showDetails()],
      undefined,
      "failure",
    );
    return { renamed: 0, closed: result.closed, fallback: true };
  };

  const execute = async (): Promise<AutoSweepRunResult> => {
    const settings = dependencies.settings();
    if (!settings.aiEnabled) return fallback({ code: "ai_disabled" }, settings.aiProvider);

    try {
      const report = await dependencies.scanTabs();
      const rows = buildSweepRows(report);
      const candidates = rows.filter((row) => row.kind === "CANDIDATE").map((row) => row.tab);
      const judgeRaw = candidates.length > 0
        ? await dependencies.invokeJudge(buildJudgePrompt(candidates, []), dependencies.requestId())
        : "[]";
      const judged = parseJudgeOutputResult(judgeRaw, candidates.map((tab) => tab.id));
      if (!judged.valid) throw { code: "parse_failed", detail: "judge output was not a complete valid JSON array" };

      const closeResult = await dependencies.applySweep({
        closeDeadTabIds: rows.filter((row) => row.kind === "DEAD").map((row) => row.tab.id),
        closeCandidateTabIds: judged.verdicts
          .filter((verdict) => verdict.verdict === "done_waiting")
          .map((verdict) => verdict.id),
        verdicts: judged.verdicts,
      });
      const closed = closeResult.closed;
      const undoable = closed > 0;
      const actions: ToastAction[] = undoable
        ? [{
            label: "取り消し",
            run: () => {
              dependencies.restoreClosedTabs(closed);
              dependencies.pushToast("元に戻しました", "info", undefined, undefined, "user-action");
            },
          }, showDetails()]
        : [showDetails()];
      dependencies.pushToast(
        completionMessage(closed),
        "info",
        actions,
        undoable ? TOAST_UNDO_DISMISS_MS : undefined,
        "ai-activity",
      );
      return { renamed: 0, closed, fallback: false };
    } catch (error) {
      try {
        return await fallback(error, settings.aiProvider);
      } catch (fallbackError) {
        dependencies.pushToast(
          `タブ掃除に失敗しました: ${formatJudgeError(fallbackError, settings.aiProvider).summary}`,
          "error",
          [showDetails()],
          undefined,
          "failure",
        );
        throw fallbackError;
      }
    }
  };

  return {
    get running() { return running !== null; },
    run: (): Promise<AutoSweepRunResult | undefined> => {
      if (running) return Promise.resolve(undefined);
      running = execute().finally(() => { running = null; });
      return running;
    },
  };
}

const defaultRunner = createAutoSweepRunner();

export function runAutoSweep(): Promise<AutoSweepRunResult | undefined> {
  return defaultRunner.run();
}
