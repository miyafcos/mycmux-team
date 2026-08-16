// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  refresh: vi.fn(),
  preview: vi.fn(),
  go: vi.fn(),
  cancel: vi.fn(),
  retry: vi.fn(),
}));

vi.mock("../../src/lib/workOrderCommands", () => ({
  workorderCreateDraft: mocks.create,
  workorderRefreshSources: mocks.refresh,
  workorderPreview: mocks.preview,
  workorderGo: mocks.go,
  workorderCancel: mocks.cancel,
  workorderRetrySpawn: mocks.retry,
}));

import { WorkOrderContract } from "../../src/components/dashboard/WorkOrderContract";
import type { DashboardCardModel } from "../../src/components/dashboard/dashboardModel";
import { dashboardStrings } from "../../src/components/dashboard/dashboardStrings";
import { logicalSessionId } from "../../src/lib/logicalSessionId";
import { useComposerStore } from "../../src/stores/composerStore";
import { useDashboardViewStore } from "../../src/stores/dashboardViewStore";
import { useWorkOrderStore } from "../../src/stores/workOrderStore";

function card(id: string, sessionId: string, label: string): DashboardCardModel {
  return {
    workspace: { id: "ws", name: "ws", gridTemplateId: "1x1", panes: [], status: "running", createdAt: 0, splitColumns: [] },
    workspaceId: "ws",
    workspaceIndex: 0,
    pane: { id: "pane", agentId: "codex", sessionId, activeTabId: id, tabs: [] },
    paneId: "pane",
    paneIndex: 0,
    tab: { id, sessionId, label, type: "terminal", agentKind: "codex" },
    tabIndex: 0,
    background: false,
    attentionCategory: null,
    group: "working",
    status: "working",
    lastActivityAt: 0,
    label,
    agentKind: "codex",
    unobserved: false,
    neverStarted: false,
    noUpdateMinutes: null,
    metadata: { cwd: "C:\\repo" },
  };
}

function preview(overrides: Record<string, unknown> = {}) {
  return {
    plan: {} as never,
    coverage: { target: 2, acquired: 2, missing: 0, failed: 0 },
    outbox: [],
    sources: [
      { logicalSessionId: "pty-a", label: "A", snapshotEventId: "event-a", currentTask: null, latestInstruction: null, activity: null, openQuestions: [], acquired: true, failureReason: null },
      { logicalSessionId: "pty-b", label: "B", snapshotEventId: "event-b", currentTask: null, latestInstruction: null, activity: null, openQuestions: [], acquired: true, failureReason: null },
    ],
    integratorPrompt: "目的と素材を確認し、完了条件を満たしてください",
    writeTarget: { branch: "branch", path: "C:\\safe" },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

let container: HTMLDivElement;
let root: Root;
const first = card("tab-a", "pty-a", "A");
const second = card("tab-b", "pty-b", "B");

function seed(text = "これらを統合して") {
  useComposerStore.setState({
    draftBySession: { "pty-a": text },
    mentionTokensBySession: {
      "pty-a": [
        { kind: "session", logicalSessionId: logicalSessionId("tab-a"), sessionId: "pty-a", labelSnapshot: "A" },
        { kind: "session", logicalSessionId: logicalSessionId("tab-b"), sessionId: "pty-b", labelSnapshot: "B" },
      ],
    },
  });
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  });
}

async function render(onFix: () => void = vi.fn()): Promise<void> {
  await act(async () => {
    root.render(<WorkOrderContract card={first} mentionTargets={[first, second]} reportInboxOpen={false} onFix={onFix} />);
  });
  await flushAsync();
}

function button(label: string): HTMLButtonElement {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((entry) => entry.textContent === label)!;
}

function roleChip(id: string): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>(`[data-contract-role-for='${id}']`)!;
}

async function chooseRole(id: string, label: string): Promise<void> {
  await act(async () => roleChip(id).click());
  const choice = Array.from(container.querySelectorAll<HTMLButtonElement>("[role='menuitem']")).find((entry) => entry.textContent === label)!;
  await act(async () => choice.click());
  await flushAsync();
}

