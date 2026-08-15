import { invoke } from "@tauri-apps/api/core";
import { TOAST_UNDO_DISMISS_MS, useToastStore, type ToastAction, type ToastKind } from "../../stores/toastStore";
import { useAiSettingsStore } from "../../stores/aiSettingsStore";
import {
  applySweep,
  buildJudgePrompt,
  buildNamingPrompt,
  buildSweepRows,
  formatJudgeError,
  parseJudgeOutputResult,
  parseNamingOutput,
  scanNamingContext,
  scanTabs,
  TAB_RESTORE_CLOSED_EVENT,
  TAB_SWEEP_OPEN_EVENT,
  type NamingPaneGroup,
  type SweepApplyResult,
  type SweepPlan,
  type SweepReport,
} from "./tabSweep";

type AutoSweepSettings = { aiEnabled: boolean; aiProvider: Parameters<typeof formatJudgeError>[1] };

export interface AutoSweepDependencies {
  settings: () => AutoSweepSettings;
  scanNamingContext: () => Promise<NamingPaneGroup[]>;
  scanTabs: () => Promise<SweepReport>;
  invokeJudge: (prompt: string, requestId: string, mode?: "naming") => Promise<string>;
  applySweep: (plan: SweepPlan) => Promise<SweepApplyResult>;
  pushToast: (message: string, kind: ToastKind, actions?: ToastAction[], durationMs?: number) => void;
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
  scanNamingContext,
  scanTabs,
  invokeJudge: (prompt, requestId, mode) => invoke<string>("run_tab_sweep_judge", { prompt, requestId, ...(mode ? { mode } : {}) }),
  applySweep,
  pushToast: (message, kind, actions, durationMs) =>
    useToastStore.getState().pushToast(message, kind, undefined, actions, durationMs),
  restoreClosedTabs: (count) => {
    for (let index = 0; index < count; index += 1) {
      window.dispatchEvent(new Event(TAB_RESTORE_CLOSED_EVENT));
    }
  },
  openDetails: () => window.dispatchEvent(new Event(TAB_SWEEP_OPEN_EVENT)),
  requestId: defaultRequestId,
};

function completionMessage(renamed: number, closed: number): string {
  const parts = [renamed > 0 ? `${renamed}件に名前を付け` : "", closed > 0 ? `${closed}件のタブを閉じました` : ""].filter(Boolean);
  return parts.length > 0 ? parts.join("、") : "掃除するタブはありませんでした";
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
    );
    return { renamed: 0, closed: result.closed, fallback: true };
  };

  const execute = async (): Promise<AutoSweepRunResult> => {
    const settings = dependencies.settings();
    if (!settings.aiEnabled) return fallback({ code: "ai_disabled" }, settings.aiProvider);

    try {
      const groups = await dependencies.scanNamingContext();
      const namingTabs = groups.flatMap((group) => group.tabs);
      const namingIds = namingTabs.map((tab) => tab.id);
      const namingRaw = namingIds.length > 0
        ? await dependencies.invokeJudge(buildNamingPrompt(groups), dependencies.requestId(), "naming")
        : "[]";
      const naming = parseNamingOutput(namingRaw, namingIds);
      if (!naming.valid) throw { code: "parse_failed", detail: "naming output was not a complete valid JSON array" };

      const report = await dependencies.scanTabs();
      const rows = buildSweepRows(report);
      const candidates = rows.filter((row) => row.kind === "CANDIDATE").map((row) => row.tab);
      const judgeRaw = candidates.length > 0
        ? await dependencies.invokeJudge(buildJudgePrompt(candidates, []), dependencies.requestId())
        : "[]";
      const judged = parseJudgeOutputResult(judgeRaw, candidates.map((tab) => tab.id));
      if (!judged.valid) throw { code: "parse_failed", detail: "judge output was not a complete valid JSON array" };

      const originalLabels = new Map(namingTabs.map((tab) => [tab.id, tab.label]));
      const renames = naming.proposals
        .filter((proposal) => originalLabels.get(proposal.id) !== proposal.label)
        .map((proposal) => ({ ...proposal, overwrite: true }));
      const renameResult = renames.length > 0
        ? await dependencies.applySweep({ renames })
        : { closed: 0, renamed: 0, skipped: [], errors: [] };
      const closeResult = await dependencies.applySweep({
        closeDeadTabIds: rows.filter((row) => row.kind === "DEAD").map((row) => row.tab.id),
        closeCandidateTabIds: judged.verdicts
          .filter((verdict) => verdict.verdict === "done_waiting")
          .map((verdict) => verdict.id),
        verdicts: judged.verdicts,
      });
      const renamed = renameResult.renamed;
      const closed = closeResult.closed;
      const undoRenames = renames.map((rename) => ({ id: rename.id, label: originalLabels.get(rename.id) ?? "", overwrite: true }));
      const undoable = closed > 0 || undoRenames.length > 0;
      const actions: ToastAction[] = undoable
        ? [{
            label: "取り消し",
            run: () => {
              void dependencies.applySweep({ renames: undoRenames }).finally(() => {
                dependencies.restoreClosedTabs(closed);
                dependencies.pushToast("元に戻しました", "info");
              });
            },
          }, showDetails()]
        : [showDetails()];
      dependencies.pushToast(
        completionMessage(renamed, closed),
        "info",
        actions,
        undoable ? TOAST_UNDO_DISMISS_MS : undefined,
      );
      return { renamed, closed, fallback: false };
    } catch (error) {
      try {
        return await fallback(error, settings.aiProvider);
      } catch (fallbackError) {
        dependencies.pushToast(`タブ掃除に失敗しました: ${formatJudgeError(fallbackError, settings.aiProvider).summary}`, "error", [showDetails()]);
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
