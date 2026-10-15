// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syntheticCatalog } from "../fixtures/agent_home/catalog";
import type { SessionDetail, SessionRow } from "../../src/lib/ailog";

// The real React components, stores, commands and event API run above core IPC.
const core = vi.hoisted(() => ({ invoke: vi.fn(), transformCallback: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(),
  invoke: core.invoke, transformCallback: core.transformCallback,
}));
import { AgentDesignPanel } from "../../src/components/agentDesign/AgentDesignPanel";
import { AgentDesignButton } from "../../src/components/agentDesign/AgentDesignButton";
import { AiLogButton } from "../../src/components/ailog/AiLogButton";
import { formatMoney } from "../../src/lib/ailog";
import { __resetAilogStoreForTests, useAilogStore } from "../../src/stores/ailogStore";
import { __resetAilogJobStoreForTests, useAilogJobStore } from "../../src/stores/useAilogJobStore";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
type Args = Record<string, any>;
type Pending = { command: string; args: Args; key: string; resolve: (value: unknown) => void; reject: (error: Error) => void; value: unknown };
const range = { from: 100, to: 200, label: "合成の期間" };
const priceCoverage = Object.fromEntries(["priced", "local", "internal", "flat", "reported", "unknown"].map(key => [key, { models: [], tokens: 0 } ]));
const totals = { sessions: 1, turns: 1, userMessages: 1, input: 10, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0, wallMs: 0, activeMs: 0, projects: 1, models: 1 };
const session: SessionRow = {
  kind: "codex", sessionId: "synthetic-reflection", title: "合成セッション", projectLabel: "サンプル企画",
  gitBranch: null, origin: null, primaryModel: "gpt-5", modelCount: 1, rangeModels: ["gpt-5"], rangeModelCount: 1,
  isSidechain: false, workTags: [], startedAt: 100, endedAt: 200, wallMs: 100, activeMs: 100,
  turnCount: 1, userMsgCount: 1, compactCount: 0, costUsd: 0, reworkScore: 0, goalSummary: null, goalCluster: null,
};
const detail: SessionDetail = {
  session, cwd: "/synthetic", aiTitle: null, firstPrompt: "Synthetic instruction", goalKey: null,
  agentNames: [], cliVersion: null, planType: null, turns: [], tools: [], summary: null,
  rework: { toolErrorCount: 0, toolCallCount: 0, toolErrorRate: 0, correctionHits: 0, maxFileEdits: 0, churnFiles: 0, retryBash: 0, abandoned: false, score: 0, scoreNote: "" },
  costBreakdown: { ingest: { tokens: 10, input: 10, cacheRead: 0, cacheWrite: 0, costUsd: 0 }, generate: { tokens: 20, output: 20, reasoning: 0, costUsd: 0 }, ingestRatio: 0, cacheHitRate: 0, ioChars: { read: 0, exec: 0, write: 0, fetch: 0, prompt: 0, other: 0, estimation: "char_count_only" }, ioFiles: { readFiles: 0, writtenFiles: 0 }, note: "" },
  priceSource: "default", priceCoverage: { ...priceCoverage, coveredTokenRatio: 1 } as SessionDetail["priceCoverage"], costNote: "",
};
const overview = {
  range, totals, comparePrevious: { sessionsPct: null, costPct: null, tokensPct: null, reworkPct: null },
  topModels: [], topProjects: [], topTitles: [], mixedModelSessions: 0, cacheHitRate: 0,
  rework: { avgScore: 0, toolErrorRate: 0, correctionHits: 0, churnFiles: 0, abandonedSessions: 0 },
  excludedInternal: { sessions: 0, costUsd: 0 }, priceSource: "default", priceCoverage: detail.priceCoverage,
  indexFreshness: { lastIndexedAt: 1, staleFiles: 0 }, timings: { sqlMs: 0, rowsScanned: 0, buildMs: 0, path: "rollup" }, costNote: "",
};

let host: HTMLDivElement, root: Root;
let pending: Pending[], held: Set<string>, listeners: Map<number, string>, callbacks: Map<number, unknown>;
let listenerHandlers: Map<number, number>;
let nextId: number, failSeries: boolean, peakPending: number;
let override: ((command: string, args: Args, value: any) => unknown) | undefined;
let holdWhen: ((command: string, args: Args) => boolean) | undefined;

