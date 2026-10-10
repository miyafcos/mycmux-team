import { invoke } from "@tauri-apps/api/core";
import {
  TOAST_UNDO_DISMISS_MS,
  useToastStore,
  type ToastAction,
  type ToastCategory,
  type ToastKind,
} from "../../stores/toastStore";
import { useAiSettingsStore } from "../../stores/aiSettingsStore";
import { useSettingsStore } from "../../stores/settingsStore";
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
  type Verdict,
} from "./tabSweep";

type AutoSweepSettings = {
  aiEnabled: boolean;
  aiProvider: Parameters<typeof formatJudgeError>[1];
  autoSweepCloseWithoutConfirmation?: boolean;
};

export interface AutoSweepReview {
  report: SweepReport;
  plan: SweepPlan;
  verdicts: Verdict[];
  fallbackReason?: string;
}

export type ConfirmAutoSweep = (review: AutoSweepReview) => Promise<readonly string[] | null>;

export function sweepReviewTargetIds(plan: SweepPlan): string[] {
  return [...(plan.closeDeadTabIds ?? []), ...(plan.closeCandidateTabIds ?? [])];
}

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
  confirmSweep: ConfirmAutoSweep;
}

export interface AutoSweepRunResult {
  renamed: number;
  closed: number;
  fallback: boolean;
  cancelled?: boolean;
}

function defaultRequestId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const defaultDependencies: AutoSweepDependencies = {
  settings: () => ({
    ...useAiSettingsStore.getState(),
    autoSweepCloseWithoutConfirmation: useSettingsStore.getState().autoSweepCloseWithoutConfirmation,
  }),
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
  // A missing review host must never silently authorize closing panes.
  confirmSweep: async () => null,
};

// トーストは 8 秒で消えて履歴が残らないので、機能名を頭に置いて 1 行で
// 「誰が何をしたか」が読めるようにする (2026-09-09 作者の指摘)。
const SWEEP_LABEL = "ペインの自動掃除";

function completionMessage(closed: number): string {
  return closed > 0
    ? `${SWEEP_LABEL}: ${closed}件のペインを閉じました`
    : `${SWEEP_LABEL}: 閉じる対象のペインはありませんでした`;
}

export function createAutoSweepRunner(dependencies: AutoSweepDependencies = defaultDependencies) {
  let running: Promise<AutoSweepRunResult> | null = null;

  const showDetails = (): ToastAction => ({ label: "内訳", run: dependencies.openDetails });
  const applyReviewed = async (review: AutoSweepReview, confirm: ConfirmAutoSweep): Promise<SweepApplyResult | null> => {
    const ids = sweepReviewTargetIds(review.plan);
    if (ids.length === 0) return { renamed: 0, closed: 0, skipped: [], errors: [] };
    let plan = review.plan;
    if (!dependencies.settings().autoSweepCloseWithoutConfirmation) {
      let approved: readonly string[] | null;
      try {
        approved = await confirm(review);
      } catch {
        approved = null;
      }
      if (!approved || approved.length === 0) {
        dependencies.pushToast(`${SWEEP_LABEL}: 確認を取り消しました。ペインは閉じていません`, "info", undefined, undefined, "user-action");
        return null;
      }
      const selected = new Set(approved);
      plan = {
        ...plan,
        closeDeadTabIds: plan.closeDeadTabIds?.filter((id) => selected.has(id)),
        ...(plan.closeCandidateTabIds ? { closeCandidateTabIds: plan.closeCandidateTabIds.filter((id) => selected.has(id)) } : {}),
      };
    }
    return dependencies.applySweep(plan);
  };
  const fallback = async (reason: unknown, provider: AutoSweepSettings["aiProvider"], confirm: ConfirmAutoSweep): Promise<AutoSweepRunResult> => {
    const report = await dependencies.scanTabs();
    const prefix = formatJudgeError(reason, provider).summary;
    const result = await applyReviewed({ report, verdicts: [], fallbackReason: prefix, plan: { closeDeadTabIds: buildSweepRows(report)
      .filter((row) => row.kind === "DEAD")
      .map((row) => row.tab.id) } }, confirm);
    if (!result) return { renamed: 0, closed: 0, fallback: true, cancelled: true };
    dependencies.pushToast(
      result.closed > 0
        ? `${SWEEP_LABEL}: AI判定を使えなかったため、終了済みの${result.closed}件だけ閉じました。${prefix}`
        : `${SWEEP_LABEL}: AI判定を使えなかったため、終了済みのペインだけを対象にしました。${prefix}`,
      "info",
      [showDetails()],
      undefined,
      "failure",
    );
    return { renamed: 0, closed: result.closed, fallback: true };
  };

  const execute = async (confirm: ConfirmAutoSweep): Promise<AutoSweepRunResult> => {
    const settings = dependencies.settings();
    if (!settings.aiEnabled) return fallback({ code: "ai_disabled" }, settings.aiProvider, confirm);

    try {
      const report = await dependencies.scanTabs();
      const rows = buildSweepRows(report);
      const candidates = rows.filter((row) => row.kind === "CANDIDATE").map((row) => row.tab);
      const judgeRaw = candidates.length > 0
        ? await dependencies.invokeJudge(buildJudgePrompt(candidates, []), dependencies.requestId())
        : "[]";
      const judged = parseJudgeOutputResult(judgeRaw, candidates.map((tab) => tab.id));
      if (!judged.valid) throw { code: "parse_failed", detail: "judge output was not a complete valid JSON array" };

      const plan: SweepPlan = {
        closeDeadTabIds: rows.filter((row) => row.kind === "DEAD").map((row) => row.tab.id),
        closeCandidateTabIds: judged.verdicts
          .filter((verdict) => verdict.verdict === "done_waiting")
          .map((verdict) => verdict.id),
        verdicts: judged.verdicts,
      };
      const closeResult = await applyReviewed({ report, plan, verdicts: judged.verdicts }, confirm);
      if (!closeResult) return { renamed: 0, closed: 0, fallback: false, cancelled: true };
      const closed = closeResult.closed;
      const undoable = closed > 0;
      const actions: ToastAction[] = undoable
        ? [{
            label: "取り消し",
            run: () => {
              dependencies.restoreClosedTabs(closed);
              dependencies.pushToast(`${SWEEP_LABEL}: 閉じたペインの記録を復元しました。実行状態は戻りません`, "info", undefined, undefined, "user-action");
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
        return await fallback(error, settings.aiProvider, confirm);
      } catch (fallbackError) {
        dependencies.pushToast(
          `${SWEEP_LABEL}に失敗しました: ${formatJudgeError(fallbackError, settings.aiProvider).summary}`,
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
    run: (confirm: ConfirmAutoSweep = dependencies.confirmSweep): Promise<AutoSweepRunResult | undefined> => {
      if (running) return Promise.resolve(undefined);
      running = execute(confirm).finally(() => { running = null; });
      return running;
    },
  };
}

const defaultRunner = createAutoSweepRunner();

export function runAutoSweep(confirm?: ConfirmAutoSweep): Promise<AutoSweepRunResult | undefined> {
  return defaultRunner.run(confirm);
}
