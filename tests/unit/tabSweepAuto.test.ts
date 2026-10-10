import { describe, expect, it, vi } from "vitest";
import { createAutoSweepRunner, sweepReviewTargetIds, type AutoSweepDependencies } from "../../src/components/layout/tabSweepAuto";
import type { SweepReport, SweepTab } from "../../src/components/layout/tabSweep";
import { __resetToastStoreForTests, TOAST_UNDO_DISMISS_MS, useToastStore } from "../../src/stores/toastStore";
import { useSettingsStore } from "../../src/stores/settingsStore";

function tab(id: string, category: SweepTab["category"]): SweepTab {
  return {
    id,
    sessionId: `session-${id}`,
    workspaceId: "workspace",
    workspaceName: "Workspace",
    paneId: "pane",
    category,
    lockReasons: [],
    unnamed: false,
    tail: ["❯"],
    processStatusReason: null,
    lastOutputAt: 0,
  };
}

function report(...tabs: SweepTab[]): SweepReport {
  return {
    scannedAt: 0,
    tabs,
    dead: tabs.filter((item) => item.category === "DEAD"),
    locked: tabs.filter((item) => item.category === "LOCKED"),
    candidates: tabs.filter((item) => item.category === "CANDIDATE"),
    unnamed: [],
  };
}

function dependencies(overrides: Partial<AutoSweepDependencies> = {}): AutoSweepDependencies {
  return {
    settings: () => ({ aiEnabled: true, aiProvider: "codex" }),
    scanTabs: vi.fn(async () => report()),
    invokeJudge: vi.fn(async () => "[]"),
    applySweep: vi.fn(async () => ({ closed: 0, renamed: 0, skipped: [], errors: [] })),
    pushToast: vi.fn(),
    restoreClosedTabs: vi.fn(),
    openDetails: vi.fn(),
    requestId: () => "request",
    confirmSweep: vi.fn(async (review) => sweepReviewTargetIds(review.plan)),
    ...overrides,
  };
}

