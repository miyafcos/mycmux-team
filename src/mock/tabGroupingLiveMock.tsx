import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";

import "../global.css";
import "./tabGroupingLiveMock.css";

import { tabGroupingStrings } from "../components/dashboard/dashboardStrings";
import { TabGroupingPanel } from "../components/layout/TabGroupingPanel";
import { getTheme } from "../components/theme/themeDefinitions";
import { DEFAULT_THEME_BACKGROUND } from "../lib/themeBackgrounds";
import { resolveTheme, resolvedThemeToCssVars } from "../lib/theme/resolveTheme";
import {
  __resetPersistenceCoordinatorForTests,
  createPersistenceLeaderPersist,
  markPersistentSchemaSupported,
  registerPersistenceLeader,
} from "../lib/workspacePersistenceCoordinator";
import {
  __resetGroupingRuntimeForTests,
  recordPersistentSchemaState,
  useGroupingRuntimeStore,
} from "../stores/groupingRuntimeStore";
import { usePaneMetadataStore } from "../stores/paneMetadataStore";
import { useSessionAttentionStore } from "../stores/sessionAttentionStore";
import { useUiStore } from "../stores/uiStore";
import { useWorkspaceListStore } from "../stores/workspaceListStore";
import { mockWorkspaces } from "../../tests/unit/fixtures/tabGroupingMockScenario";

type ThemeId = "mayonaka" | "paper";
type GuideStep = 0 | 1 | 2 | 3;

const LIVE_MOCK_MARKER = "MYCMUX_GROUPING_LIVE_MOCK";

const GUIDE = [
  {
    title: "① 案を比較する",
    operations: [
      "案件別・役割別・移動最小の3案を切り替えます。",
      "各案で動くタブ数と新しいワークスペース数を比べます。",
      "「現在」と「適用後」で配置の差を確認します。",
    ],
    next: "この案でよければ「この案で確認」、直すなら「内容を編集」を押します。",
  },
  {
    title: "② 内容を編集する",
    operations: [
      "左のグループで「再配置する」「現状維持」を選びます。",
      "タブを選び、右の配置図の移動先ペインをクリックします。",
      "タブはドラッグして移動先ペインへ落とせます。",
      tabGroupingStrings.dragCancelHint,
      "「変更対象のみ表示」で動くタブだけに絞れます。",
    ],
    next: "内容が決まったら、「適用前確認へ」を押します。",
  },
  {
    title: "③ 適用前に確認する",
    operations: [
      "現在の配置と適用後の配置を見比べます。",
      "移動するタブと残るタブを差分で確認します。",
      "タブをクリックすると、その1本だけ固定して追えます。",
      "気になる場合は編集へ戻って直せます。",
    ],
    next: "問題がなければ、「適用」を押します。",
  },
  {
    title: "④ 適用して元に戻す",
    operations: [
      "本物の façade が配置変更と保存処理を行います。",
      "適用後は画面下のバーから変更内容を確認できます。",
      "「元に戻す」で適用直前の配置へ戻せます。",
    ],
    next: "もう一度試すときは、左下の「最初からやり直す」を押します。",
  },
] as const;

let disposePersistenceLeader: (() => void) | null = null;

