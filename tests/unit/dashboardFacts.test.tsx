// @vitest-environment jsdom
//
// 気づき欄を外部 JSON から自前データへ移した回 (2026-09-16) の受け皿。
// 「観測できた事実だけを出す・判定は出さない」を DOM で固定する。

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridgeMocks = vi.hoisted(() => ({
  attentionListCards: vi.fn(),
  attentionResolveCard: vi.fn(),
  attentionSetTracked: vi.fn(),
}));
const eventMocks = vi.hoisted(() => ({ listen: vi.fn() }));

vi.mock("../../src/lib/attentionBridge", async () => ({
  ...(await vi.importActual<object>("../../src/lib/attentionBridge")),
  ...bridgeMocks,
}));
vi.mock("@tauri-apps/api/event", () => eventMocks);

import { AttentionCards, type AttentionCardActions } from "../../src/components/dashboard/AttentionCards";
import { DashboardCardRow } from "../../src/components/dashboard/DashboardCardRow";
import { DashboardSessionList } from "../../src/components/dashboard/DashboardSessionList";
import { dashboardStrings } from "../../src/components/dashboard/dashboardStrings";
import { buildDashboardCards, type DashboardCardModel } from "../../src/components/dashboard/dashboardModel";
import type { AttentionFactSource } from "../../src/components/dashboard/attentionModel";
import type { LiveSessionBrief } from "../../src/lib/livebrief";
import type { Workspace } from "../../src/types";
import { __resetAttentionStoreForTests } from "../../src/stores/attentionStore";
import { useAskQuestionStore } from "../../src/stores/askQuestionStore";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const now = 1_000_000;

function brief(overrides: Partial<LiveSessionBrief> = {}): LiveSessionBrief {
  return {
    ptySessionId: "s-1",
    agentSessionId: "agent-1",
    agentKind: "claude",
    ptyInstanceId: "pty-1",
    ptyGeneration: 1,
    sourceRevision: 1,
    ptyInputRevision: 1,
    task: null,
    latestInstruction: null,
    taskSourceEventIds: [],
    activityKind: null,
    activityText: null,
    activitySourceEventId: null,
    checkpoint: null,
    checkpointEvidenceEventIds: [],
    pendingInputKind: null,
    pendingPrompt: null,
    pendingOptions: [],
    promptEventId: null,
    promptHash: null,
    eventSeq: 1,
    operationalState: "running",
    telemetryHealth: "live",
    lastEventAt: now,
    lastSuccessfulReadAt: now,
    updatedAt: now,
    serviceEpoch: "epoch",
    briefRevision: 1,
    ...overrides,
  };
}

function source(overrides: Partial<AttentionFactSource> = {}): AttentionFactSource {
  return { sessionId: "s-1", label: "アルファ", brief: brief(), noUpdateMinutes: null, ...overrides };
}

function actions(): AttentionCardActions & { openSession: ReturnType<typeof vi.fn> } {
  const openSession = vi.fn();
  return {
    sessionLabel: () => "アルファ",
    openCardSession: vi.fn(),
    openSession,
    answerQuestion: vi.fn(),
    retryWorkItem: vi.fn().mockResolvedValue(undefined),
    openWorkOrder: vi.fn(),
    resolveCard: vi.fn().mockResolvedValue(undefined),
  };
}

function workspace(): Workspace {
  return {
    id: "ws-1",
    name: "Workspace A",
    gridTemplateId: "single",
    status: "active",
    createdAt: now,
    panes: [{
      id: "pane-1",
      sessionId: "s-1",
      activeTabId: "tab-1",
      tabs: [{ id: "tab-1", sessionId: "s-1", agentId: "claude", label: "アルファ", type: "terminal" }],
    }],
  } as Workspace;
}

function rowCard(activityText: string | null): DashboardCardModel {
  return buildDashboardCards([workspace()], {
    metadataBySession: {},
    volatileMetadataBySession: {},
    lastLogBySession: {},
    lastLogAtBySession: { "s-1": now },
    attentionBySession: {},
    seenAttentionByTab: new Map(),
    doneMarkByTab: new Map(),
    stallsBySession: {},
    briefsBySession: { "s-1": brief({ activityText }) },
    now,
    hasTerminalBuffer: () => true,
  })[0];
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  __resetAttentionStoreForTests();
  useAskQuestionStore.getState().resetForTests();
  vi.clearAllMocks();
  bridgeMocks.attentionListCards.mockResolvedValue([]);
  eventMocks.listen.mockResolvedValue(vi.fn());
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  __resetAttentionStoreForTests();
  useAskQuestionStore.getState().resetForTests();
});

