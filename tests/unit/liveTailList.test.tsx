// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveTailList, liveTailFactText } from "../../src/components/layout/LiveTailList";
import { useLiveBriefStore } from "../../src/stores/liveBriefStore";
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
    const badges: Record<string, string> = { frozen: "止まっている", unreadable: "読めない", error: "エラー", stale: "進んでいない" };
    expect(element.querySelector(".live-tail-badge")?.textContent ?? null).toBe(badges[kind] ?? null);
  });
  it("counts only input-idle seats and keeps reply-waiting seats as rows", async () => {
    scene = liveTailFixtureScene(["idle", "idle", "idle"]);
    scene.targets[1].waitingForReply = true; scene.targets[1].status = "waiting";
    await render();
    expect(host.querySelectorAll("button")).toHaveLength(1);
    expect(host.textContent).toContain("ほか 入力待ち 2");
    await hover(host.querySelector("button")!);
    expect(tooltip().textContent).toContain("返事待ち");
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
    expect(tooltip().textContent).toContain("コマンド待ち 2分4秒");
    expect(tooltip().textContent).toContain("押すとこのペインへ");
    expect(row("Sample cmd").querySelector(".live-tail-line")!.textContent).toBe("● Wait for sample report · 2m 4s");
    expect(tooltip().closest("[data-cmux-themed-root]")).toBe(host);
  });
  it("uses the spinner without a running command", async () => {
    scene = liveTailFixtureScene(["progress"]); await render();
    expect(row("Sample progress").querySelector(".live-tail-line")!.textContent).toBe(scene.entries["sample-session-0"].evidence.observation.crop.marker);
    await hover(row("Sample progress")); expect(tooltip().textContent).toContain("進んだ 12秒前");
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
  it("shows both frozen timestamps without treating a live transcript as terminal output", async () => {
    scene = liveTailFixtureScene(["frozen"]);
    const transcriptAt = LIVE_TAIL_TEST_NOW - 2_000;
    useLiveBriefStore.setState({ briefsBySession: { "sample-session-0": { lastEventAt: transcriptAt } as LiveSessionBrief } });
    await render(); await hover(row("Sample frozen"));
    const time = (at: number) => new Date(at).toLocaleTimeString("ja-JP", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    expect(tooltip().textContent).toContain("画面が止まっている 3分");
    expect(tooltip().textContent).toContain(`端末の最後の出力 ${time(LIVE_TAIL_TEST_NOW - 180_000)} · 会話記録の最後の書き込み ${time(transcriptAt)}`);
  });
  it("states when a frozen seat's transcript time is unknown", async () => {
    scene = liveTailFixtureScene(["frozen"]); await render(); await hover(row("Sample frozen"));
    expect(tooltip().textContent).toContain("会話記録 不明");
  });
  it("does not present stale diagnostic rows as a readable screen", async () => {
    scene = liveTailFixtureScene(["unreadable"]); await render(); await hover(row("Sample unreadable"));
    expect(tooltip().textContent).toContain("画面を読めない"); expect(tooltip().textContent).toContain("開けば最新になります");
    expect(tooltip().querySelector(".live-tail-popup-rows")).toBeNull();
    expect(row("Sample unreadable").querySelector(".live-tail-line")!.textContent).toBe("");
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
    expect(liveTailFactText(fact, LIVE_TAIL_TEST_NOW)).toBe({ stale: "3分 進んでいない", frozen: "画面が止まっている 3分", error: "エラー", unreadable: "画面を読めない" }[kind]);
  });
});