function row(label: string): HTMLElement {
  const term = Array.from(container.querySelectorAll<HTMLElement>(".cmux-dashboard-contract-rows dt")).find((entry) => entry.textContent === label)!;
  return term.nextElementSibling as HTMLElement;
}

function assertNoProhibitedTerms(): void {
  const attributes = Array.from(container.querySelectorAll<HTMLElement>("[aria-label], [title]"))
    .map((entry) => `${entry.getAttribute("aria-label") ?? ""} ${entry.getAttribute("title") ?? ""}`)
    .join(" ");
  expect(`${container.textContent} ${attributes}`).not.toMatch(/WorkOrder|Integrator|Source|worktree|workorder|outbox|seal|coverage/i);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.create.mockResolvedValue({ workOrderId: "draft-1" });
  mocks.refresh.mockResolvedValue({ coverage: { target: 2, acquired: 2, missing: 0, failed: 0 }, sources: preview().sources });
  mocks.preview.mockResolvedValue(preview());
  mocks.go.mockResolvedValue({ sealed: "sealed", spawnRequestId: "spawn-1", coverage: { target: 2, acquired: 2, missing: 0, failed: 0 } });
  mocks.cancel.mockResolvedValue({ deletedDraft: true, stopTargets: [] });
  mocks.retry.mockResolvedValue({ spawnRequestId: "retry-1" });
  seed();
  useDashboardViewStore.setState({ selectedTabId: first.tab.id, chatColumnTabIds: [first.tab.id], activeChatColumn: 0, reportInboxOpen: false });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  useComposerStore.setState({ draftBySession: {}, mentionTokensBySession: {}, commandKindBySession: {}, questionGuardBySession: {} });
  useWorkOrderStore.setState({ contractDraftBySession: {}, dismissedSignatureBySession: {} });
  useDashboardViewStore.setState({ selectedTabId: null, chatColumnTabIds: [], activeChatColumn: 0, reportInboxOpen: false });
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("WorkOrderContract", () => {
  it("renders the seven rows in the approved order", async () => {
    await render();
    const labels = Array.from(container.querySelectorAll(".cmux-dashboard-contract-rows dt")).map((entry) => entry.textContent);
    expect(labels).toEqual([
      dashboardStrings.contractPurpose,
      dashboardStrings.contractMaterials,
      dashboardStrings.contractExecution,
      dashboardStrings.contractReferenceLabel,
      dashboardStrings.contractWrite,
      dashboardStrings.contractCompletion,
      dashboardStrings.contractCoverage,
    ]);
    expect(container.textContent).toContain(dashboardStrings.contractBeforeGo);
    expect(container.textContent).toContain(dashboardStrings.contractNoSourceSend);
  });

  it("rebuilds the preview after a role change and re-enables GO", async () => {
    await render();
    const secondPreview = deferred<ReturnType<typeof preview>>();
    mocks.create.mockResolvedValueOnce({ workOrderId: "draft-2" });
    mocks.preview.mockImplementationOnce(() => secondPreview.promise);

    await act(async () => roleChip("tab-a").click());
    const review = Array.from(container.querySelectorAll<HTMLButtonElement>("[role='menuitem']")).find((entry) => entry.textContent === dashboardStrings.contractRoleReview)!;
    await act(async () => review.click());
    await flushAsync();
    expect(container.textContent).toContain(dashboardStrings.contractRefreshing);
    expect(button(dashboardStrings.contractGo).disabled).toBe(true);
    expect(mocks.cancel).toHaveBeenCalledWith("draft-1");

    secondPreview.resolve(preview());
    await flushAsync();
    expect(button(dashboardStrings.contractGo).disabled).toBe(false);
    await act(async () => button(dashboardStrings.contractGo).click());
    await flushAsync();
    expect(mocks.go).toHaveBeenCalledWith("draft-2", expect.any(Object));
  });

  it("debounces continuous composer edits and cancels before creating one replacement", async () => {
    await render();
    expect(mocks.create).toHaveBeenCalledTimes(1);
    await act(async () => {
      useComposerStore.getState().setDraft("pty-a", "これらを統合して実");
      useComposerStore.getState().setDraft("pty-a", "これらを統合して実装");
      useComposerStore.getState().setDraft("pty-a", "これらを統合して実装する");
    });
    await act(async () => vi.advanceTimersByTimeAsync(499));
    expect(mocks.create).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    await flushAsync();
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
    expect(mocks.cancel.mock.invocationCallOrder[0]).toBeLessThan(mocks.create.mock.invocationCallOrder[1]);
  });

  it("cancels a newly created draft when source refresh fails", async () => {
    mocks.refresh.mockRejectedValueOnce("source snapshots not ready");
    await render();
    expect(mocks.cancel).toHaveBeenCalledWith("draft-1");
    expect(container.textContent).toContain(dashboardStrings.contractSourceAcquisitionFailed);
    expect(button(dashboardStrings.contractGo).disabled).toBe(true);
  });

  it("preserves a manually corrected role when composer text changes", async () => {
    await render();
    mocks.create.mockResolvedValueOnce({ workOrderId: "draft-2" });
    await chooseRole("tab-a", dashboardStrings.contractRoleReview);
    expect(roleChip("tab-a").textContent).toContain(dashboardStrings.contractRoleReview);

    mocks.create.mockResolvedValueOnce({ workOrderId: "draft-3" });
    await act(async () => useComposerStore.getState().setDraft("pty-a", "これらを統合して最後まで実装する"));
    await act(async () => vi.advanceTimersByTimeAsync(500));
    await flushAsync();
    expect(roleChip("tab-a").textContent).toContain(dashboardStrings.contractRoleReview);
    const latestPlan = mocks.create.mock.calls.at(-1)?.[0];
    expect(latestPlan.bindings.find((binding: { logicalSessionId: string }) => binding.logicalSessionId === "pty-a")?.roles).toEqual(["reviewer"]);
  });

  it("hides production implementation values in ready, menu, error, and GO states", async () => {
    mocks.preview.mockResolvedValue(preview({
      writeTarget: { branch: "hidden", path: "C:\\Users\\x\\.mycmux-worktrees\\workorder-12345678-integration" },
      integratorPrompt: "WorkOrder Integrator Source worktree outbox seal coverage",
    }));
    await render();
    expect(row(dashboardStrings.contractWrite).textContent).toContain(dashboardStrings.contractWriteTarget);
    expect(row(dashboardStrings.contractWrite).textContent).toContain(dashboardStrings.contractBranchProtection);
    await act(async () => roleChip("tab-a").click());
    assertNoProhibitedTerms();
    await act(async () => {
      const current = useWorkOrderStore.getState().contractDraftBySession["pty-a"]!;
      useWorkOrderStore.getState().setContract("pty-a", { ...current, phase: "error", error: dashboardStrings.contractOperationFailed });
    });
    assertNoProhibitedTerms();
    await act(async () => {
      const current = useWorkOrderStore.getState().contractDraftBySession["pty-a"]!;
      useWorkOrderStore.getState().setContract("pty-a", {
        ...current,
        phase: "running",
        preview: preview({ outbox: [{ workItemId: "integration", intentKind: "spawn", status: "pending", reason: "outbox sealed" }] }),
      });
    });
    assertNoProhibitedTerms();
  });

  it("shows a failed launch request and its reason without inventing progress", async () => {
    await render();
    mocks.preview.mockResolvedValueOnce(preview({
      outbox: [{ workItemId: "integration", intentKind: "spawn", status: "failed", reason: "起動プログラムが応答しませんでした" }],
    }));
    await act(async () => button(dashboardStrings.contractGo).click());
    await flushAsync();
    expect(container.textContent).toContain(dashboardStrings.contractLaunchFailed);
    expect(container.textContent).toContain("起動プログラムが応答しませんでした");
    expect(container.querySelector(".cmux-dashboard-contract-progress")).toBeNull();
    expect(container.textContent).toContain(dashboardStrings.contractHumanApprovalRequired);
  });

  it("does not call a pending launch request running", async () => {
    await render();
    mocks.preview.mockResolvedValueOnce(preview({
      outbox: [{ workItemId: "integration", intentKind: "spawn", status: "pending", reason: null }],
    }));
    await act(async () => button(dashboardStrings.contractGo).click());
    await flushAsync();
    expect(container.textContent).toContain(dashboardStrings.contractLaunchPending);
    expect(container.textContent).not.toContain("統合役が作業中");
    expect(container.textContent).not.toContain("実行中");
  });

  it("keeps the running view when the composer is edited afterwards", async () => {
    await render();
    mocks.preview.mockResolvedValue(preview({
      outbox: [{ workItemId: "integration", intentKind: "spawn", status: "in_flight", reason: null }],
    }));
    await act(async () => button(dashboardStrings.contractGo).click());
    await flushAsync();
    expect(container.textContent).toContain(dashboardStrings.contractRunMerge);

    const createCalls = mocks.create.mock.calls.length;
    await act(async () => {
      useComposerStore.getState().setDraft("pty-a", "これらを統合して、あとひとこと足す");
    });
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    await flushAsync();

    // Editing the composer must not replace the only view of what is running,
    // nor quietly start a second draft behind it.
    expect(container.textContent).toContain(dashboardStrings.contractRunMerge);
    expect(container.textContent).not.toContain(dashboardStrings.contractBeforeGo);
    expect(mocks.create.mock.calls.length).toBe(createCalls);
  });

  it("names a session that does not exist yet without an @ handle", async () => {
    await render();
    const execution = row(dashboardStrings.contractExecution);
    expect(execution.textContent).toContain(dashboardStrings.contractNewSession);
    expect(execution.textContent).not.toContain(`@${dashboardStrings.contractNewSession}`);
  });

  it("distinguishes repository and source acquisition failures", async () => {
    mocks.preview.mockResolvedValueOnce(preview({ writeTarget: { unavailable: "not a git repository: C:\\plain" } }));
    await render();
    expect(container.textContent).toContain(dashboardStrings.contractRepositoryUnavailable);
    expect(button(dashboardStrings.contractGo).disabled).toBe(true);

    await act(async () => root.unmount());
    root = createRoot(container);
    useWorkOrderStore.setState({ contractDraftBySession: {}, dismissedSignatureBySession: {} });
    mocks.preview.mockResolvedValueOnce(preview({
      sources: [{ logicalSessionId: "pty-a", label: "A", snapshotEventId: null, currentTask: null, latestInstruction: null, activity: null, openQuestions: [], acquired: false, failureReason: "no livebrief snapshot for PTY session" }],
    }));
    await render();
    expect(container.textContent).toContain(dashboardStrings.contractMissingSources);
    expect(container.textContent).not.toContain(dashboardStrings.contractRepositoryUnavailable);
  });

  it("does not claim a new start when GO reports an existing request", async () => {
    await render();
    mocks.go.mockResolvedValueOnce({ sealed: "alreadySealed", spawnRequestId: null, coverage: { target: 2, acquired: 2, missing: 0, failed: 0 } });
    mocks.preview.mockResolvedValueOnce(preview({ outbox: [] }));
    await act(async () => button(dashboardStrings.contractGo).click());
    await flushAsync();
    expect(container.textContent).toContain(dashboardStrings.contractAlreadyStarted);
    expect(container.textContent).toContain(dashboardStrings.contractLaunchUnknown);
    expect(container.textContent).not.toContain("実行中");
  });

  it("names an assigned integrator and uses the new-session label only when needed", async () => {
    seed("Aの成果をBが統合して");
    await render();
    expect(row(dashboardStrings.contractExecution).textContent).toContain("@B");
    expect(row(dashboardStrings.contractExecution).textContent).not.toContain(dashboardStrings.contractNewSession);

    await act(async () => root.unmount());
    root = createRoot(container);
    useWorkOrderStore.setState({ contractDraftBySession: {}, dismissedSignatureBySession: {} });
    seed("これらを統合して");
    await render();
    expect(row(dashboardStrings.contractExecution).textContent).toContain(dashboardStrings.contractNewSession);
  });

  it("supports keyboard and outside dismissal and returns focus to the chip", async () => {
    await render();
    const chip = roleChip("tab-a");
    await act(async () => chip.click());
    await act(async () => vi.advanceTimersByTimeAsync(16));
    const items = Array.from(container.querySelectorAll<HTMLButtonElement>("[role='menuitem']"));
    expect(document.activeElement).toBe(items[0]);
    await act(async () => items[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement).toBe(items[1]);
    await act(async () => items[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    await act(async () => vi.advanceTimersByTimeAsync(16));
    expect(container.querySelector("[role='menu']")).toBeNull();
    expect(document.activeElement).toBe(chip);

    await act(async () => chip.click());
    await act(async () => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(container.querySelector("[role='menu']")).toBeNull();

    await act(async () => chip.click());
    const review = Array.from(container.querySelectorAll<HTMLButtonElement>("[role='menuitem']")).find((entry) => entry.textContent === dashboardStrings.contractRoleReview)!;
    await act(async () => review.click());
    await act(async () => vi.advanceTimersByTimeAsync(16));
    expect(document.activeElement).toBe(chip);
  });

  it("keeps one live blocker region mounted while its message changes", async () => {
    await render();
    const region = container.querySelector<HTMLElement>(".cmux-dashboard-contract-note")!;
    expect(region.getAttribute("role")).toBe("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.getAttribute("aria-atomic")).toBe("true");
    await chooseRole("integrator-pending", dashboardStrings.contractRoleWork);
    expect(container.querySelector(".cmux-dashboard-contract-note")).toBe(region);
    expect(region.textContent).toContain(dashboardStrings.contractMissingIntegrator);
  });

  it("focuses the composer without changing the selected session", async () => {
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    const before = useDashboardViewStore.getState().selectedTabId;
    await render(() => textarea.focus());
    expect(useDashboardViewStore.getState().selectedTabId).toBe(before);
    await act(async () => button(dashboardStrings.contractFix).click());
    expect(document.activeElement).toBe(textarea);
    expect(useDashboardViewStore.getState().selectedTabId).toBe(before);
    await act(async () => button(dashboardStrings.contractGo).click());
    await flushAsync();
    expect(useDashboardViewStore.getState().selectedTabId).toBe(before);
    textarea.remove();
  });

  it("offers retry only for a failed launch request", async () => {
    mocks.preview.mockResolvedValue(preview({
      outbox: [{ workItemId: "integration", intentKind: "spawn", status: "failed", reason: "起動できませんでした" }],
    }));
    await render();
    await act(async () => button(dashboardStrings.contractGo).click());
    await flushAsync();
    expect(button("もう一度起動する")).toBeInstanceOf(HTMLButtonElement);

    for (const status of ["pending", "in_flight", "delivered"] as const) {
      await act(async () => {
        const current = useWorkOrderStore.getState().contractDraftBySession["pty-a"]!;
        useWorkOrderStore.getState().setContract("pty-a", {
          ...current,
          preview: preview({ outbox: [{ workItemId: "integration", intentKind: "spawn", status, reason: null }] }),
        });
      });
      expect(Array.from(container.querySelectorAll("button")).map((entry) => entry.textContent)).not.toContain("もう一度起動する");
    }
  });

  it("retries a failed launch once and refreshes the preview", async () => {
    const pendingRetry = deferred<{ spawnRequestId: string }>();
    mocks.preview
      .mockResolvedValueOnce(preview())
      .mockResolvedValueOnce(preview({ outbox: [{ workItemId: "integration", intentKind: "spawn", status: "failed", reason: "起動できませんでした" }] }))
      .mockResolvedValueOnce(preview({ outbox: [{ workItemId: "integration", intentKind: "spawn", status: "pending", reason: null }] }));
    mocks.retry.mockImplementationOnce(() => pendingRetry.promise);
    await render();
    await act(async () => button(dashboardStrings.contractGo).click());
    await flushAsync();

    await act(async () => {
      button("もう一度起動する").click();
      button("もう一度起動する").click();
    });
    expect(mocks.retry).toHaveBeenCalledTimes(1);
    expect(mocks.retry).toHaveBeenCalledWith("draft-1");
    expect(button("もう一度起動する").disabled).toBe(true);

    pendingRetry.resolve({ spawnRequestId: "retry-1" });
    await flushAsync();
    expect(mocks.preview).toHaveBeenLastCalledWith("draft-1", "C:\\repo");
    expect(container.textContent).toContain(dashboardStrings.contractLaunchPending);
  });

  it("shows a retry failure reason without closing the running card", async () => {
    mocks.preview
      .mockResolvedValueOnce(preview())
      .mockResolvedValueOnce(preview({
        outbox: [{ workItemId: "integration", intentKind: "spawn", status: "failed", reason: "起動できませんでした" }],
      }));
    mocks.retry.mockRejectedValueOnce(new Error("再起動要求を送れませんでした"));
    await render();
    await act(async () => button(dashboardStrings.contractGo).click());
    await flushAsync();
    await act(async () => button("もう一度起動する").click());
    await flushAsync();
    expect(container.querySelector(".cmux-dashboard-contract.is-running")).not.toBeNull();
    expect(container.textContent).toContain("再起動要求を送れませんでした");
  });

  it("closes a running card without cancelling the work order", async () => {
    mocks.preview
      .mockResolvedValueOnce(preview())
      .mockResolvedValueOnce(preview({
        outbox: [{ workItemId: "integration", intentKind: "spawn", status: "failed", reason: "起動できませんでした" }],
      }));
    await render();
    await act(async () => button(dashboardStrings.contractGo).click());
    await flushAsync();
    await act(async () => button("表示を閉じる").click());
    expect(container.querySelector(".cmux-dashboard-contract")).toBeNull();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("redacts plural implementation terms and every path shape without discarding handoff context", async () => {
    mocks.preview.mockResolvedValue(preview({
      integratorPrompt: [
        "前段の引き渡し内容は残す。 worktrees と sources を確認する。",
        "win=C:\\Users\\x\\.mycmux-worktrees\\workorder-a\\handoff.md",
        "unc=\\\\?\\C:\\Users\\x\\.mycmux-worktrees\\workorder-a\\handoff.md",
        "relative=./.mycmux-worktrees/workorder-a/handoff.md",
        "unix=/tmp/.mycmux-worktrees/workorder-a/handoff.md",
        "後段の確認項目も残す。",
      ].join("\n"),
    }));
    await render();
    const text = container.querySelector("details pre")!.textContent!;
    expect(text).toContain("前段の引き渡し内容は残す。");
    expect(text).toContain("後段の確認項目も残す。");
    expect(text).not.toMatch(/\bworktrees?\b|\bsources?\b|\.mycmux-worktrees|C:\\Users|\\\\\?\\C:|\.\/\.mycmux|\/tmp\//i);
  });

  it("turns raw spawn backend errors into a user-facing launch reason", async () => {
    mocks.preview.mockResolvedValue(preview({
      outbox: [{ workItemId: "integration", intentKind: "spawn", status: "failed", reason: "emit workorder spawn request: refused" }],
    }));
    await render();
    await act(async () => button(dashboardStrings.contractGo).click());
    await flushAsync();
    expect(container.textContent).toContain(dashboardStrings.contractLaunchFailureUnknown);
    expect(container.textContent).not.toMatch(/\bemit\b|workorder|spawn request/i);
  });

  it("renders integrator handoff headings and failure reasons without internal IDs or English", async () => {
    mocks.preview.mockResolvedValue(preview({
      integratorPrompt: [
        "### 素材1: pty-a",
        "理由: no livebrief snapshot for PTY session",
        "### 素材2: pty-b",
        "理由: livebrief telemetry is stale",
        "### 素材3: pty-unknown",
        "理由: new backend failure",
        "- 素材1 (pty-a): 確認事項",
      ].join("\n"),
    }));
    await render();
    const text = container.querySelector("details pre")!.textContent!;
    expect(text).toContain("### 素材1: A");
    expect(text).toContain("### 素材2: B");
    expect(text).toContain("### 素材3: 名前を確認できない素材");
    expect(text).toContain("素材1 (A): 確認事項");
    expect(text).toContain("素材の記録を取得できませんでした");
    expect(text).toContain("セッションの状況を取得できませんでした");
    expect(text).toContain("状況を取得できませんでした");
    expect(text).not.toMatch(/pty-|no livebrief snapshot|livebrief telemetry|new backend failure/i);
  });
});
