// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CSSProperties } from "react";
import { presentSessionState, SESSION_STATE_LABELS } from "../../src/lib/sessionStatePresentation";
import type { SessionStatusSignals } from "../../src/lib/sessionStatusSignals";
import type { SessionAttention } from "../../src/stores/sessionAttentionStore";
import { useSessionAttentionStore } from "../../src/stores/sessionAttentionStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useDashboardViewStore } from "../../src/stores/dashboardViewStore";
import { useLiveBriefStore } from "../../src/stores/liveBriefStore";
import { useAskQuestionStore } from "../../src/stores/askQuestionStore";
import { DashboardButton } from "../../src/components/dashboard/DashboardButton";
import { yourTurnTargets, openYourTurn } from "../../src/components/dashboard/yourTurn";
import { useToastStore } from "../../src/stores/toastStore";
import { getTheme } from "../../src/components/theme/themeDefinitions";
import type { LiveSessionBrief } from "../../src/lib/livebrief";
import { stateLabels } from "../../src/components/dashboard/stateLabels";
import { buildDashboardCards, resolveDisplayState } from "../../src/components/dashboard/dashboardModel";
import type { Workspace } from "../../src/types";

const now = 100_000;
const attention = (kind: SessionAttention["kind"] = "none", uiState: SessionAttention["uiState"] = "working"): SessionAttention => ({
  sessionId: "session", sessionEpoch: 3, attentionId: kind === "none" ? null : `prompt-${kind}`,
  kind, detail: null, sessionRevision: 4, uiState, stateSince: now, occurrenceOrder: 1,
});
const signals: SessionStatusSignals = { activity: "running_silent", health: "fresh", lastMonitorAt: now,
  lastEvidenceAt: now, lastOutputAt: now - 90_000, processStartedAt: 1 };
const workspace: Workspace = { id: "ws", name: "作業", status: "running", createdAt: 1, gridTemplateId: "1x1",
  panes: [{ id: "pane", sessionId: "session", agentId: "codex", activeTabId: "tab", tabs: [
    { id: "tab", sessionId: "session", agentId: "codex", type: "terminal" },
    { id: "finished", sessionId: "finished", agentId: "codex", type: "terminal" },
  ] }] };

beforeEach(() => {
  useSessionAttentionStore.getState().resetForTests();
  useWorkspaceListStore.setState({ workspaces: [workspace] });
  useLiveBriefStore.setState({ briefsBySession: {}, observationsBySession: {} });
  useAskQuestionStore.setState({ bySession: {} });
  useDashboardViewStore.setState({ open: false, yourTurnTabId: null, query: "hidden", workspaceFilter: "other", agentFilter: "claude",
    stateFilter: "done", selectedTabId: null, chatColumnTabIds: [], pinnedChatColumnTabIds: [], activeChatColumn: 0 });
});

describe("shared canonical state presentation", () => {
  it("uses canonical evidence on the actual dashboard model path, including an unavailable feed", () => {
    const input = { metadataBySession: {}, volatileMetadataBySession: {}, lastLogBySession: {}, lastLogAtBySession: {},
      attentionBySession: { session: attention("done", "done") }, seenAttentionByTab: new Map<string, string>(),
      doneMarkByTab: new Map<string, number>(), stallsBySession: {}, now, hasTerminalBuffer: () => true };
    const [ended] = buildDashboardCards([workspace], { ...input, statusSignalsBySession: { session: { ...signals, activity: "streaming" } } });
    expect(resolveDisplayState(ended)).toBe("done");
    const [working] = buildDashboardCards([workspace], { ...input, attentionBySession: { session: attention() }, statusSignalsBySession: { session: signals } });
    expect(resolveDisplayState({ ...working, noUpdateMinutes: 120 })).toBe("running");
    const [unknown] = buildDashboardCards([workspace], { ...input, statusSignalsBySession: {} });
    expect(resolveDisplayState(unknown)).toBe("unknown");
  });
  it("keeps fresh silent work working", () => {
    expect(presentSessionState({ attention: attention(), signals, now })).toBe("running");
  });
  it.each(["streaming", "running_silent"] as const)("keeps canonical done and idle above %s output", (activity) => {
    expect(presentSessionState({ attention: attention("done", "done"), signals: { ...signals, activity }, now })).toBe("done");
    expect(presentSessionState({ attention: attention("none", "idle"), signals: { ...signals, activity }, now })).toBe("idle");
  });
  it.each(["stale", "unknown", "degraded"] as const)("does not certify %s evidence", (health) => {
    expect(presentSessionState({ attention: attention(), signals: { ...signals, health }, now })).toBe("unknown");
  });
  it("ages out a formerly fresh observation without equating it to idle", () => {
    expect(presentSessionState({ attention: attention(), signals, now: now + 31_000 })).toBe("unknown");
  });
  it.each(["input", "approval"] as const)("gives %s priority over process activity", (kind) => {
    expect(presentSessionState({ attention: attention(kind, "waiting"), signals, now })).toBe("needsHuman");
  });
  it("keeps AI turn end, human completion, errors and unavailable states distinct", () => {
    expect(stateLabels("done").primary).toBe("返答終了");
    expect(stateLabels("acknowledged").primary).toBe("完了");
    expect(stateLabels("error").primary).toBe("エラー");
    expect(stateLabels("unknown").primary).toBe("状態確認不能");
    expect(SESSION_STATE_LABELS.done).toBe(stateLabels("done").primary);
  });
});