function seedScenario(): void {
  const now = Date.now();
  disposePersistenceLeader?.();
  disposePersistenceLeader = null;
  __resetGroupingRuntimeForTests();
  __resetPersistenceCoordinatorForTests();
  markPersistentSchemaSupported(1);
  recordPersistentSchemaState({ loadedSchemaVersion: 1, migrationComplete: true });

  useWorkspaceListStore.setState({
    workspaces: structuredClone(mockWorkspaces),
    layoutRevision: 1,
    activeWorkspaceId: "wsA",
    lastActivePaneByWorkspace: {
      wsA: "session-t請求",
      wsB: "session-t統括",
      wsC: "session-t数学",
    },
  });
  useUiStore.setState({
    sidebarCollapsed: false,
    isKeybindingsOpen: false,
    activePaneId: "session-t請求",
    lastActivePaneId: "session-t請求",
    focusRevision: 0,
    zoomedPaneId: null,
  });
  usePaneMetadataStore.setState({
    metadata: {
      "session-t請求": { processIsShell: false, agentStatus: "working", agentKind: "codex" },
      "session-tkessan": { agentStatus: "waiting", agentKind: "codex" },
      "session-t統括": { agentStatus: "done", agentKind: "claude" },
      "session-t数学": { agentStatus: "idle", agentKind: "codex" },
      "session-t模試": { agentStatus: "idle", agentKind: "claude" },
    },
    volatileMetadata: {
      "session-t請求": { outputActive: true, backendLastOutputAt: now - 12 * 60_000 },
      "session-tkessan": { backendLastOutputAt: now - 35 * 60_000 },
      "session-t統括": { backendLastOutputAt: now - 2 * 60 * 60_000 },
      "session-t数学": { backendLastOutputAt: now - 4 * 60 * 60_000 },
      "session-t模試": { backendLastOutputAt: now - 8 * 60_000 },
    },
  });
  useSessionAttentionStore.setState({
    attentionBySession: {
      "session-t模試": {
        sessionId: "session-t模試",
        sessionEpoch: null,
        attentionId: "mock-error",
        kind: "error",
        detail: "mock error",
        sessionRevision: 1,
        uiState: "waiting",
        stateSince: now,
        occurrenceOrder: 1,
      },
    },
    seenAttentionByTab: new Map(),
  });

  disposePersistenceLeader = registerPersistenceLeader({
    windowId: "grouping-live-mock",
    persist: createPersistenceLeaderPersist({
      isLeader: () => true,
      sync: async (request) => ({
        requestId: request.requestId,
        savedRevision: request.revision,
        savedSignature: request.signature,
        savedDigest: request.snapshotDigest,
        leaderGeneration: request.leaderGeneration,
      }),
      failure: () => ({ error: "unused", retryScheduled: false, failureGeneration: 0 }),
    }),
  });
}

function readGuideStep(): GuideStep {
  if (document.querySelector(".cmux-tab-grouping-undo")) return 3;
  const current = document.querySelector<HTMLElement>('.cmux-tab-grouping-step[aria-current="step"]');
  if (current?.textContent?.includes("2")) return 1;
  if (current?.textContent?.includes("3")) return 2;
  const body = document.querySelector<HTMLElement>(".cmux-tab-grouping-body");
  if (body?.classList.contains("is-edit")) return 1;
  if (body?.classList.contains("is-confirm")) return 2;
  return 0;
}

function resolvedThemeStyle(themeId: ThemeId): CSSProperties {
  const theme = getTheme(themeId);
  const { resolved } = resolveTheme({
    theme,
    background: { ...DEFAULT_THEME_BACKGROUND, mode: "solid", solidSurfaces: true },
    mediaActive: false,
  });
  return {
    ...resolvedThemeToCssVars(resolved),
    colorScheme: resolved.colorScheme,
  } as CSSProperties;
}

function findEnabledButton(label: string): HTMLButtonElement | null {
  return [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => !button.disabled && button.textContent?.trim() === label) ?? null;
}

async function waitFor<T>(probe: () => T | null, timeoutMs = 8_000): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = probe();
    if (result !== null) return result;
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
  throw new Error("Live mock flow check timed out.");
}

async function clickEnabledButton(label: string): Promise<void> {
  const button = await waitFor(() => findEnabledButton(label));
  button.click();
}

