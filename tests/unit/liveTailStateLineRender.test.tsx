// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveTailList } from "../../src/components/layout/LiveTailList";
import { __resetPtyReadGenerationsForTests, observePtyEpoch, replacePtyReadOwners } from "../../src/lib/ptyReadGeneration";
import { useSessionAttentionStore } from "../../src/stores/sessionAttentionStore";
import type { SessionAttentionKind, SessionUiState } from "../../src/lib/ipc";
import { LIVE_TAIL_KINDS, LIVE_TAIL_TEST_NOW as now, liveTailFixtureScene } from "../fixtures/liveTailList";

vi.mock("../../src/lib/jumpToPaneTab", () => ({ jumpToPaneTab: vi.fn() }));
const owner = Symbol("state-line-render");
const forbidden = ["画面の読み取り", "画面を読めた", "画面を確認中", "画面を読めない", "読めない", "前の画面", "端末の最後の出力", "会話記録の最後の書き込み"];
let host: HTMLDivElement, root: Root, style: HTMLStyleElement;
let scene: ReturnType<typeof liveTailFixtureScene>;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  __resetPtyReadGenerationsForTests(); useSessionAttentionStore.getState().resetForTests();
  host = document.createElement("div"); host.dataset.cmuxThemedRoot = "true"; document.body.append(host); root = createRoot(host);
  style = document.createElement("style");
  style.textContent = readFileSync(join(__dirname, "../../src/components/layout/LiveTailList.css"), "utf8"); document.head.append(style);
  scene = liveTailFixtureScene(["progress"]);
  replacePtyReadOwners(owner, new Set(["sample-session-0"])); observePtyEpoch("sample-session-0", 17);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); style.remove();
  useSessionAttentionStore.getState().resetForTests(); __resetPtyReadGenerationsForTests(); vi.useRealTimers();
});
function attention(kind: SessionAttentionKind, stateSince = now - 180_000, uiState: SessionUiState = kind === "done" ? "done" : "waiting") {
  useSessionAttentionStore.setState({ attentionBySession: { "sample-session-0": {
    sessionId: "sample-session-0", sessionEpoch: 17, sessionRevision: 1, attentionId: "attention-1",
    kind, detail: null, uiState, stateSince, occurrenceOrder: 1,
  } } });
}
async function open() {
  await act(async () => root.render(<LiveTailList {...scene} />));
  const toggle = host.querySelector<HTMLButtonElement>(".live-tail-idle");
  if (toggle?.getAttribute("aria-expanded") === "false") await act(async () => toggle.click());
  const row = host.querySelector<HTMLButtonElement>(".live-tail-row")!;
  await act(async () => row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  return { row, popup: host.querySelector<HTMLElement>('[role="tooltip"]')! };
}

describe("live-tail state-line rendering", () => {
  it.each([
    ["input", "回答待ち", "回答待ち · 3分前から"],
    ["approval", "承認待ち", "承認待ち · 3分前から"],
  ] as const)("renders yellow %s badge and timed popup", async (kind, badge, text) => {
    attention(kind);
    const { row, popup } = await open();
    expect(row.dataset.tone).toBe("waiting"); expect(popup.dataset.tone).toBe("waiting");
    expect(row.querySelector(".live-tail-badge")?.textContent).toBe(badge);
    expect(popup.querySelector(".live-tail-fact")?.textContent).toBe(text);
    expect(getComputedStyle(row).getPropertyValue("--live-tail-color")).toBe("var(--cmux-live-tail-waiting)");
    expect(getComputedStyle(popup).getPropertyValue("--live-tail-color")).toBe("var(--cmux-live-tail-waiting)");
  });
  it("renders completed attention 12 minutes ago without a badge", async () => {
    attention("done", now - 720_000);
    const { row, popup } = await open();
    expect(row.querySelector(".live-tail-badge")).toBeNull();
    expect(row.dataset.tone).toBe("neutral"); expect(popup.dataset.tone).toBe("neutral");
    expect(popup.querySelector(".live-tail-fact")?.textContent).toBe("完了 · 12分前");
  });
  it.each([["frozen", "止まっている"], ["stale", "進んでいない"], ["error", "エラー"]] as const)
    ("renders a red stopped %s badge", async (kind, badge) => {
      scene = liveTailFixtureScene([kind]);
      const { row, popup } = await open();
      expect(row.dataset.fact).toBe(kind); expect(popup.dataset.fact).toBe(kind);
      expect(row.dataset.tone).toBe("stopped"); expect(popup.dataset.tone).toBe("stopped");
      expect(row.querySelector(".live-tail-badge")?.textContent).toBe(badge);
      expect(getComputedStyle(row).getPropertyValue("--live-tail-color")).toBe("var(--cmux-live-tail-error)");
      expect(getComputedStyle(popup).getPropertyValue("--live-tail-color")).toBe("var(--cmux-live-tail-error)");
    });
  it("omits the state element when no state is supported", async () => {
    scene = liveTailFixtureScene(["unreadable"]); scene.targets[0].status = "unknown";
    const { row, popup } = await open();
    expect(popup.querySelector(".live-tail-fact")).toBeNull();
    expect(row.dataset.tone).toBe("neutral"); expect(row.querySelector(".live-tail-badge")).toBeNull();
  });
  it("dims previous screen rows while keeping the current attention and summary", async () => {
    attention("input");
    const entry = scene.entries["sample-session-0"]; entry.attentionKey = null;
    const { row, popup } = await open();
    expect(popup.querySelector(".live-tail-popup-rows--previous")?.textContent).toBe(entry.evidence.observation.crop.rows.join(""));
    expect(getComputedStyle(popup.querySelector(".live-tail-popup-rows")!).opacity).toBe("0.55");
    expect(row.querySelector(".live-tail-line")?.textContent).toBe(entry.evidence.observation.crop.marker);
    expect(popup.querySelector(".live-tail-fact")?.textContent).toBe("回答待ち · 3分前から");
    expect(popup.textContent).not.toContain("前の画面");
  });
  it.each(LIVE_TAIL_KINDS)("R1-R6 never expose acquisition diagnostics for %s with any status or attention", async kind => {
    for (const status of ["working", "waiting", "idle", "unknown"] as const) {
      for (const attentionKind of [null, "none", "input", "approval", "rate_limited", "error", "done"] as const) {
        await act(async () => root.render(null));
        scene = liveTailFixtureScene([kind]); scene.targets[0].status = status;
        if (attentionKind) attention(attentionKind, now - 180_000, status);
        else useSessionAttentionStore.setState({ attentionBySession: {} });
        const { row, popup } = await open();
        for (const text of forbidden) {
          expect(row.textContent, `${kind}/${status}/${attentionKind}/row`).not.toContain(text);
          expect(popup.textContent, `${kind}/${status}/${attentionKind}/popup`).not.toContain(text);
        }
        expect(popup.querySelector(".live-tail-evidence")).toBeNull();
      }
    }
  });
  it("updates immutable attention scalars without a parent prop change or timer tick", async () => {
    attention("input"); const { row, popup } = await open();
    await act(async () => attention("approval", now - 120_000));
    expect(row.querySelector(".live-tail-badge")?.textContent).toBe("承認待ち");
    expect(popup.querySelector(".live-tail-fact")?.textContent).toBe("承認待ち · 2分前から");
    await act(async () => attention("approval", now - 240_000));
    expect(popup.querySelector(".live-tail-fact")?.textContent).toBe("承認待ち · 4分前から");
    expect(Date.now()).toBe(now);
  });
});
