// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { LiveTailList } from "../../src/components/layout/LiveTailList";
import { useLiveBriefStore } from "../../src/stores/liveBriefStore";
import type { LiveSessionBrief } from "../../src/lib/livebrief";
import { LIVE_TAIL_TEST_NOW, liveTailFixtureEntry, liveTailFixtureScene } from "../fixtures/liveTailList";

it("keeps popup clock text equal through timezone changes, DST and Date bounds", async () => {
  const previous = process.env.TZ, scene = liveTailFixtureScene(["frozen"]);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const times = [null, undefined, NaN, Infinity, 0, LIVE_TAIL_TEST_NOW, -2208988800000,
    Date.parse("2026-03-08T06:59:59Z"), Date.parse("2026-03-08T07:00:00Z"), -8640000000000000,
    8640000000000000, -8640000000000001, 8640000000000001];
  try {
    for (const timezone of ["Asia/Tokyo", "America/New_York", "Europe/London", "Pacific/Chatham", "UTC"]) {
      process.env.TZ = timezone;
      for (const at of times) {
        await act(async () => {
          useLiveBriefStore.setState({ briefsBySession: { "sample-session-0": { lastEventAt: at } as LiveSessionBrief } });
          root.render(<LiveTailList {...scene} />);
        });
        await act(async () => host.querySelector("button")!.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
        const date = new Date(at as number);
        const valid = at != null && Number.isFinite(at) && !Number.isNaN(date.getTime());
        const expected = valid ? date.toLocaleTimeString("ja-JP", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }) : null;
        const evidence = document.querySelector(".live-tail-evidence")?.textContent;
        const output = new Date(LIVE_TAIL_TEST_NOW - 180_000).toLocaleTimeString("ja-JP", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
        expect(evidence, `${timezone} ${at}`).toBe(`端末の最後の出力 ${output} · ${expected ? `会話記録の最後の書き込み ${expected}` : "会話記録 不明"}`);
      }
    }
  } finally {
    await act(async () => root.unmount()); host.remove(); useLiveBriefStore.getState().reset();
    if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
  }
});

it.each([
  { name: "Tokyo brief-only update then UTC parent render", zone: "Asia/Tokyo",
    terminal: 8640000000000001, t0: "2026-10-10T15:00:00Z", t1: "2026-10-11T00:00:00Z",
    output: "不明", initial: "00:00:00", independent: "09:00:00", final: "00:00:00" },
  { name: "London valid clocks with different seasonal offsets", zone: "Europe/London",
    terminal: Date.parse("2026-01-15T10:00:00Z"), t0: "2026-06-01T11:00:00Z", t1: "2026-06-01T12:00:00Z",
    output: "10:00:00", initial: "12:00:00", independent: "13:00:00", final: "12:00:00" },
])("matches Stage C immediately after $name", async scenario => {
  const previous = process.env.TZ, scene = liveTailFixtureScene(["frozen"]);
  const observedAt = Date.parse(scenario.t1) + 60_000;
  if (scenario.zone === "Europe/London") {
    scene.entries["sample-session-0"] = liveTailFixtureEntry("frozen", observedAt);
    scene.entries["sample-session-0"].evidence.observation.lastOutputAt = scenario.terminal;
  }
  const metadata = { "sample-session-0": { backendLastOutputAt: scenario.terminal } };
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers(); vi.setSystemTime(observedAt);
  const render = async (): Promise<void> => { await act(async () => root.render(<LiveTailList {...scene} metadataBySession={metadata} />)); };
  const evidence = (): string | null => document.querySelector(".live-tail-evidence")?.textContent ?? null;
  const fullClock = (brief: string): string => `端末の最後の出力 ${scenario.output} · 会話記録の最後の書き込み ${brief}`;
  try {
    process.env.TZ = scenario.zone;
    useLiveBriefStore.setState({ briefsBySession: { "sample-session-0": { lastEventAt: Date.parse(scenario.t0) } as LiveSessionBrief } });
    await render();
    await act(async () => host.querySelector("button")!.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
    expect(document.querySelector('[role="tooltip"]')?.getAttribute("data-fact")).toBe("frozen");
    expect(evidence()).toBe(fullClock(scenario.initial));
    // This act completes the row's independent subscription update. The parent
    // and all its references remain unchanged until the separate render below.
    await act(async () => useLiveBriefStore.setState({ briefsBySession: {
      "sample-session-0": { lastEventAt: Date.parse(scenario.t1) } as LiveSessionBrief,
    } }));
    expect(evidence()).toBe(fullClock(scenario.independent));
    process.env.TZ = "UTC"; await render();
    expect(evidence()).toBe(fullClock(scenario.final));
    expect(Date.now()).toBe(observedAt); // No timer tick may repair the clock.
  } finally {
    await act(async () => root.unmount()); host.remove(); useLiveBriefStore.getState().reset(); vi.useRealTimers();
    if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
  }
});

it("matches Stage C after a popup timer renders a timezone change then the zone reverses before a parent render", async () => {
  const previous = process.env.TZ, scene = liveTailFixtureScene(["frozen"]);
  const metadata = { "sample-session-0": { backendLastOutputAt: 8640000000000001 } };
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers(); vi.setSystemTime(LIVE_TAIL_TEST_NOW);
  const render = async (): Promise<void> => { await act(async () => root.render(<LiveTailList {...scene} metadataBySession={metadata} />)); };
  const evidence = (): string | null => document.querySelector(".live-tail-evidence")?.textContent ?? null;
  const fullClock = (brief: string): string => `端末の最後の出力 不明 · 会話記録の最後の書き込み ${brief}`;
  try {
    process.env.TZ = "Asia/Tokyo";
    useLiveBriefStore.setState({ briefsBySession: { "sample-session-0": {
      lastEventAt: Date.parse("2026-10-10T15:00:00Z"),
    } as LiveSessionBrief } });
    await render();
    await act(async () => host.querySelector("button")!.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
    expect(evidence()).toBe(fullClock("00:00:00"));
    process.env.TZ = "UTC";
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(evidence()).toBe(fullClock("15:00:00"));
    const beforeParent = Date.now();
    process.env.TZ = "Asia/Tokyo"; await render();
    expect(evidence()).toBe(fullClock("00:00:00"));
    expect(Date.now()).toBe(beforeParent); // Reversal must refresh immediately.
  } finally {
    await act(async () => root.unmount()); host.remove(); useLiveBriefStore.getState().reset(); vi.useRealTimers();
    if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
  }
});

it.each(["terminal", "brief-only"])("updates %s popup time on an unchanged parent render after a timezone change", async mode => {
  const previous = process.env.TZ, scene = liveTailFixtureScene(["frozen"]);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const metadata = mode === "brief-only" ? { "sample-session-0": { backendLastOutputAt: 8640000000000001 } } : {};
  const render = async (): Promise<void> => { await act(async () => root.render(<LiveTailList {...scene} metadataBySession={metadata} />)); };
  try {
    process.env.TZ = "Asia/Tokyo";
    useLiveBriefStore.setState({ briefsBySession: { "sample-session-0": { lastEventAt: LIVE_TAIL_TEST_NOW } as LiveSessionBrief } });
    await render();
    await act(async () => host.querySelector("button")!.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
    const before = document.querySelector(".live-tail-evidence")!.textContent;
    process.env.TZ = "America/New_York"; await render();
    const expectedBrief = new Date(LIVE_TAIL_TEST_NOW).toLocaleTimeString("ja-JP", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const after = document.querySelector(".live-tail-evidence")!.textContent;
    expect(after).not.toBe(before);
    expect(after).toContain(`会話記録の最後の書き込み ${expectedBrief}`);
  } finally {
    await act(async () => root.unmount()); host.remove(); useLiveBriefStore.getState().reset();
    if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
  }
});
