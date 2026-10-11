// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useStore } from "zustand";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveTailList } from "../../src/components/layout/LiveTailList";
import { createLiveTailController } from "../../src/stores/liveTailStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useSessionAttentionStore } from "../../src/stores/sessionAttentionStore";
import { __resetPtyReadGenerationsForTests } from "../../src/lib/ptyReadGeneration";
import { LIVE_TAIL_TEST_NOW, liveTailFixtureScene } from "../fixtures/liveTailList";

const icons = vi.hoisted(() => vi.fn());
vi.mock("../../src/components/icons/AgentIcons", () => ({
  AgentKindIcon: (props: { kind: string }) => { icons(props.kind); return <span>{props.kind}</span>; },
}));
const jump = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/jumpToPaneTab", () => ({ jumpToPaneTab: jump }));
let root: Root, host: HTMLDivElement;
let scene: ReturnType<typeof liveTailFixtureScene>;
let controller: ReturnType<typeof createLiveTailController> | undefined;
const step = async (ms = 30): Promise<void> => { await act(async () => vi.advanceTimersByTimeAsync(ms)); };
const count = (kind: string): number => icons.mock.calls.filter(([value]) => value === kind).length;

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(LIVE_TAIL_TEST_NOW);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  __resetPtyReadGenerationsForTests(); useSessionAttentionStore.getState().resetForTests(); icons.mockReset(); jump.mockReset();
  scene = liveTailFixtureScene(["progress", "cmd"]);
  useWorkspaceListStore.setState({ workspaces: [scene.workspace], activeWorkspaceId: scene.workspace.id });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); controller?.dispose(); controller = undefined;
  useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null });
  useSessionAttentionStore.getState().resetForTests(); vi.useRealTimers();
});
const render = async (): Promise<void> => { await act(async () => root.render(<LiveTailList {...scene} />)); };

describe("live-tail row presentation isolation", () => {
  it("does not execute the unrelated row when another session's screen is accepted", async () => {
    let hold = false;
    const pending = new Map<string, (rows: string[]) => void>();
    controller = createLiveTailController({ listTargets: async () => scene.targets,
      loadOutputs: async () => Object.fromEntries(scene.targets.map(target => [target.sessionId, LIVE_TAIL_TEST_NOW])),
      readTail: async id => hold ? new Promise<string[]>(resolve => pending.set(id, resolve))
        : scene.entries[id].evidence.observation.rawRows,
    });
    function Connected() {
      const state = useStore(controller!.store);
      return <LiveTailList workspace={scene.workspace} {...state} />;
    }
    await act(async () => root.render(<Connected />));
    controller.acquireConsumer("sidebar"); await step();
    expect(controller.store.getState().entries["sample-session-0"].history).toHaveLength(1);
    hold = true; await step(2_000);
    expect(pending.size).toBe(2);
    const before = count("codex"), unchanged = host.querySelector('[data-live-tail-tab="sample-tab-1"]')!.outerHTML;
    await act(async () => pending.get("sample-session-0")!(["Accepted another screen", "* Thinking… (3m 13s · ↓ 62.4k tokens)"]));
    await step();
    expect(controller.store.getState().entries["sample-session-0"].history).toHaveLength(2);
    expect(host.querySelector('[data-live-tail-tab="sample-tab-1"]')!.outerHTML).toBe(unchanged);
    console.log(JSON.stringify({ unrelatedRowExecutionsBefore: before, after: count("codex"), acceptedScreens: 2 }));
    try { expect(count("codex")).toBe(before); }
    finally { pending.get("sample-session-1")!(scene.entries["sample-session-1"].evidence.observation.rawRows); await step(); }
  });

  it("reads a new immutable projection even when fixture inputs mutate in place", async () => {
    await render();
    const entry = scene.entries["sample-session-0"];
    entry.evidence.observation.crop.tool = null;
    entry.evidence.observation.crop.marker = "* Thinking… (9m 1s · ↓ 91.2k tokens)";
    entry.evidence.observation.crop.rows = ["New popup row", entry.evidence.observation.crop.marker];
    entry.evidence.lastProgressAt = LIVE_TAIL_TEST_NOW;
    scene.workspace.panes[0].tabs[0].label = "Renamed seat";
    scene.workspace.panes[0].tabs[0].origin = { kind: "agent", parentTabId: "sample-tab-1" };
    await render();
    const row = host.querySelector<HTMLButtonElement>('[data-live-tail-tab="sample-tab-0"]')!;
    expect(row.getAttribute("aria-label")).toBe("Renamed seat");
    expect(row.classList.contains("live-tail-row--child")).toBe(true);
    expect(row.querySelector(".live-tail-line")?.textContent).toBe(entry.evidence.observation.crop.marker);
    expect(row.querySelector("[data-live-tail-flash]")).not.toBeNull();
    await act(async () => row.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
    expect(document.querySelector(".live-tail-popup-rows")?.textContent).toContain("New popup row");
    const nextTab = { ...scene.workspace.panes[0].tabs[0] };
    scene.workspace.panes[0].tabs[0] = nextTab; await render();
    await act(async () => row.click());
    expect(jump).toHaveBeenCalledWith({ workspaceId: scene.workspace.id, paneId: "sample-pane", tab: nextTab });
  });

  it("keeps a row's attention subscription even when its projected visual values are equal", async () => {
    await render(); const beforeClaude = count("claude"), beforeCodex = count("codex");
    const before = host.innerHTML;
    await act(async () => useSessionAttentionStore.setState({ attentionBySession: {
      "sample-session-1": { sessionId: "sample-session-1", sessionEpoch: 9999, sessionRevision: 1,
        attentionId: null, kind: "none", detail: null, uiState: "working", stateSince: LIVE_TAIL_TEST_NOW, occurrenceOrder: 1 },
    } }));
    // This feed has no matching acquired epoch, so it changes neither row's
    // visual projection. Only the subscribed session should execute again.
    expect(host.innerHTML).toBe(before);
    expect(count("claude")).toBe(beforeClaude);
    expect(count("codex")).toBe(beforeCodex + 1);
  });
});
