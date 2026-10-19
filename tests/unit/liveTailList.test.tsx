// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveTailList } from "../../src/components/layout/LiveTailList";
import { useLiveBriefStore } from "../../src/stores/liveBriefStore";
import { liveTailStateLine } from "../../src/lib/liveTail/stateLine";
import { LIVE_TAIL_KINDS, LIVE_TAIL_TEST_NOW, liveTailFixtureEntry, liveTailFixtureScene } from "../fixtures/liveTailList";
import type { LiveSessionBrief } from "../../src/lib/livebrief";

const jump = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/jumpToPaneTab", () => ({ jumpToPaneTab: jump }));
let host: HTMLDivElement, root: Root;
let scene: ReturnType<typeof liveTailFixtureScene>;
let reduced = false;

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(LIVE_TAIL_TEST_NOW); jump.mockReset();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  reduced = false;
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  useLiveBriefStore.getState().reset();
  scene = liveTailFixtureScene();
  host = document.createElement("div"); host.dataset.cmuxThemedRoot = "true"; document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  useLiveBriefStore.getState().reset(); vi.unstubAllGlobals(); vi.useRealTimers();
});
async function render() { await act(async () => root.render(<LiveTailList {...scene} />)); }
const row = (name: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
async function hover(element: HTMLElement) {
  await act(async () => element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
}
const tooltip = () => host.querySelector<HTMLElement>('[role="tooltip"]')!;

describe("live-tail workspace list", () => {
  it.each(LIVE_TAIL_KINDS)("renders the %s fact without inventing a badge", async kind => {
    scene = liveTailFixtureScene([kind]); await render();
    if (kind === "idle") { expect(row("Sample idle")).toBeNull(); expect(host.textContent).toContain("ほか 入力待ち 1"); return; }
    const element = row(`Sample ${kind}`);
    expect(element.dataset.fact).toBe(kind);
    const badges: Record<string, string> = { frozen: "止まっている", error: "エラー", stale: "進んでいない" };
    expect(element.querySelector(".live-tail-badge")?.textContent ?? null).toBe(badges[kind] ?? null);
  });
  it("counts only input-idle seats and keeps reply-waiting seats as rows", async () => {
    scene = liveTailFixtureScene(["idle", "idle", "idle"]);
    scene.targets[1].waitingForReply = true; scene.targets[1].status = "waiting";
    await render();
    expect(host.querySelectorAll(".live-tail-row")).toHaveLength(1);
    expect(host.textContent).toContain("ほか 入力待ち 2");
    await hover(host.querySelector("button")!);
    expect(tooltip().textContent).toContain("回答待ち");
    expect(tooltip().querySelector(".live-tail-badge")).toBeNull();
  });
  it("does not show a zero idle count", async () => {
    scene = liveTailFixtureScene(["alive"]); await render(); expect(host.querySelector(".live-tail-idle")).toBeNull();
  });
  it("uses pane tab order, current names, and stored parent identities", async () => {
    scene = liveTailFixtureScene(["progress", "cmd"]);
    scene.targets.reverse();
    scene.workspace.panes[0].tabs[0].label = "Sample renamed"; scene.workspace.panes[0].tabs[0].displayName = "Automatic sample";
    scene.workspace.panes[0].tabs[1].origin = { kind: "agent", parentTabId: scene.workspace.panes[0].tabs[0].id };
    await render();
    expect([...host.querySelectorAll(".live-tail-name")].map(element => element.textContent)).toEqual(["Sample renamed", "Sample cmd"]);
    expect(host.querySelectorAll(".live-tail-tree")).toHaveLength(1);
    expect(row("Sample cmd").classList.contains("live-tail-row--child")).toBe(true);
  });
  it("excludes a foreign workspace and an obsolete tab identity", async () => {
    scene = liveTailFixtureScene(["progress", "cmd"]); scene.targets[0].workspaceId = "sample-other"; scene.targets[1].sessionId = "sample-obsolete";
    await render(); expect(host.querySelectorAll("button")).toHaveLength(0);
  });
  it("keeps all three cropped rows verbatim in the hover popup", async () => {
    scene = liveTailFixtureScene(["cmd"]); await render(); await hover(row("Sample cmd"));
    expect([...tooltip().querySelectorAll(".live-tail-popup-rows > div")].map(element => element.textContent))
      .toEqual(scene.entries["sample-session-0"].evidence.observation.crop.rows);
    expect(tooltip().textContent).toContain("コマンド実行中 · 2分4秒");
    expect(tooltip().querySelector(".live-tail-go")).toBeNull();
    expect(row("Sample cmd").querySelector(".live-tail-line")!.textContent).toBe("● Wait for sample report · 2m 4s");
    expect(tooltip().closest("[data-cmux-themed-root]")).toBe(host);
    expect(tooltip().dataset.cmuxNativeWebviewOccluder).toBe("overlap");
  });
  it("uses the spinner without a running command", async () => {
    scene = liveTailFixtureScene(["progress"]); await render();
    expect(row("Sample progress").querySelector(".live-tail-line")!.textContent).toBe(scene.entries["sample-session-0"].evidence.observation.crop.marker);
    await hover(row("Sample progress")); expect(tooltip().textContent).toContain("作業中 · 12秒前に進んだ");
  });
  it("opens the popup from keyboard focus and jumps on Enter with the exact identity", async () => {
    scene = liveTailFixtureScene(["alive"]); await render();
    await act(async () => row("Sample alive").focus());
    expect(tooltip().textContent).toContain("作業中");
    await act(async () => row("Sample alive").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(jump).toHaveBeenCalledExactlyOnceWith({ workspaceId: scene.workspace.id, paneId: "sample-pane", tab: scene.workspace.panes[0].tabs[0] });
    await act(async () => row("Sample alive").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(host.querySelector('[role="tooltip"]')).toBeNull();
  });
  it("jumps on a click with the exact identity", async () => {
    scene = liveTailFixtureScene(["progress"]); await render(); await act(async () => row("Sample progress").click());
    expect(jump).toHaveBeenCalledExactlyOnceWith({ workspaceId: scene.workspace.id, paneId: "sample-pane", tab: scene.workspace.panes[0].tabs[0] });
  });
  it("keeps a live transcript from changing the frozen state age", async () => {
    scene = liveTailFixtureScene(["frozen"]);
    const transcriptAt = LIVE_TAIL_TEST_NOW - 2_000;
    useLiveBriefStore.setState({ briefsBySession: { "sample-session-0": { lastEventAt: transcriptAt } as LiveSessionBrief } });
    await render(); await hover(row("Sample frozen"));
    expect(tooltip().querySelector(".live-tail-fact")?.textContent).toBe("画面が止まっている · 3分前から");
    expect(tooltip().querySelector(".live-tail-evidence")).toBeNull();
  });
  it("keeps the frozen state age when the transcript time is unknown", async () => {
    scene = liveTailFixtureScene(["frozen"]); await render(); await hover(row("Sample frozen"));
    expect(tooltip().querySelector(".live-tail-fact")?.textContent).toBe("画面が止まっている · 3分前から");
    expect(tooltip().querySelector(".live-tail-evidence")).toBeNull();
  });
  it("does not present stale diagnostic rows as a readable screen", async () => {
    scene = liveTailFixtureScene(["unreadable"]); await render(); await hover(row("Sample unreadable"));
    expect(tooltip().querySelector(".live-tail-fact")?.textContent).toBe("作業中");
    expect(tooltip().textContent).not.toContain("読めない"); expect(tooltip().textContent).not.toContain("開けば最新になります");
    expect(tooltip().querySelector(".live-tail-popup-rows")).toBeNull();
    expect(row("Sample unreadable").querySelector(".live-tail-summary")).toBeNull();
  });
  it("has no contextmenu handler or stop action", async () => {
    scene = liveTailFixtureScene(["progress"]); await render();
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await act(async () => row("Sample progress").dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false); expect(jump).not.toHaveBeenCalled();
    const source = readFileSync(join(__dirname, "../../src/components/layout/LiveTailList.tsx"), "utf8");
    expect(source).not.toMatch(/onContextMenu|addEventListener\(["']contextmenu/);
    expect(host.querySelectorAll("button")).toHaveLength(1);
  });
  it("flashes only a new progress observation and clears it after 1.4 seconds", async () => {
    scene = liveTailFixtureScene(["progress"]); await render(); expect(host.querySelector("[data-live-tail-flash]")).toBeNull();
    const entry = scene.entries["sample-session-0"];
    entry.evidence.lastProgressAt = LIVE_TAIL_TEST_NOW; await render();
    expect(host.querySelector("[data-live-tail-flash]")).not.toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(1_400)); expect(host.querySelector("[data-live-tail-flash]")).toBeNull();
    entry.evidence.observation.crop.marker = "* Thinking… (3m 14s · ↓ 62.3k tokens)"; await render();
    expect(host.querySelector("[data-live-tail-flash]")).toBeNull();
  });
  it("does not flash with reduced motion", async () => {
    reduced = true; scene = liveTailFixtureScene(["progress"]); await render();
    scene.entries["sample-session-0"].evidence.lastProgressAt = LIVE_TAIL_TEST_NOW; await render();
    expect(host.querySelector("[data-live-tail-flash]")).toBeNull();
  });
  it.each(["stale", "frozen", "error", "unreadable"] as const)("uses the design's %s wording", kind => {
    const entry = liveTailFixtureEntry(kind);
    const fact = { kind, sinceMs: LIVE_TAIL_TEST_NOW - 180_000, elapsedSec: null, tokens: null, toolElapsedSec: null, error: entry.evidence.observation.crop.error };
    expect(liveTailStateLine({ fact, now: LIVE_TAIL_TEST_NOW, status: "unknown", attentionKind: null, cropState: null })?.text ?? null)
      .toBe({ stale: "進んでいない · 3分前から", frozen: "画面が止まっている · 3分前から", error: "エラー", unreadable: null }[kind]);
  });

  it.each(["progress", "cmd", "stale", "frozen", "error"] as const)("keeps two lines only when %s has screen text", async kind => {
    scene = liveTailFixtureScene([kind]); await render();
    expect(row(`Sample ${kind}`).querySelector(".live-tail-heading")).not.toBeNull();
    expect(row(`Sample ${kind}`).querySelector(".live-tail-summary")).not.toBeNull();
  });
  it("keeps empty, initially pending, and reply-waiting rows on one line", async () => {
    scene = liveTailFixtureScene(["alive", "alive", "idle"]);
    const observation = scene.entries["sample-session-0"].evidence.observation;
    observation.rawRows = []; observation.crop.rows = []; observation.crop.marker = null;
    delete scene.entries["sample-session-1"];
    scene.targets[2].waitingForReply = true; scene.targets[2].status = "waiting";
    await render();
    expect(host.querySelectorAll(".live-tail-row")).toHaveLength(3);
    expect(host.querySelectorAll(".live-tail-summary, .live-tail-dot")).toHaveLength(0);
    expect(row("Sample alive").querySelector(".live-tail-badge")).toBeNull();
  });
  it("shrinks rendered spacing while retaining typography tokens", async () => {
    scene = liveTailFixtureScene(["alive"]); await render();
    const style = document.createElement("style");
    style.textContent = readFileSync(join(__dirname, "../../src/components/layout/LiveTailList.css"), "utf8");
    document.head.append(style);
    try {
      const rowStyle = getComputedStyle(row("Sample alive"));
      expect(Number.parseFloat(rowStyle.paddingTop)).toBeLessThan(4);
      expect(Number.parseFloat(rowStyle.marginTop)).toBeLessThan(3);
      expect(Number.parseFloat(getComputedStyle(row("Sample alive").querySelector(".live-tail-heading")!).lineHeight)).toBeLessThan(1.5);
      expect(style.textContent).toContain("var(--cmux-font-size-sm)");
      expect(style.textContent).toContain("var(--cmux-font-size-xs)");
      expect(style.textContent).not.toMatch(/font-size:\s*(?:[0-9]|10)px/);
    } finally { style.remove(); }
  });
  it("opens and closes input-idle rows by click, Enter, and Space and jumps to their identities", async () => {
    scene = liveTailFixtureScene(["idle", "idle"]); delete scene.entries["sample-session-1"]; scene.targets[1].status = "idle";
    await render();
    const toggle = host.querySelector<HTMLButtonElement>("button.live-tail-idle");
    expect(toggle).not.toBeNull();
    expect(toggle!.getAttribute("aria-expanded")).toBe("false");
    expect(toggle!.textContent).toContain("▸");
    await act(async () => toggle!.click());
    expect(toggle!.getAttribute("aria-expanded")).toBe("true");
    expect(toggle!.textContent).toContain("▾");
    expect(document.getElementById(toggle!.getAttribute("aria-controls")!)).not.toBeNull();
    const idleRows = [...host.querySelectorAll<HTMLButtonElement>(".live-tail-row")];
    expect(idleRows).toHaveLength(2);
    expect(idleRows.map(element => element.dataset.fact)).toEqual(["idle", "idle"]);
    expect(host.querySelectorAll(".live-tail-summary, .live-tail-dot")).toHaveLength(0);
    await act(async () => idleRows[1].click());
    expect(jump).toHaveBeenCalledExactlyOnceWith({ workspaceId: scene.workspace.id, paneId: "sample-pane", tab: scene.workspace.panes[0].tabs[1] });
    for (const [key, expanded] of [["Enter", "false"], [" ", "true"]]) {
      await act(async () => toggle!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
      expect(toggle!.getAttribute("aria-expanded")).toBe(expanded);
    }
  });
  it("keeps disclosure state per workspace and resets it on remount", async () => {
    scene = liveTailFixtureScene(["idle"], "workspace-a"); await render();
    const toggle = () => host.querySelector<HTMLButtonElement>("button.live-tail-idle")!;
    expect(toggle()).not.toBeNull();
    await act(async () => toggle().click());
    scene = liveTailFixtureScene(["idle"], "workspace-b"); await render();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    scene = liveTailFixtureScene(["idle"], "workspace-a"); await render();
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    await act(async () => root.render(null)); await render();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });
  it("retains screen rows without exposing the acquisition age or guide text", async () => {
    scene = liveTailFixtureScene(["alive"]);
    scene.entries["sample-session-0"].retained = true;
    scene.entries["sample-session-0"].evidence.observation.observedAt = LIVE_TAIL_TEST_NOW - 7_000;
    await render(); await hover(row("Sample alive"));
    expect(tooltip().querySelector(".live-tail-popup-rows")?.textContent).toBe(scene.entries["sample-session-0"].evidence.observation.crop.rows.join(""));
    expect(tooltip().querySelector(".live-tail-evidence")).toBeNull();
    expect(tooltip().querySelector(".live-tail-fact")?.textContent).toBe("作業中");
    expect(tooltip().textContent).not.toContain("開けば最新になります");
    expect(host.querySelector(".live-tail-go")).toBeNull();
  });
});