describe("Your Turn mouse entry", () => {
  it("counts unresolved questions after they are seen and excludes ordinary turn end", () => {
    const pending = attention("approval", "waiting");
    const ended = { ...attention("done", "done"), sessionId: "finished" };
    expect(yourTurnTargets([workspace], { session: pending, finished: ended }, {}, { session: signals, finished: signals }, {}, now).map((tab) => tab.id)).toEqual(["tab"]);
    const legacy = structuredClone(workspace); delete legacy.panes[0].tabs[0].type;
    expect(yourTurnTargets([legacy], { session: pending }, {}, { session: signals }, {}, now)).toHaveLength(1);
    expect(yourTurnTargets([workspace], { session: pending }, {}, { session: { ...signals, health: "stale" } }, {}, now)).toHaveLength(0);
  });
  it("one click clears hiding filters and opens the existing question session", async () => {
    useSessionAttentionStore.setState({ attentionBySession: { session: attention("input", "waiting") },
      statusSignalsBySession: { session: { ...signals, lastMonitorAt: Date.now(), lastEvidenceAt: Date.now() } } });
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<DashboardButton />));
    const button = host.querySelector<HTMLButtonElement>(".cmux-your-turn")!;
    expect(button.textContent).toContain("あなたの番 1");
    await act(async () => button.click());
    expect(useDashboardViewStore.getState()).toMatchObject({ open: true, selectedTabId: "tab", query: "",
      workspaceFilter: null, agentFilter: null, stateFilter: null, chatColumnTabIds: ["tab"] });
    expect(button.textContent).toContain("あなたの番 1");
    await act(async () => root.unmount()); host.remove();
  });
  it("does not count stale questions after a fresh canonical turn end or epoch change", () => {
    const old = { ptySessionId: "session", ptyGeneration: 2, telemetryHealth: "live", operationalState: "needsHuman",
      lastSuccessfulReadAt: now, pendingInputKind: "choice", promptEventId: "old", promptHash: "old" } as LiveSessionBrief;
    expect(yourTurnTargets([workspace], { session: attention("done", "done") }, { session: old }, { session: signals }, {}, now)).toHaveLength(0);
    expect(yourTurnTargets([workspace], { session: { ...attention("input", "waiting"), sessionEpoch: 1 } },
      { session: { ...old, lastSuccessfulReadAt: 1 } }, { session: signals }, {}, now)).toHaveLength(0);
  });
  it("opens an existing question view without changing a fully pinned saved layout", () => {
    const columns = ["saved-1", "saved-2", "saved-3", "saved-4", "saved-5"];
    useDashboardViewStore.setState({ chatColumnLimit: 5, chatColumnTabIds: columns, pinnedChatColumnTabIds: columns, activeChatColumn: 0 });
    openYourTurn(workspace.panes[0].tabs[0]);
    expect(useDashboardViewStore.getState()).toMatchObject({ open: true, yourTurnTabId: "tab", chatColumnTabIds: columns, pinnedChatColumnTabIds: columns });
  });
  it("explains an empty question list on click", () => {
    openYourTurn(undefined);
    expect(useToastStore.getState().toasts.at(-1)?.message).toContain("質問・承認はありません");
  });
  it.each(["mayonaka", "geppaku"].flatMap((theme) => [800, 1280, 1920].map((width) => [theme, width] as const)))
    ("retains named controls for %s at %ipx (DOM evidence; browser layout remains separate)", (themeId, width) => {
    Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
    const theme = getTheme(themeId);
    const style = { width, "--cmux-bg-solid": theme.chrome.background, "--cmux-text": theme.chrome.text,
      "--cmux-text-secondary": theme.chrome.textMuted, "--cmux-border": theme.chrome.border,
      "--cmux-accent": theme.chrome.accent, "--status-waiting": theme.status.waiting } as CSSProperties;
    const html = renderToStaticMarkup(<div data-theme={themeId} style={style}><DashboardButton /></div>);
    expect(html).toContain("あなたの番"); expect(html).toContain("aria-label=");
    expect(html).toContain("cmux-your-turn");
    const evidenceDir = process.env.MYCMUX_MOUSE_UI_EVIDENCE_DIR;
    if (evidenceDir) {
      mkdirSync(evidenceDir, { recursive: true });
      const css = readFileSync("src/global.css", "utf8");
      writeFileSync(join(evidenceDir, `${themeId}-${width}.html`), `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}</style><body>${html}</body></html>`);
    }
  });
});

describe("review fix 2: stale canonical fallback", () => {
  const identity = { sessionId: "session", agentKind: "codex", agentSessionId: "current-conversation" };
  const brief = (operationalState: string): LiveSessionBrief => ({ ptySessionId: "session", ptyGeneration: 3,
    ptyInstanceId: "instance", agentKind: "codex", agentSessionId: "current-conversation", serviceEpoch: "service",
    telemetryHealth: "live", operationalState, lastSuccessfulReadAt: now, lastEventAt: now,
    updatedAt: now, sourceRevision: 1, ptyInputRevision: 1 } as LiveSessionBrief);
  it.each([["needsHuman", "needsHuman"], ["running", "running"]] as const)("uses a fresh bound %s brief", (state, expected) => {
    expect(presentSessionState({ attention: attention(), signals: { ...signals, health: "stale" },
      brief: brief(state), identity, now })).toBe(expected);
  });
  it.each(["both-stale", "session", "epoch", "conversation", "agent"] as const)("rejects %s evidence", (change) => {
    const candidate = brief("needsHuman");
    if (change === "both-stale") candidate.lastSuccessfulReadAt = now - 31_000;
    if (change === "session") candidate.ptySessionId = "other";
    if (change === "epoch") candidate.ptyGeneration = 2;
    if (change === "conversation") candidate.agentSessionId = "old-conversation";
    if (change === "agent") candidate.agentKind = "claude";
    expect(presentSessionState({ attention: attention(), signals: { ...signals, health: "stale" },
      brief: candidate, identity, now })).toBe("unknown");
  });
});