function Surface() {
  const [open, setOpen] = useState(false);
  return <><button onClick={() => setOpen(true)}>設計を開く</button>{open && <AgentDesignPanel open onClose={() => setOpen(false)} />}</>;
}
function response(command: string, args: Args): unknown {
  switch (command) {
    case "agent_design_cached": case "agent_design_refresh": return syntheticCatalog;
    case "agent_design_skills": return { generatedAt: syntheticCatalog.generatedAt, categories: [], skills: [], hiddenCount: 0, newCount: 0 };
    case "agent_design_history": return { schemaVersion: 1, snapshotCount: 0, capturedAt: null, writing: false, warnings: [], changes: [] };
    case "ailog_get_usd_jpy_rate": return 150;
    case "ailog_set_usd_jpy_rate": return args.rate;
    case "ailog_index_status": return { running: false, filesDone: 0, filesTotal: 0, sessions: 1, lastFinishedAt: 1, lastError: null, mirrorWarningCode: null };
    case "ailog_summarize_status": return { running: false, sessionsDone: 0, sessionsTotal: 0, sessionsRemaining: 0, lastFinishedAt: 1, lastError: null };
    case "ailog_index_start": return { started: true, alreadyRunning: false };
    case "ailog_index_cancel": case "ailog_summarize_cancel": return { cancelled: true };
    case "ailog_summarize_start": return { started: true, alreadyRunning: false };
    case "ailog_session_summarize": return null;
    case "ailog_overview": return overview;
    case "ailog_series": return { range, bucket: args.options.bucket, groupBy: args.options.groupBy, buckets: [], priceSource: "default", priceCoverage: detail.priceCoverage, costNote: "" };
    case "ailog_models": return { range, rows: [], byWorkTag: [], totalSessions: 1, priceSource: "default", priceCoverage: detail.priceCoverage, costNote: "" };
    case "ailog_sessions": return { range, rows: [session], total: 1, priceSource: "default", costNote: "" };
    case "ailog_breakdown": return { range, dimension: args.options.dimension, rows: [], priceSource: "default", priceCoverage: detail.priceCoverage, costNote: "" };
    case "ailog_pivot": return { range, rowBy: args.options.rowBy, colBy: args.options.colBy, cols: [], rows: [], colTotals: [], grandTotal: { key: "total", ...totals }, priceSource: "default", priceCoverage: detail.priceCoverage, costNote: "" };
    case "ailog_usage_rhythm": return { range, syntheticMarker: "リズム" };
    case "ailog_rework_rankings": return { failedCommands: [], rewrittenFiles: [], syntheticMarker: "順位" };
    case "ailog_model_handoffs": return { range, rows: [], syntheticMarker: "引き継ぎ" };
    case "ailog_session_detail": return detail;
    case "plugin:event|listen": {
      const id = ++nextId; listeners.set(id, args.event); listenerHandlers.set(id, args.handler); return id;
    }
    case "plugin:event|unlisten": listeners.delete(args.eventId); callbacks.delete(listenerHandlers.get(args.eventId)!); listenerHandlers.delete(args.eventId); return null;
    default: throw new Error(`Unexpected IPC: ${command}`);
  }
}
function initializeIpc(): void {
  __resetAilogStoreForTests(); __resetAilogJobStoreForTests();
  useAilogJobStore.setState({ lastAutoStartedAt: Date.now() });
  pending = []; held = new Set(); listeners = new Map(); callbacks = new Map(); listenerHandlers = new Map(); nextId = 0; failSeries = false; peakPending = 0; override = undefined; holdWhen = undefined;
  core.invoke.mockReset().mockImplementation((command: string, args: Args = {}) => {
    if (command === "ailog_series" && failSeries) { failSeries = false; return Promise.reject(new Error("Synthetic report failure")); }
    const fallback = response(command, args);
    const value = override ? override(command, args, fallback) : fallback;
    if (!held.has(command) && !holdWhen?.(command, args)) return Promise.resolve(value);
    const key = JSON.stringify([command, args]);
    return new Promise((resolve, reject) => {
      pending.push({ command, args, key, resolve, reject, value }); peakPending = Math.max(peakPending, pending.length);
    });
  });
  core.transformCallback.mockImplementation((callback: unknown) => { const id = ++nextId; callbacks.set(id, callback); return id; });
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: { invoke: core.invoke, transformCallback: core.transformCallback } });
  Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", { configurable: true, value: { unregisterListener: (_event: string, id: number) => callbacks.delete(id) } });
}
async function render(): Promise<void> { await act(async () => root.render(<Surface />)); }
async function click(button: HTMLButtonElement): Promise<void> {
  expect(button).toBeTruthy(); await act(async () => { button.focus(); button.click(); });
}
function byText(text: string, selector = "button"): HTMLButtonElement {
  return [...document.querySelectorAll<HTMLButtonElement>(selector)].find(b => b.textContent === text)!;
}
async function tab(text: string): Promise<void> { await click(byText(text, ".ad-tabs button")); }
async function open(): Promise<void> { await click(byText("設計を開く")); }
async function escape(): Promise<void> {
  const target = document.querySelector<HTMLElement>('[role="dialog"][aria-label="セッション詳細"]') ?? document.querySelector<HTMLElement>(".ad-view")!;
  await act(async () => target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
}
async function finishReads(fail = false): Promise<void> {
  held.clear();
  holdWhen = undefined;
  await act(async () => {
    const reads = pending.splice(0);
    for (const read of reads) { if (fail) read.reject(new Error("Synthetic delayed failure")); else read.resolve(read.value); }
  });
}
const aiCalls = () => core.invoke.mock.calls.filter(([name]) => String(name).startsWith("ailog_"));
beforeEach(() => {
  initializeIpc(); host = document.createElement("div"); host.dataset.cmuxThemedRoot = "true";
  document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); await finishReads(); document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("agent design reflection integration", () => {
  it("removes just the AI log and skills titlebar entries and retains the remaining order", () => {
    const titlebar = readFileSync("src/components/layout/TitleBar.tsx", "utf8");
    expect(titlebar).not.toContain("AiLogButton"); expect(titlebar).not.toContain("SkillsButton");
    expect(titlebar).toMatch(/<AccountsButton\b[\s\S]*?\/>\s*<AgentDesignButton\s*\/>\s*<DashboardButton\s*\/>/);
    expect(titlebar).not.toContain("InboxButton");
  });
  it("keeps skills reachable and performs no AI log IPC before reflection is chosen", async () => {
    await render(); await open();
    expect([...document.querySelectorAll(".ad-tabs button")].map(b => b.textContent)).toEqual(["しくみ", "概要", "読み方", "比べる", "点検" + syntheticCatalog.findings.length, "スキル", "ふりかえり", "履歴", "書き出し"]);
    for (const page of ["概要", "読み方", "履歴", "スキル"]) { await tab(page); expect(aiCalls()).toHaveLength(0); }
    expect(document.querySelector(".skills-panel")).toBeTruthy();
    expect(core.invoke).toHaveBeenCalledWith("agent_design_skills", { cwd: syntheticCatalog.cwd });
    expect(core.invoke.mock.calls.some(([name]) => name === "skills_refresh")).toBe(false);
  });
  it("embeds the existing surface without a second dialog/title/close and preserves period preferences", async () => {
    await render(); await open(); await tab("ふりかえり");
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.querySelector("#ailog-panel")).toBeNull();
    expect(document.querySelector(".ailog-embedded h1")).toBeNull();
    expect(document.querySelector('.ailog-embedded button[aria-label="閉じる"]')).toBeNull();
    expect(document.querySelector('.ailog-embedded [aria-label="期間"]')).toBeTruthy();
    await click(byText("7日", '.ailog-embedded [aria-label="期間"] button'));
    await tab("履歴"); await tab("ふりかえり");
    expect(useAilogStore.getState().preset).toBe("7d");
    expect(byText("7日", '.ailog-embedded [aria-label="期間"] button').getAttribute("aria-pressed")).toBe("true");
    expect(core.invoke.mock.calls.some(([name]) => ["ailog_summarize_start", "ailog_session_summarize", "ailog_digest_generate"].includes(name))).toBe(false);
  });
  it.each(["ready", "delayed", "failed"])("closes only session detail with Escape and restores its trigger (%s)", async mode => {
    await render(); await open(); await tab("ふりかえり");
    if (mode !== "ready") held.add("ailog_session_detail");
    const trigger = byText(session.title!); await click(trigger);
    if (mode === "failed") await finishReads(true);
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
    await escape(); expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(byText("ふりかえり", ".ad-tabs button").getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(trigger);
    await finishReads(); expect(useAilogStore.getState().detailKey).toBeNull();
    await escape(); expect(document.querySelector('[role="dialog"]')).toBeTruthy();
    expect(document.activeElement).toBe(byText("ふりかえり", ".ad-tabs button"));
    await escape(); expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(byText("設計を開く"));
  });
  it.each([1440, 640])("keeps tabs wrapping and reflection inside the themed shell at %i px", async width => {
    host.style.width = `${width}px`; host.style.setProperty("--cmux-popover", "#faf9f5");
    const styles = document.createElement("style"); styles.textContent = readFileSync("src/components/agentDesign/agentDesign.css", "utf8"); document.head.append(styles);
    try {
      await render(); await open(); await tab("ふりかえり");
      const tabs = document.querySelector<HTMLElement>(".ad-tabs")!;
      expect(getComputedStyle(tabs).flexWrap).toBe("wrap"); expect(getComputedStyle(tabs).maxWidth).toBe("100%");
      expect(getComputedStyle(byText("ふりかえり", ".ad-tabs button")).whiteSpace).toBe("nowrap");
      const panel = document.querySelector<HTMLElement>(".ailog-embedded")!;
      expect(panel.closest("#agent-design-panel")).toBeTruthy();
      expect(getComputedStyle(panel).getPropertyValue("--cmux-popover")).toBe("#faf9f5");
    } finally { styles.remove(); }
  });
});

const calls = (command: string) => core.invoke.mock.calls.filter(([name]) => name === command);
const read = (command: string) => pending.find(request => request.command === command)!;
async function settle(request: Pending, error = false): Promise<void> {
  expect(request, "an individual IPC must be outstanding").toBeTruthy();
  pending.splice(pending.indexOf(request), 1);
  await act(async () => { if (error) request.reject(new Error("Old revision failed")); else request.resolve(request.value); });
}
async function clock(ms: number): Promise<void> { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function deferredSurface(): Promise<void> {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  await act(async () => root.render(<AgentDesignButton />));
  await click(document.querySelector<HTMLButtonElement>('button[aria-label="エージェント設計"]')!);
}
async function closeDeferred(): Promise<void> {
  await click(document.querySelector<HTMLButtonElement>('.ad-header button[aria-label="閉じる"]')!);
  expect(document.querySelector("#agent-design-panel")).toBeTruthy();
  await clock(119); expect(document.querySelector("#agent-design-panel")).toBeTruthy();
  await clock(1); expect(document.querySelector("#agent-design-panel")).toBeNull();
}
async function reopenDeferred(): Promise<void> {
  await click(document.querySelector<HTMLButtonElement>('button[aria-label="エージェント設計"]')!);
  await tab("ふりかえり");
}
async function menu(): Promise<void> { await click(document.querySelector<HTMLButtonElement>('button[aria-label="その他の操作"]')!); }
function reportRevision(revision: "旧" | "新", amount: number) {
  return (command: string, args: Args, value: any): unknown => {
    const group = { group: "gpt-5", ...totals, input: amount, output: 0, costUsd: 1 };
    switch (command) {
      case "ailog_overview": return { ...overview, totals: { ...totals, input: amount, costUsd: 1 }, costNote: `${revision}概要` };
      case "ailog_series": return { ...value, buckets: [{ bucket: 100, sessions: 1, turns: 1, costUsd: 1, groups: [group] }] };
      case "ailog_breakdown": return { ...value, overlapping: false, rows: [{ key: `${revision}内訳`, ...totals, input: amount, costUsd: 1, sharePct: 100, cacheHitRate: 0, avgRework: 0 }] };
      case "ailog_pivot": return { ...value, cols: ["gpt-5"], rows: [{ key: `${revision}ピボット`, total: group, cells: [group] }], colTotals: [group], grandTotal: group };
      case "ailog_sessions": return { ...value, rows: [{ ...session, title: `${revision}セッション` }] };
      case "ailog_models": return { ...value, costNote: `${revision}モデル` };
      default: return value;
    }
  };
}

const baselineRevision = "a30907c44a6c6d68a58cd7d5081d882d01717cdc";
const baselineFixture = "tests/fixtures/agent_home/reflectionBaselineIpc.json";
const comparisonOperations = {
  actions: ["open", "7d", "detail:A", "summary", "escape", "detail:B", "summary", "settle", "escape", "close", "open", "reload", "close", "open", "30d", "close"],
  delayed: ["open", "hold", "reload", "close", "open", "close", "open", "7d", "close", "open", "30d", "close", "open", "settle", "close"],
} as const;
type IpcCounts = Record<string, number>;
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function ipcCounts(): IpcCounts {
  const counts: IpcCounts = {};
  for (const [command, args] of aiCalls()) {
    const key = JSON.stringify([command, canonical(args ?? {})]);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}
function commandTotals(counts: IpcCounts): IpcCounts {
  const totals: IpcCounts = {};
  for (const [key, count] of Object.entries(counts)) {
    const command = JSON.parse(key)[0]; totals[command] = (totals[command] ?? 0) + count;
  }
  return totals;
}
function comparisonSessions(): void {
  override = (command, args, value) => {
    const row = (id: string) => ({ ...session, sessionId: `comparison-${id}`, title: `比較セッション ${id}` });
    if (command === "ailog_sessions") return { ...value, rows: [row("A"), row("B")], total: 2 };
    if (command === "ailog_session_detail") return { ...detail, session: row(args.args.sessionId.endsWith("B") ? "B" : "A") };
    return value;
  };
}
async function replayComparison(route: "base" | "embedded", operations: readonly string[]): Promise<IpcCounts> {
  await act(async () => root.unmount()); await finishReads(); root = createRoot(host);
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-10-11T00:00:00.000Z"));
  initializeIpc(); comparisonSessions();
  useAilogStore.setState({ rangeAnchor: Date.now() });
  await act(async () => root.render(route === "base" ? <AiLogButton /> : <AgentDesignButton />));
  for (const [step, operation] of operations.entries()) {
    if (operation === "open") {
      await click(document.querySelector<HTMLButtonElement>(route === "base" ? 'button[aria-label="AIログ分析"]' : 'button[aria-label="エージェント設計"]')!);
      if (route === "embedded") await tab("ふりかえり");
    } else if (operation === "close") {
      await click(document.querySelector<HTMLButtonElement>(route === "base" ? '#ailog-panel button[aria-label="閉じる"]' : '.ad-header button[aria-label="閉じる"]')!);
      await clock(119); await clock(1);
    } else if (operation === "7d" || operation === "30d") {
      await click(byText(operation === "7d" ? "7日" : "30日", '[aria-label="期間"] button'));
    } else if (operation.startsWith("detail:")) {
      await click(byText(`比較セッション ${operation.slice(-1)}`));
    } else if (operation === "summary") {
      const action = byText("このセッションを要約する");
      expect(action, `${route} step ${step}: ${document.querySelector('[aria-label="セッション詳細"]')?.textContent}`).toBeTruthy();
      held.add("ailog_session_summarize"); await click(action);
    } else if (operation === "escape") {
      await escape();
    } else if (operation === "reload") {
      await click(document.querySelector<HTMLButtonElement>('button[aria-label="再読込"]')!);
    } else if (operation === "hold") {
      held = new Set(["ailog_series", "ailog_index_status", "ailog_summarize_status", "ailog_get_usd_jpy_rate"]);
    } else if (operation === "settle") await finishReads();
  }
  await finishReads();
  return ipcCounts();
}

describe("B6 baseline-relative IPC and summary actions", () => {
  it.each(Object.entries(comparisonOperations))("compares embedded IPC with the baseline-style mount for %s operations", async (name, operations) => {
    const base = await replayComparison("base", operations);
    if (process.env.L30_BASELINE_CAPTURE) {
      // Oracle generation is explicit and only allowed with the actual baseline
      // controller/stores. Ordinary test runs never execute Git or rewrite it.
      for (const path of ["src/stores/ailogStore.ts", "src/stores/useAilogJobStore.ts", "src/hooks/useAilogAutoIndex.ts", "src/components/ailog/AiLogPanel.tsx", "src/components/ailog/AiLogButton.tsx"]) {
        expect(readFileSync(path, "utf8")).toBe(execFileSync("git", ["show", `${baselineRevision}:${path}`], { encoding: "utf8" }));
      }
      const fixture = JSON.parse(readFileSync(process.env.L30_BASELINE_CAPTURE, "utf8"));
      fixture[name] = { operations, counts: base };
      writeFileSync(process.env.L30_BASELINE_CAPTURE, JSON.stringify(fixture, null, 2) + "\n");
      return;
    }
    const fixture = JSON.parse(readFileSync(baselineFixture, "utf8"));
    expect(fixture.revision).toBe(baselineRevision);
    expect(fixture[name].operations).toEqual(operations);
    const reference: IpcCounts = fixture[name].counts;
    const embedded = await replayComparison("embedded", operations);
    const report = { operations, baseline: reference, base, embedded,
      totals: { baseline: commandTotals(reference), base: commandTotals(base), embedded: commandTotals(embedded) } };
    if (process.env.L30_BASELINE_REPORT) {
      let reports: Record<string, unknown> = {};
      try { reports = JSON.parse(readFileSync(process.env.L30_BASELINE_REPORT, "utf8")); } catch { /* first case */ }
      reports[name] = report;
      writeFileSync(process.env.L30_BASELINE_REPORT, JSON.stringify(reports, null, 2) + "\n");
    }
    for (const [key, count] of Object.entries(embedded)) {
      expect(count, `${name}: embedded versus a30907c44 ${key}`).toBeLessThanOrEqual(reference[key] ?? 0);
      expect(count, `${name}: embedded versus base-style mount ${key}`).toBeLessThanOrEqual(base[key] ?? 0);
    }
    expect(base, "base-style IPC matches the independently captured a30907c44 oracle").toEqual(reference);
  });

  it("N4 executes a different session's enabled summary while the first summary is pending", async () => {
    comparisonSessions(); await deferredSurface(); await tab("ふりかえり");
    await click(byText("比較セッション A")); held.add("ailog_session_summarize");
    await click(byText("このセッションを要約する")); const first = read("ailog_session_summarize");
    await escape(); await click(byText("比較セッション B"));
    expect(byText("このセッションを要約する").disabled).toBe(false);
    await click(byText("このセッションを要約する"));
    const second = pending.find(request => request.command === "ailog_session_summarize" && request.args.args.sessionId === "comparison-B");
    expect(second, "B's usable summary action must issue B's native command").toBeTruthy();
    await settle(first);
    override = (command, args, value) => command === "ailog_session_detail" && args.args.sessionId === "comparison-B"
      ? { ...detail, session: { ...session, sessionId: "comparison-B", title: "比較セッション B", goalSummary: "B の要約完了" } } : value;
    await settle(second!);
    expect(document.querySelector('[aria-label="セッション詳細"]')?.textContent).toContain("B の要約完了");
  });
});

describe("B4 running-job lifetimes beyond the 240 navigation sequences", () => {
  it("displays reports after an automatic index finishes before a running status is observed", async () => {
    await deferredSurface();
    useAilogJobStore.setState({ lastAutoStartedAt: 0 });
    override = reportRevision("新", 202);
    await tab("ふりかえり");
    expect(calls("ailog_index_start")).toHaveLength(1);
    expect(document.querySelector("#ailog-projects")?.textContent).toContain("新内訳");
    expect(document.querySelector("#ailog-cross")?.textContent).toContain("新ピボット");
  });

  it("polls a running job once per tick, stops on switches and the real 120 ms close, and refreshes after completion", async () => {
    let running = true;
    override = (command, _args, value) => command === "ailog_summarize_status" ? { ...value, running } : value;
    await deferredSurface(); expect(aiCalls()).toHaveLength(0); await tab("ふりかえり");
    for (let cycle = 0; cycle < 3; cycle++) {
      await menu(); expect(byText("要約を中断")).toBeTruthy();
      const before = calls("ailog_summarize_status").length; await clock(4_000);
      expect(calls("ailog_summarize_status")).toHaveLength(before + 1);
      await tab("スキル"); const inactive = aiCalls().length;
      expect([...listeners.values()].filter(name => name.startsWith("ailog://"))).toHaveLength(0);
      await clock(12_000); expect(aiCalls()).toHaveLength(inactive);
      await tab("ふりかえり"); expect([...listeners.values()].filter(name => name.startsWith("ailog://"))).toHaveLength(2);
    }
    const summaryListener = [...listeners.entries()].find(([, name]) => name === "ailog://summarize-progress")!;
    running = false;
    const reports = reportRevision("新", 202);
    override = (command, args, value) => command === "ailog_summarize_status" ? { ...value, running } : reports(command, args, value);
    // Capture the current listener's handler, rather than a cancelled earlier registration.
    const lastListen = calls("plugin:event|listen").filter(([, args]) => args.event === summaryListener[1]).at(-1)!;
    const currentCallback = callbacks.get((lastListen[1] as Args).handler) as (event: unknown) => void;
    await act(async () => currentCallback({ event: summaryListener[1], id: summaryListener[0], payload: { phase: "done", sessionsDone: 1, sessionsTotal: 1 } }));
    await clock(4_000); await menu(); expect(byText("要約を実行")).toBeTruthy();
    expect(document.querySelector("#ailog-projects")?.textContent).toContain("新内訳");
    await closeDeferred(); expect([...listeners.values()].filter(name => name.startsWith("ailog://"))).toHaveLength(0);
    const closed = aiCalls().length; await clock(12_000); expect(aiCalls()).toHaveLength(closed);
  });

  it("ignores queued completion callbacks after leaving and unregisters delayed registrations after deferred close", async () => {
    override = (command, _args, value) => command === "ailog_index_status" ? { ...value, running: true } : value;
    held.add("plugin:event|listen");
    await deferredSurface(); await tab("ふりかえり");
    const registrations = pending.filter(request => request.args.event?.startsWith("ailog://"));
    const completions = registrations.map(request => callbacks.get(request.args.handler) as (event: unknown) => void);
    await closeDeferred(); const closed = aiCalls().length;
    await act(async () => completions.forEach((callback, index) => callback({ event: registrations[index].args.event, id: registrations[index].value, payload: { phase: "done", filesDone: 1, filesTotal: 1, sessions: 1, sessionsDone: 1, sessionsTotal: 1 } })));
    expect(aiCalls()).toHaveLength(closed);
    for (const registration of registrations.reverse()) await settle(registration);
    expect([...listeners.values()].filter(name => name.startsWith("ailog://"))).toHaveLength(0);
    for (const registration of registrations) expect(callbacks.has(registration.args.handler)).toBe(false);
    await clock(12_000); expect(aiCalls()).toHaveLength(closed);
    held.clear(); await reopenDeferred(); expect([...listeners.values()].filter(name => name.startsWith("ailog://"))).toHaveLength(2);
  });

  it.each(["switch", "window"])("cancels the session-search timer on reflection departure (%s)", async departure => {
    await deferredSurface(); await tab("ふりかえり");
    const input = document.querySelector<HTMLInputElement>('input[name="ailog-session-search"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "予約した検索");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    if (departure === "window") await closeDeferred(); else await tab("スキル");
    const inactive = aiCalls().length; await clock(1_000);
    expect(aiCalls()).toHaveLength(inactive);
    expect(useAilogStore.getState().sessionQuery).toBe("");
    if (departure === "window") await reopenDeferred(); else await tab("ふりかえり");
    expect(document.querySelector<HTMLInputElement>('input[name="ailog-session-search"]')?.value).toBe("");
  });
});

type Event = "open" | "close" | "reflection" | "skills" | "history" | "other" | "delay" | "fail" | "resolve" | "detail" | "escape" | "range";
type Model = { open: boolean; page: string; main: string; detail: boolean; everReflection: boolean };
function advance(model: Model, event: Event): Model {
  const next = { ...model };
  if (event === "open") { next.open = true; next.page = next.main = "しくみ"; next.detail = false; }
  if (event === "close") { next.open = false; next.detail = false; }
  if (event === "reflection") { next.page = "ふりかえり"; next.everReflection = true; next.detail = false; }
  if (event === "skills") { next.page = "スキル"; next.detail = false; }
  if (event === "history" || event === "other") { next.page = next.main = event === "history" ? "履歴" : "概要"; next.detail = false; }
  if (event === "detail") next.detail = true;
  if (event === "escape") {
    if (next.detail) next.detail = false;
    else if (["ふりかえり", "スキル"].includes(next.page)) next.page = next.main;
    else next.open = false;
  }
  return next;
}
const initialModel = (): Model => ({ open: false, page: "しくみ", main: "しくみ", detail: false, everReflection: false });
function generateSequences(): Event[][] {
  let seed = 0x30f0880;
  const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const sequences: Event[][] = [];
  const unique = new Set<string>();
  while (sequences.length < 240) {
    let model = initialModel(); const events: Event[] = ["open"];
    model = advance(model, "open"); const length = 5 + sequences.length % 3;
    while (events.length < length) {
      const options: Event[] = !model.open ? ["open", "resolve", "fail"] : model.detail ? ["escape", "close", "resolve", "fail"]
        : ["close", "reflection", "skills", "history", "other", "delay", "fail", "resolve", "escape", ...(model.page === "ふりかえり" ? ["detail", "range"] as Event[] : [])];
      const event = options[random(options.length)]; events.push(event); model = advance(model, event);
    }
    const key = events.join(","); if (!unique.has(key)) { unique.add(key); sequences.push(events); }
  }
  return sequences;
}
describe("generated reflection event orderings", () => {
  it("checks FINV2/FINV3 after every event in 240 deterministic sequences of length 5–7", async () => {
    const sequences = generateSequences(); const started = performance.now();
    const covered = new Set<Event>(); let steps = 0, maximumPending = 0;
    for (const [index, events] of sequences.entries()) {
      if (index) { await act(async () => root.unmount()); await finishReads(); root = createRoot(host); initializeIpc(); }
      await render(); let model = initialModel();
      for (const event of events) {
        covered.add(event); const context = `sequence ${index}: ${events.join(" → ")}; step ${steps}`;
        const previous = model; const detailTrigger = byText(session.title!);
        switch (event) {
          case "open": await open(); break;
          case "close": await click(document.querySelector<HTMLButtonElement>('.ad-header button[aria-label="閉じる"]')!); break;
          case "reflection": await tab("ふりかえり"); break;
          case "skills": await tab("スキル"); break;
          case "history": await tab("履歴"); break;
          case "other": await tab("概要"); break;
          case "delay": held.add("ailog_series"); held.add("ailog_index_status"); held.add("ailog_summarize_status"); break;
          case "fail": if (pending.length) await finishReads(true); else failSeries = true; break;
          case "resolve": await finishReads(); break;
          case "detail": await click(detailTrigger); break;
          case "escape": await escape(); break;
          case "range": await click(byText(useAilogStore.getState().preset === "7d" ? "30日" : "7日", '.ailog-embedded [aria-label="期間"] button')); break;
        }
        model = advance(model, event); steps++;
        expect(document.querySelectorAll('[role="dialog"]').length, context).toBe(model.open ? model.detail ? 2 : 1 : 0);
        if (model.open) expect(byText(model.page, ".ad-tabs button")?.getAttribute("aria-pressed"), context).toBe("true");
        if (!model.everReflection) expect(aiCalls(), context).toHaveLength(0);
        maximumPending = Math.max(maximumPending, peakPending);
        expect([...listeners.values()].filter(name => name.startsWith("ailog://")).length, context).toBe(model.open && model.page === "ふりかえり" ? 2 : 0);
        if (event === "escape" && previous.detail) expect(document.activeElement, context).toBe(detailTrigger);
        if (event === "escape" && !model.open) expect(document.activeElement, context).toBe(byText("設計を開く"));
      }
      await finishReads();
    }
    expect([...covered].sort()).toEqual(["open", "close", "reflection", "skills", "history", "other", "delay", "fail", "resolve", "detail", "escape", "range"].sort());
    expect(new Set(sequences.map(events => events.length))).toEqual(new Set([5, 6, 7]));
    const report = { sequences: sequences.length, steps, lengths: [5, 6, 7], seed: "0x30f0880", maximumPending, elapsedMs: performance.now() - started, covered: [...covered].sort() };
    if (process.env.L30_SEQUENCE_REPORT) writeFileSync(process.env.L30_SEQUENCE_REPORT, JSON.stringify(report, null, 2) + "\n");
    console.info("L30_GENERATED", report);
  }, 120_000);
});