async function renderAttention(sessions: readonly AttentionFactSource[], handlers = actions()) {
  await act(async () => {
    root.render(<AttentionCards {...handlers} sessions={sessions} />);
    await Promise.resolve();
  });
  return handlers;
}

describe("気づき欄の事実カード", () => {
  it("質問を出したまま待っている席は、質問文と選択肢をそのまま出す", async () => {
    const handlers = await renderAttention([source({
      brief: brief({
        pendingInputKind: "choice",
        pendingPrompt: "このまま進めますか\n(残りは 3 ファイル)",
        pendingOptions: [{ id: "1", label: "進める" }, { id: "2", label: "やめる" }],
      }),
    })]);

    const card = container.querySelector<HTMLElement>("[data-attention-fact-card]");
    expect(card?.dataset.attentionFactKind).toBe("pendingQuestion");
    expect(card?.querySelector("[data-attention-fact-prompt]")?.textContent)
      .toBe("このまま進めますか\n(残りは 3 ファイル)");
    const options = [...container.querySelectorAll("[data-attention-fact-options] li")].map((item) => item.textContent);
    expect(options).toEqual(["進める", "やめる"]);

    const chip = card?.querySelector<HTMLButtonElement>(".cmux-attention-card-session-chip");
    expect(chip?.textContent).toBe("アルファ");
    await act(async () => { chip?.click(); await Promise.resolve(); });
    expect(handlers.openSession).toHaveBeenCalledWith({ type: "pty", pty_session_id: "s-1" });
  });

  it("質問がなく 5 分しか経っていない席は、カードにしない", async () => {
    await renderAttention([source({ noUpdateMinutes: 5 })]);

    expect(container.querySelector("[data-attention-fact-card]")).toBeNull();
    expect(container.querySelector("[data-attention-empty]")?.textContent).toBe(dashboardStrings.attentionEmpty);
  });

  it("45 分 出力のない席は、経過と直前の一行を出す", async () => {
    await renderAttention([source({
      noUpdateMinutes: 45,
      brief: brief({ activityText: "テストを実行中\n2 本目" }),
    })]);

    const card = container.querySelector<HTMLElement>("[data-attention-fact-card]");
    expect(card?.dataset.attentionFactKind).toBe("noUpdate");
    expect(card?.textContent).toContain(dashboardStrings.attentionFactKindLabel("noUpdate", 45));
    expect(card?.querySelector(".cmux-attention-fact-detail")?.textContent).toBe("テストを実行中");
  });
});

describe("一覧の行", () => {
  it("最後に言ったことを 1 行だけ出す", async () => {
    await act(async () => {
      root.render(<DashboardCardRow
        card={rowCard("ファイルを書き換えています\n2 件目")}
        selected={false}
        open={false}
        now={now}
        hideWorkspaceBadge={false}
        onSelect={() => undefined}
        onJump={() => undefined}
      />);
      await Promise.resolve();
    });

    expect(container.querySelector(".cmux-dash-row-preview")?.textContent).toBe("ファイルを書き換えています");
  });
});

describe("セッション一覧のナビ", () => {
  it("報告インボックスのナビを出さない", async () => {
    await act(async () => {
      root.render(<DashboardSessionList
        needsHuman={[]}
        all={[]}
        deferred={[]}
        hideWorkspaceBadge={false}
        selectedTabId={null}
        now={now}
        onSelect={() => undefined}
        onJump={() => undefined}
        onHoverChange={() => undefined}
        query=""
        searchInputRef={createRef<HTMLInputElement>()}
        onQueryChange={() => undefined}
        onSearchFocusChange={() => undefined}
        onClose={() => undefined}
        clearDoneCount={0}
        onClearDone={() => undefined}
        filteredSummary={null}
        attentionOpen={false}
        onOpenAttention={() => undefined}
        collapsed={false}
        onToggleCollapsed={() => undefined}
      />);
      await Promise.resolve();
    });

    expect(container.querySelector("[data-report-inbox-nav]")).toBeNull();
    expect(container.textContent).not.toContain("報告インボックス");
    expect(container.querySelector("[data-attention-nav='true']")?.textContent)
      .toContain(dashboardStrings.attentionTitle);
  });
});