async function configureEvidenceScenario(): Promise<void> {
  await waitFor(() => document.querySelector<HTMLElement>(".cmux-tab-grouping-editmap"));
  const groups = [...document.querySelectorAll<HTMLElement>(".cmux-tab-grouping-group")];
  const productionGroup = groups.find((group) => group.textContent?.includes("モモスタ制作"));
  const accountingGroup = groups.find((group) => group.textContent?.includes("請求と決算"));
  if (!productionGroup || !accountingGroup) throw new Error("The evidence groups are missing.");

  productionGroup.click();
  await clickEnabledButton(tabGroupingStrings.changeDestination);
  const destinationMenu = await waitFor(() => document.querySelector<HTMLElement>('[role="menu"][aria-label="変更"]'));
  const destination = [...destinationMenu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((button) => button.textContent?.trim() === "UDR・PC整理");
  if (!destination) throw new Error("The UDR evidence destination is missing.");
  destination.click();
  await waitFor(() => document.querySelector(".cmux-tab-grouping-dest strong")?.textContent?.includes("UDR・PC整理") ? true : null);

  const currentAccountingGroup = [...document.querySelectorAll<HTMLElement>(".cmux-tab-grouping-group")]
    .find((group) => group.textContent?.includes("請求と決算"));
  if (!currentAccountingGroup) throw new Error("The current accounting group is missing.");
  currentAccountingGroup.click();
  const keep = [...currentAccountingGroup.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    .find((button) => button.textContent?.trim() === tabGroupingStrings.dispositionKeep);
  if (!keep) throw new Error("The accounting keep-current control is missing.");
  keep.click();
  await waitFor(() => {
    const current = [...document.querySelectorAll<HTMLElement>(".cmux-tab-grouping-group")]
      .find((group) => group.textContent?.includes("請求と決算"));
    const currentKeep = [...(current?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])]
      .find((button) => button.textContent?.trim() === tabGroupingStrings.dispositionKeep);
    return currentKeep?.getAttribute("aria-checked") === "true" ? true : null;
  });
}

async function pinAndMeasureMoveEndpoints(): Promise<void> {
  const lines = await waitFor(() => {
    const candidates = [...document.querySelectorAll<SVGPathElement>("path.cmux-tab-grouping-line")];
    return candidates.length >= 2 && document.querySelector(".cmux-tab-grouping-movebadge") ? candidates : null;
  });
  if (document.querySelectorAll(".cmux-tab-grouping-line-arrow").length < lines.length) {
    const sourceHeading = document.querySelector<HTMLElement>(
      '.cmux-tab-grouping-sidebyside-pane.is-before [data-workspace-id="wsA"] .cmux-tab-grouping-workspace-head',
    );
    if (!sourceHeading) throw new Error("The evidence source workspace heading is missing.");
    sourceHeading.click();
  }
  const arrows = await waitFor(() => {
    const candidates = [...document.querySelectorAll<SVGPathElement>(".cmux-tab-grouping-line-arrow")];
    return candidates.length >= lines.length ? candidates : null;
  });
  await waitFor(() => arrows.every((arrow) => {
    const rect = arrow.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }) ? true : null);
  const panelBody = document.querySelector<HTMLElement>(".cmux-tab-grouping-body")?.getBoundingClientRect();
  if (!panelBody) throw new Error("The Panel body is missing for endpoint measurement.");
  const occluders = [
    document.querySelector<HTMLElement>(".cmux-tab-grouping-footer")?.getBoundingClientRect(),
    document.querySelector<HTMLElement>(".cmux-tab-grouping-undo")?.getBoundingClientRect(),
  ].filter((rect): rect is DOMRect => Boolean(rect));
  for (const arrow of arrows) {
    const rect = arrow.getBoundingClientRect();
    const overlapsOccluder = occluders.some((occluder) => (
      rect.left < occluder.right && occluder.left < rect.right
      && rect.top < occluder.bottom && occluder.top < rect.bottom
    ));
    const visible = rect.width > 0
      && rect.height > 0
      && rect.left >= Math.max(0, panelBody.left)
      && rect.right <= Math.min(window.innerWidth, panelBody.right)
      && rect.top >= Math.max(0, panelBody.top)
      && rect.bottom <= Math.min(window.innerHeight, panelBody.bottom)
      && !overlapsOccluder;
    arrow.dataset.mockEndpointVisible = String(visible);
  }
}

async function goToConfirmationStep(): Promise<void> {
  await clickEnabledButton(tabGroupingStrings.editPlan);
  await waitFor(() => document.querySelector(".cmux-tab-grouping-editmap") ? true : null);
  await configureEvidenceScenario();
  await clickEnabledButton("適用前確認へ");
  await waitFor(() => document.querySelector(".cmux-tab-grouping-sidebyside") ? true : null);
}

async function runFlowCheck(): Promise<void> {
  await goToConfirmationStep();
  await clickEnabledButton("適用");
  await waitFor(() => {
    const runtime = useGroupingRuntimeStore.getState();
    return runtime.undo?.status === "available" && runtime.durability.status === "saved" ? true : null;
  });
  await clickEnabledButton("元に戻す");
  await waitFor(() => {
    const runtime = useGroupingRuntimeStore.getState();
    return runtime.undo === null && runtime.durability.status === "saved" ? true : null;
  });
  await clickEnabledButton("最初からやり直す");
  await waitFor(() => {
    const currentStep = document.querySelector<HTMLElement>('.cmux-tab-grouping-step[aria-current="step"]');
    const runtime = useGroupingRuntimeStore.getState();
    const workspaces = useWorkspaceListStore.getState();
    return currentStep?.textContent?.includes("1 案を比較")
      && runtime.undo === null
      && workspaces.layoutRevision === 1
      ? true
      : null;
  });
}

function LiveMockApp() {
  const initialTheme = new URLSearchParams(window.location.search).get("theme") === "paper" ? "paper" : "mayonaka";
  const [themeId, setThemeId] = useState<ThemeId>(initialTheme);
  const [guideStep, setGuideStep] = useState<GuideStep>(0);
  const [panelKey, setPanelKey] = useState(0);
  const [runtimeErrors, setRuntimeErrors] = useState(0);
  const durability = useGroupingRuntimeStore((state) => state.durability.status);
  const themeStyle = useMemo(() => resolvedThemeStyle(themeId), [themeId]);
  const guide = GUIDE[guideStep];

  const reset = useCallback(() => {
    seedScenario();
    setGuideStep(0);
    setPanelKey((value) => value + 1);
    document.documentElement.dataset.flowCheck = "idle";
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("selftest") === "1" || params.get("step") !== "2") return;
    document.documentElement.dataset.mockStep = "running";
    void clickEnabledButton(tabGroupingStrings.editPlan)
      .then(() => waitFor(() => document.querySelector(".cmux-tab-grouping-editmap") ? true : null))
      .then(() => {
        const firstChip = document.querySelector<HTMLButtonElement>(
          ".cmux-tab-grouping-editmap button.cmux-tab-grouping-chip",
        );
        if (!firstChip) throw new Error("The step-2 mock has no selectable tab chip.");
        firstChip.click();
      })
      .then(() => waitFor(() => document.querySelector(".cmux-tab-grouping-selectbar") ? true : null))
      .then(
        () => {
          document.documentElement.dataset.mockStep = "2";
        },
        (error) => {
          console.error(error);
          document.documentElement.dataset.mockStep = "failed";
          setRuntimeErrors((count) => count + 1);
        },
      );
  }, []);

  useEffect(() => {
    document.documentElement.dataset.liveMock = LIVE_MOCK_MARKER;
    document.documentElement.dataset.theme = themeId;
    document.body.dataset.cmuxThemedRoot = "true";
    for (const [name, value] of Object.entries(themeStyle)) {
      if (name.startsWith("--")) document.body.style.setProperty(name, String(value));
    }
    document.body.style.colorScheme = themeId === "paper" ? "light" : "dark";
    return () => {
      delete document.body.dataset.cmuxThemedRoot;
      for (const name of Object.keys(themeStyle)) {
        if (name.startsWith("--")) document.body.style.removeProperty(name);
      }
      document.body.style.removeProperty("color-scheme");
    };
  }, [themeId, themeStyle]);

  useEffect(() => {
    const update = () => setGuideStep(readGuideStep());
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["aria-current", "class", "data-undo-revision"],
      childList: true,
      subtree: true,
    });
    update();
    return () => observer.disconnect();
  }, [panelKey]);

  useEffect(() => {
    const onError = () => setRuntimeErrors((count) => count + 1);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onError);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onError);
    };
  }, []);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("selftest") !== "1") return;
    document.documentElement.dataset.flowCheck = "running";
    void runFlowCheck().then(
      () => {
        document.documentElement.dataset.flowCheck = "passed";
      },
      (error) => {
        console.error(error);
        document.documentElement.dataset.flowCheck = "failed";
        setRuntimeErrors((count) => count + 1);
      },
    );
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("selftest") === "1" || params.get("step") !== "3") return;
    document.documentElement.dataset.mockStep = "running";
    void goToConfirmationStep().then(() => pinAndMeasureMoveEndpoints()).then(
      () => {
        document.documentElement.dataset.mockStep = "3";
      },
      (error) => {
        console.error(error);
        document.documentElement.dataset.mockStep = "failed";
        setRuntimeErrors((count) => count + 1);
      },
    );
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("selftest") === "1" || params.get("step") !== "4") return;
    document.documentElement.dataset.mockStep = "running";
    void goToConfirmationStep()
      .then(() => pinAndMeasureMoveEndpoints())
      .then(() => clickEnabledButton("適用"))
      .then(() => waitFor(() => document.querySelector(".cmux-tab-grouping-undo") ? true : null))
      .then(() => pinAndMeasureMoveEndpoints())
      .then(
        () => {
          document.documentElement.dataset.mockStep = "4";
        },
        (error) => {
          console.error(error);
          document.documentElement.dataset.mockStep = "failed";
          setRuntimeErrors((count) => count + 1);
        },
      );
  }, []);

  return (
    <main className="grouping-live-mock" style={themeStyle} data-live-mock={LIVE_MOCK_MARKER}>
      <header className="grouping-live-mock__topbar">
        <div className="grouping-live-mock__brand">
          <strong>mycmux タブ再配置</strong>
          <span>本物の Panel / engine / façade / store</span>
        </div>
        <div className="grouping-live-mock__theme-controls" aria-label="テーマ切替">
          <button
            type="button"
            className={`grouping-live-mock__button${themeId === "mayonaka" ? " is-active" : ""}`}
            aria-pressed={themeId === "mayonaka"}
            onClick={() => setThemeId("mayonaka")}
          >
            ダーク
          </button>
          <button
            type="button"
            className={`grouping-live-mock__button${themeId === "paper" ? " is-active" : ""}`}
            aria-pressed={themeId === "paper"}
            onClick={() => setThemeId("paper")}
          >
            ライト
          </button>
        </div>
      </header>

      <aside className="grouping-live-mock__guide" aria-live="polite">
        <p className="grouping-live-mock__eyebrow">操作ガイド {guideStep + 1} / 4</p>
        <section className="grouping-live-mock__guide-copy">
          <h1>{guide.title}</h1>
          <ul>
            {guide.operations.map((operation) => <li key={operation}>{operation}</li>)}
          </ul>
          <p className="grouping-live-mock__next"><strong>次へ：</strong>{guide.next}</p>
        </section>
        <div className="grouping-live-mock__guide-footer">
          <div className="grouping-live-mock__controls">
            <button type="button" className="grouping-live-mock__button" onClick={reset}>
              最初からやり直す
            </button>
            <button
              type="button"
              className="grouping-live-mock__button"
              onClick={() => setThemeId((value) => value === "mayonaka" ? "paper" : "mayonaka")}
            >
              {themeId === "mayonaka" ? "ライトへ" : "ダークへ"}
            </button>
          </div>
          <div className="grouping-live-mock__status" aria-label="モックの状態" data-error-count={runtimeErrors}>
            <span>保存 <strong>{durability}</strong></span>
            <span>エラー <strong>{runtimeErrors}</strong></span>
          </div>
          <details className="grouping-live-mock__instructions">
            <summary>操作の流れ</summary>
            <ol>
              <li>3案を切り替えて配置の違いを見る。</li>
              <li>使う案を選び、内容を編集する。</li>
              <li>適用前確認で差分を確かめる。</li>
              <li>「適用」でタブを再配置する。</li>
              <li>下のバーから「元に戻す」を押す。</li>
            </ol>
          </details>
        </div>
      </aside>

      <div className="grouping-live-mock__dashboard-frame" aria-hidden="true" />
      <TabGroupingPanel key={panelKey} open visible onClose={() => undefined} />
    </main>
  );
}

seedScenario();
createRoot(document.getElementById("root")!).render(<LiveMockApp />);