describe("tab sweep auto", () => {
  it("waits for human review before applying the judged candidates", async () => {
    let approve!: (ids: string[]) => void;
    const deps = dependencies({
      scanTabs: vi.fn(async () => report(tab("done", "CANDIDATE"))),
      invokeJudge: vi.fn(async () => '[{"id":"done","verdict":"done_waiting","reason":"作業が終わりました"}]'),
      confirmSweep: vi.fn(() => new Promise((resolve) => { approve = resolve; })),
    });
    const pending = createAutoSweepRunner(deps).run();
    await vi.waitFor(() => expect(deps.confirmSweep).toHaveBeenCalledTimes(1));
    expect(deps.applySweep).not.toHaveBeenCalled();
    expect(vi.mocked(deps.confirmSweep).mock.calls[0][0].verdicts[0].reason).toBe("作業が終わりました");
    approve(["done"]);
    await pending;
    expect(deps.applySweep).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])("cancelling closes no panes even with AI enabled=%s", async (aiEnabled) => {
    const deps = dependencies({
      settings: () => ({ aiEnabled, aiProvider: "codex" }),
      scanTabs: vi.fn(async () => report(tab("dead", "DEAD"))),
      confirmSweep: vi.fn(async () => null),
    });
    expect(await createAutoSweepRunner(deps).run()).toMatchObject({ closed: 0, cancelled: true });
    expect(deps.applySweep).not.toHaveBeenCalled();
  });

  it("keeps immediate closing behind the independent opt-in setting", async () => {
    const deps = dependencies({
      settings: () => ({ aiEnabled: true, aiProvider: "codex", autoSweepCloseWithoutConfirmation: true }),
      scanTabs: vi.fn(async () => report(tab("dead", "DEAD"))),
    });
    await createAutoSweepRunner(deps).run();
    expect(deps.confirmSweep).not.toHaveBeenCalled();
    expect(deps.applySweep).toHaveBeenCalledTimes(1);
  });

  it("applies only the displayed candidates left selected by the reviewer", async () => {
    const deps = dependencies({
      scanTabs: vi.fn(async () => report(tab("first", "DEAD"), tab("second", "DEAD"))),
      confirmSweep: vi.fn(async () => ["second", "not-in-the-review"]),
    });
    await createAutoSweepRunner(deps).run();
    expect(deps.applySweep).toHaveBeenCalledWith(expect.objectContaining({ closeDeadTabIds: ["second"] }));
  });

  it("a failed review host cannot fall through to closing DEAD panes", async () => {
    const deps = dependencies({
      scanTabs: vi.fn(async () => report(tab("dead", "DEAD"))),
      confirmSweep: vi.fn(async () => { throw new Error("host disappeared"); }),
    });
    await createAutoSweepRunner(deps).run();
    expect(deps.applySweep).not.toHaveBeenCalled();
  });
  it("closes only DEAD tabs when AI is disabled", async () => {
    const applySweep = vi.fn(async () => ({ closed: 1, renamed: 0, skipped: [], errors: [] }));
    const deps = dependencies({
      settings: () => ({ aiEnabled: false, aiProvider: "codex" }),
      scanTabs: vi.fn(async () => report(tab("dead", "DEAD"), tab("candidate", "CANDIDATE"))),
      applySweep,
    });

    await createAutoSweepRunner(deps).run();

    expect(applySweep).toHaveBeenCalledWith({ closeDeadTabIds: ["dead"] });
  });

  it("closes only done_waiting candidates", async () => {
    const applySweep = vi.fn(async () => ({ closed: 1, renamed: 0, skipped: [], errors: [] }));
    const deps = dependencies({
      scanTabs: vi.fn(async () => report(
        tab("dead", "DEAD"), tab("done", "CANDIDATE"), tab("working", "CANDIDATE"), tab("unknown", "CANDIDATE"),
      )),
      invokeJudge: vi.fn(async () => JSON.stringify([
        { id: "done", verdict: "done_waiting" },
        { id: "working", verdict: "working" },
        { id: "unknown", verdict: "unknown" },
      ])),
      applySweep,
    });

    await createAutoSweepRunner(deps).run();

    expect(applySweep).toHaveBeenCalledWith(expect.objectContaining({
      closeDeadTabIds: ["dead"],
      closeCandidateTabIds: ["done"],
    }));
  });

  it("undo restores each closed tab without renaming", async () => {
    const applySweep = vi.fn(async (plan) => ({
      closed: plan.closeDeadTabIds?.length ?? 0,
      renamed: 0,
      skipped: [],
      errors: [],
    }));
    const pushToast = vi.fn();
    const restoreClosedTabs = vi.fn();
    const deps = dependencies({
      scanTabs: vi.fn(async () => report(tab("dead", "DEAD"))),
      invokeJudge: vi.fn(async () => "[]"),
      applySweep,
      pushToast,
      restoreClosedTabs,
    });

    await createAutoSweepRunner(deps).run();
    const actions = pushToast.mock.calls[0][2];
    actions[0].run();
    await vi.waitFor(() => expect(restoreClosedTabs).toHaveBeenCalledWith(1), { timeout: 2000 });

    expect(applySweep).toHaveBeenCalledTimes(1);
    expect(restoreClosedTabs).toHaveBeenCalledWith(1);
    // Undo is the only safety net here, so its toast must outlive the default.
    expect(pushToast.mock.calls[0][3]).toBe(TOAST_UNDO_DISMISS_MS);
  });

  it("retains both undo operations for two same-count sweeps within twenty seconds", async () => {
    vi.useFakeTimers();
    __resetToastStoreForTests();
    const previous = useSettingsStore.getState();
    useSettingsStore.setState({ notificationsEnabled: true, toastAiActivityEnabled: true, toastUserActionEnabled: true });
    try {
      const firstRestore = vi.fn();
      const secondRestore = vi.fn();
      const sweep = (id: string, restoreClosedTabs: (count: number) => void) => createAutoSweepRunner(dependencies({
        scanTabs: vi.fn(async () => report(tab(id, "DEAD"))),
        applySweep: vi.fn(async () => ({ closed: 1, renamed: 0, skipped: [], errors: [] })),
        pushToast: (message, kind, actions, durationMs, category) =>
          useToastStore.getState().pushToast(message, kind, undefined, actions, durationMs, category),
        restoreClosedTabs,
      }));
      await sweep("first", firstRestore).run();
      const first = useToastStore.getState().toasts[0];
      vi.advanceTimersByTime(1000);
      await sweep("second", secondRestore).run();
      const second = useToastStore.getState().toasts[1];
      expect(useToastStore.getState().toasts).toHaveLength(2);
      expect(second.id).not.toBe(first.id);
      expect(second.message).toBe(first.message);
      expect(second.actions!.map(action => action.label)).toEqual(first.actions!.map(action => action.label));
      expect(second.actions![0].run).not.toBe(first.actions![0].run);
      vi.advanceTimersByTime(18999);
      expect(useToastStore.getState().toasts.map(toast => toast.id)).toEqual([first.id, second.id]);
      first.actions![0].run();
      expect(firstRestore).toHaveBeenCalledExactlyOnceWith(1);
      expect(secondRestore).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(useToastStore.getState().toasts.some(toast => toast.id === first.id)).toBe(false);
      expect(useToastStore.getState().toasts.some(toast => toast.id === second.id)).toBe(true);
      useToastStore.getState().toasts.find(toast => toast.id === second.id)!.actions![0].run();
      expect(firstRestore).toHaveBeenCalledExactlyOnceWith(1);
      expect(secondRestore).toHaveBeenCalledExactlyOnceWith(1);
      vi.advanceTimersByTime(1000);
      expect(useToastStore.getState().toasts.some(toast => toast.id === second.id)).toBe(false);
    } finally {
      __resetToastStoreForTests();
      useSettingsStore.setState({
        notificationsEnabled: previous.notificationsEnabled,
        toastAiActivityEnabled: previous.toastAiActivityEnabled,
        toastUserActionEnabled: previous.toastUserActionEnabled,
      });
      vi.useRealTimers();
    }
  });

  it("keeps the default toast lifetime when there is nothing to undo", async () => {
    const pushToast = vi.fn();

    await createAutoSweepRunner(dependencies({ pushToast })).run();

    expect(pushToast).toHaveBeenCalledWith(
      "ペインの自動掃除: 閉じる対象のペインはありませんでした",
      "info",
      expect.any(Array),
      undefined,
      "ai-activity",
    );
  });

  it("marks the AI fallback notice as an always-visible failure", async () => {
    const pushToast = vi.fn();

    await createAutoSweepRunner(dependencies({
      settings: () => ({ aiEnabled: false, aiProvider: "codex" }),
      pushToast,
    })).run();

    expect(pushToast).toHaveBeenCalledWith(
      expect.stringContaining("AI判定を使えなかったため"),
      "info",
      expect.any(Array),
      undefined,
      "failure",
    );
  });

  it("ignores a second call while a sweep is running", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runner = createAutoSweepRunner(dependencies({
      scanTabs: vi.fn(async () => { await gate; return report(); }),
    }));

    const first = runner.run();
    await Promise.resolve();
    await expect(runner.run()).resolves.toBeUndefined();
    release?.();
    await first;
  });
});
