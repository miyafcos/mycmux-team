// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { LiveTailList } from "../../src/components/layout/LiveTailList";
import { __resetPtyReadGenerationsForTests, observePtyEpoch, replacePtyReadOwners } from "../../src/lib/ptyReadGeneration";
import { useSessionAttentionStore } from "../../src/stores/sessionAttentionStore";
import { LIVE_TAIL_TEST_NOW as now, liveTailFixtureScene } from "../fixtures/liveTailList";

it.each([
  { kind: "progress", before: "作業中 · 12秒前に進んだ", after: "作業中 · 13秒前に進んだ" },
  { kind: "cmd", before: "コマンド実行中 · 2分4秒", after: "コマンド実行中 · 2分5秒" },
  { kind: "frozen", before: "画面が止まっている · 3分前から", after: "画面が止まっている · 3分前から" },
  { kind: "stale", before: "進んでいない · 3分前から", after: "進んでいない · 3分前から" },
  { kind: "input", before: "回答待ち · 59秒前から", after: "回答待ち · 1分前から" },
  { kind: "done", before: "完了 · 59分前", after: "完了 · 1時間前" },
] as const)("ticks the open $kind popup every second with a stable badge and row", async ({ kind, before, after }) => {
  const previousZone = process.env.TZ;
  const isAttention = kind === "input" || kind === "done";
  const scene = liveTailFixtureScene([isAttention ? "alive" : kind]);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers(); vi.setSystemTime(now);
  const intervalSpy = vi.spyOn(globalThis, "setInterval"), clearSpy = vi.spyOn(globalThis, "clearInterval");
  __resetPtyReadGenerationsForTests(); useSessionAttentionStore.getState().resetForTests();
  if (isAttention) {
    replacePtyReadOwners(Symbol("clock-test"), new Set(["sample-session-0"])); observePtyEpoch("sample-session-0", 17);
    useSessionAttentionStore.setState({ attentionBySession: { "sample-session-0": {
      sessionId: "sample-session-0", sessionEpoch: 17, sessionRevision: 1, attentionId: "clock-attention", kind,
      detail: null, uiState: kind === "done" ? "done" : "waiting", stateSince: now - (kind === "done" ? 3_599_000 : 59_000), occurrenceOrder: 1,
    } } });
  }
  try {
    process.env.TZ = "Asia/Tokyo";
    await act(async () => root.render(<LiveTailList {...scene} />));
    const toggle = host.querySelector<HTMLButtonElement>(".live-tail-idle");
    if (toggle) await act(async () => toggle.click());
    const row = host.querySelector<HTMLButtonElement>(".live-tail-row")!;
    await act(async () => row.focus());
    const popup = () => document.querySelector('[role="tooltip"]');
    const text = () => popup()?.querySelector(".live-tail-fact")?.textContent;
    const rowBefore = row.innerHTML;
    expect(text()).toBe(before);
    expect(intervalSpy).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 1_000);
    const popupInterval = intervalSpy.mock.results[0].value;
    await act(async () => vi.advanceTimersByTimeAsync(999));
    expect(text()).toBe(before);
    process.env.TZ = "America/New_York";
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(text()).toBe(after); expect(row.innerHTML).toBe(rowBefore);
    expect(popup()?.querySelector(".live-tail-evidence")).toBeNull();
    await act(async () => row.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(popup()).toBeNull(); expect(clearSpy).toHaveBeenCalledWith(popupInterval);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    await act(async () => row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(text()).not.toBe(before); expect(intervalSpy).toHaveBeenCalledTimes(2);
    expect(intervalSpy).toHaveBeenLastCalledWith(expect.any(Function), 1_000);
    if (kind === "frozen") expect(text()).toBe("画面が止まっている · 4分前から");
    if (kind === "stale") expect(text()).toBe("進んでいない · 4分前から");
  } finally {
    await act(async () => root.unmount()); host.remove(); useSessionAttentionStore.getState().resetForTests();
    __resetPtyReadGenerationsForTests(); vi.restoreAllMocks(); vi.useRealTimers();
    if (previousZone === undefined) delete process.env.TZ; else process.env.TZ = previousZone;
  }
});
