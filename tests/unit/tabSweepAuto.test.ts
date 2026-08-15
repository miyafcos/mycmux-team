import { describe, expect, it, vi } from "vitest";
import { createAutoSweepRunner, type AutoSweepDependencies } from "../../src/components/layout/tabSweepAuto";
import type { SweepReport, SweepTab } from "../../src/components/layout/tabSweep";
import { TOAST_UNDO_DISMISS_MS } from "../../src/stores/toastStore";

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
    scanNamingContext: vi.fn(async () => []),
    scanTabs: vi.fn(async () => report()),
    invokeJudge: vi.fn(async () => "[]"),
    applySweep: vi.fn(async () => ({ closed: 0, renamed: 0, skipped: [], errors: [] })),
    pushToast: vi.fn(),
    restoreClosedTabs: vi.fn(),
    openDetails: vi.fn(),
    requestId: () => "request",
    ...overrides,
  };
}

describe("tab sweep auto", () => {
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

  it("undo restores names and each closed tab", async () => {
    const applySweep = vi.fn(async (plan) => ({
      closed: plan.closeDeadTabIds?.length ?? 0,
      renamed: plan.renames?.length ?? 0,
      skipped: [],
      errors: [],
    }));
    const pushToast = vi.fn();
    const restoreClosedTabs = vi.fn();
    const deps = dependencies({
      scanNamingContext: vi.fn(async () => [{ paneId: "pane", column: 1, tabs: [{
        id: "named", sessionId: "session-named", label: "元の名前", cwd: "", agentKind: "", isPaneHead: true, tail: [],
      }] }]),
      scanTabs: vi.fn(async () => report(tab("dead", "DEAD"))),
      invokeJudge: vi.fn(async (_prompt, _requestId, mode) => mode === "naming"
        ? JSON.stringify([{ id: "named", label: "新しい名前" }])
        : "[]"),
      applySweep,
      pushToast,
      restoreClosedTabs,
    });

    await createAutoSweepRunner(deps).run();
    const actions = pushToast.mock.calls[0][2];
    actions[0].run();
    await vi.waitFor(() => expect(restoreClosedTabs).toHaveBeenCalledWith(1));

    expect(applySweep).toHaveBeenLastCalledWith({ renames: [{ id: "named", label: "元の名前", overwrite: true }] });
    // Undo is the only safety net here, so its toast must outlive the default.
    expect(pushToast.mock.calls[0][3]).toBe(TOAST_UNDO_DISMISS_MS);
  });

  it("keeps the default toast lifetime when there is nothing to undo", async () => {
    const pushToast = vi.fn();

    await createAutoSweepRunner(dependencies({ pushToast })).run();

    expect(pushToast).toHaveBeenCalledWith("掃除するタブはありませんでした", "info", expect.any(Array), undefined);
  });

  it("ignores a second call while a sweep is running", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runner = createAutoSweepRunner(dependencies({
      scanNamingContext: vi.fn(async () => { await gate; return []; }),
    }));

    const first = runner.run();
    await Promise.resolve();
    await expect(runner.run()).resolves.toBeUndefined();
    release?.();
    await first;
  });
});
