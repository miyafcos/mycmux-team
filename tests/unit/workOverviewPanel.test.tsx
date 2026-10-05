// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const backend = vi.hoisted(() => ({ invoke: vi.fn(async (command: string) => command === "get_window_fragments" ? [] : undefined) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: backend.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emitTo: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));
vi.mock("../../src/components/common/OverlayShell", () => ({ OverlayShell: ({ children }: { children: import("react").ReactNode }) => <div>{children}</div> }));
import { WorkOverview } from "../../src/components/dashboard/WorkOverview";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useSessionAttentionStore, type SessionAttention } from "../../src/stores/sessionAttentionStore";
import { __resetGroupingRuntimeForTests, recordPersistentSchemaState } from "../../src/stores/groupingRuntimeStore";
import { __resetPersistenceCoordinatorForTests, markPersistentSchemaSupported } from "../../src/lib/workspacePersistenceCoordinator";
import { useUiStore } from "../../src/stores/uiStore";
import type { Workspace } from "../../src/types";
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
function layout(): Workspace[] {
  const tabs = ["one", "two", "three"].map(id => ({ id, sessionId: "s-" + id, type: "terminal" as const, agentId: "shell-starter",
    label: "toolx-solar-" + id, cwd: "C:/demo/solar" }));
  return [{ id: "w", name: "今日の開発", gridTemplateId: "2x1", status: "running", createdAt: 1,
    splitColumns: [["a"], ["b"]], columnWidths: [40, 60], rowHeightsPerCol: [[100], [100]],
    panes: [
      { id: "a", cwd: "C:/demo/solar", agentId: "shell-starter", sessionId: "s-one", activeTabId: "one", tabs: tabs.slice(0, 2) },
      { id: "b", cwd: "C:/demo/solar", agentId: "shell-starter", sessionId: "s-three", activeTabId: "three", tabs: tabs.slice(2) },
    ] }];
}
function setStatus(id: string, kind: SessionAttention["kind"], uiState: SessionAttention["uiState"], attentionId = "n1") {
  const store = useSessionAttentionStore.getState();
  useSessionAttentionStore.setState({ attentionBySession: { ...store.attentionBySession, ["s-" + id]: {
    sessionId: "s-" + id, sessionEpoch: 1, attentionId: kind === "none" ? null : attentionId, kind, uiState,
    detail: null, stateSince: 100, sessionRevision: 1, occurrenceOrder: 1,
  } } });
}
async function click(button: Element) { await act(async () => button.dispatchEvent(new MouseEvent("click", { bubbles: true }))); }
const buttons = (label: string) => [...container.querySelectorAll("button")].filter(button => button.textContent === label);
beforeEach(() => {
  vi.useFakeTimers(); backend.invoke.mockClear(); backend.invoke.mockImplementation(async command => command === "get_window_fragments" ? [] : undefined); localStorage.clear();
  __resetGroupingRuntimeForTests(); __resetPersistenceCoordinatorForTests(); markPersistentSchemaSupported(1);
  recordPersistentSchemaState({ loadedSchemaVersion: 1, migrationComplete: true });
  useWorkspaceListStore.setState({ workspaces: layout(), activeWorkspaceId: "w", layoutRevision: 10 });
  useUiStore.setState({ activePaneId: "s-one", lastActivePaneId: "s-one" });
  useSessionAttentionStore.getState().resetForTests();
  setStatus("one", "none", "working"); setStatus("two", "none", "idle"); setStatus("three", "none", "working");
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.useRealTimers();
  __resetGroupingRuntimeForTests(); __resetPersistenceCoordinatorForTests();
});
async function render() { await act(async () => root.render(<WorkOverview open onClose={vi.fn()} onLegacy={vi.fn()} />)); }
describe("work overview panel", () => {
  it("preserves local cards when a malformed peer inventory is returned", async () => {
    backend.invoke.mockImplementation(async command => command === "get_window_fragments" ? true as never : undefined);
    await render();
    expect(container.querySelectorAll("[data-overview-card]")).toHaveLength(3);
    expect(container.textContent).toContain("別窓の取得に失敗。再取得します。");
  });
  it("bounds a lost peer inventory reply without moving or stealing the selected row", async () => {
    backend.invoke.mockImplementation(async command => command === "get_window_fragments" ? new Promise<never>(() => {}) : undefined);
    await render();
    const before = [...container.querySelectorAll("[data-overview-card]")];
    await act(async () => (before[1].querySelector("button") as HTMLButtonElement).focus());
    const active = document.activeElement;
    await act(async () => vi.advanceTimersByTimeAsync(3_100));
    expect([...container.querySelectorAll("[data-overview-card]")]).toEqual(before);
    expect(document.activeElement).toBe(active);
    expect(container.textContent).toContain("別窓の取得に失敗。再取得します。");
  });
  it("renders immediately without settings or AI and keeps selected DOM rows on new notices", async () => {
    await render();
    expect(container.textContent).toContain("3 ペイン");
    expect(backend.invoke.mock.calls.some(([command]) => /jev|judge|session_titles/.test(command))).toBe(false);
    const before = [...container.querySelectorAll("[data-overview-card]")];
    await act(async () => (before[1].querySelector("button") as HTMLButtonElement).focus());
    const active = document.activeElement;
    const proposalCount = container.querySelectorAll(".cmux-work-overview-proposal").length;
    setStatus("one", "done", "done");
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect([...container.querySelectorAll("[data-overview-card]")]).toEqual(before);
    expect(document.activeElement).toBe(active);
    expect(before[1].getAttribute("aria-current")).toBe("true");
    expect(container.querySelectorAll(".cmux-work-overview-proposal").length).toBe(proposalCount);
    expect(container.textContent).toContain("新しい知らせ 1 件");
  });
  it("folds a completion without closing its session and resurfaces the next notice", async () => {
    setStatus("three", "done", "done"); await render();
    const before = JSON.stringify(useWorkspaceListStore.getState().workspaces);
    await click(buttons("確認して畳む")[0]);
    expect(container.querySelector('[data-overview-card="three"]')).toBeNull();
    expect(JSON.stringify(useWorkspaceListStore.getState().workspaces)).toBe(before);
    setStatus("three", "done", "done", "n2");
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(container.querySelector('[data-overview-card="three"]')).not.toBeNull();
  });
  it("applies one proposal and exposes immediate undo with exact layout restoration", async () => {
    await render();
    const before = JSON.stringify(useWorkspaceListStore.getState().workspaces);
    await click(buttons("寄せる")[0]);
    expect(useWorkspaceListStore.getState().workspaces[0].panes[0].tabs.map(tab => tab.id)).toEqual(["one", "two", "three"]);
    await click(buttons("元に戻す")[0]);
    expect(JSON.parse(JSON.stringify(useWorkspaceListStore.getState().workspaces))).toEqual(JSON.parse(before));
  });
  it("does not treat idle sessions as unanswered and refreshes filtering only on request", async () => {
    await render();
    await click(container.querySelector('[data-overview-state="working"]')!);
    expect([...container.querySelectorAll("[data-overview-card]")].map(card => card.getAttribute("data-overview-card"))).toEqual(["one", "three"]);
    setStatus("one", "none", "idle"); setStatus("two", "input", "waiting");
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(container.querySelector('[data-overview-card="one"]')).not.toBeNull();
    expect(container.querySelector('[data-overview-card="two"]')).toBeNull();
    await click(container.querySelector('[data-overview-state="waiting"]')!);
    expect([...container.querySelectorAll("[data-overview-card]")].map(card => card.getAttribute("data-overview-card"))).toEqual(["two"]);
  });
});
