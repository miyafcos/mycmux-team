// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneLeftoverProcess } from "../../src/lib/paneLeftovers";
import type { Pane, PaneTab, Workspace } from "../../src/types";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), confirm: vi.fn() }));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke,
}));
vi.mock("../../src/lib/appConfirmation", () => ({ cancelAppConfirmations: vi.fn(() => false), confirm: mocks.confirm }));

import { __resetPaneLeftoverNotificationsForTests } from "../../src/lib/paneLeftoverNotifications";
import { PaneLeftoverProcesses } from "../../src/components/layout/PaneLeftoverProcesses";
import { getClosedPaneEntries, popClosedPane, pushClosedTab } from "../../src/stores/closedPaneStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";

let root: Root;
let container: HTMLDivElement;
const sample = (overrides: Partial<PaneLeftoverProcess> = {}): PaneLeftoverProcess => ({
  pid: 101, parentPid: null, name: "python.exe", startedAt: 1_800_000_000,
  memoryBytes: 25 * 1024 * 1024, command: "python watch.py --token [redacted]",
  paneSessionId: "closed-session", paneRunning: false, ...overrides,
});
function pane(tab: PaneTab): Pane {
  return { id: "pane", sessionId: tab.sessionId, agentId: tab.agentId, tabs: [tab], activeTabId: tab.id };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function render(active = true) {
  await act(async () => root.render(<PaneLeftoverProcesses active={active} />));
}
async function click(label: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label)!;
  expect(button).toBeDefined();
  await act(async () => button.click());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  __resetPaneLeftoverNotificationsForTests();
  mocks.invoke.mockReset().mockResolvedValue([]);
  mocks.confirm.mockReset().mockResolvedValue(true);
  while (popClosedPane()) { /* drain history */ }
  useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  __resetPaneLeftoverNotificationsForTests();
  vi.unstubAllGlobals();
});

describe("processes outside panes", () => {
  it("loads only when shown and reloads when reopened", async () => {
    await render(false);
    expect(mocks.invoke).not.toHaveBeenCalled();
    await render(true);
    expect(mocks.invoke).toHaveBeenCalledWith("list_pane_leftover_processes");
    await render(false);
    await render(true);
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it("groups open, recorded closed and unknown panes, with closed groups first", async () => {
    const closedTab: PaneTab = { id: "closed", sessionId: "closed-session", agentId: "shell-starter", label: "監視" };
    pushClosedTab(pane(closedTab), closedTab);
    expect(getClosedPaneEntries()[0].paneSessionId).toBe("closed-session");
    const openTab: PaneTab = { id: "open", sessionId: "open-session", agentId: "shell-starter", label: "調査" };
    const workspace: Workspace = { id: "workspace", name: "作業", gridTemplateId: "1x1", panes: [pane(openTab)], status: "running", createdAt: 1 };
    useWorkspaceListStore.setState({ workspaces: [workspace] });
    mocks.invoke.mockResolvedValue([
      sample({ pid: 1, paneSessionId: "open-session", paneRunning: true }),
      sample({ pid: 2 }), sample({ pid: 3, name: "conhost.exe" }),
      sample({ pid: 4, paneSessionId: "12345678-unknown" }),
    ]);
    await render();
    const groups = [...container.querySelectorAll<HTMLElement>("[data-pane-leftover-group]")];
    expect(groups).toHaveLength(3);
    expect(groups[2].textContent).toContain("ペイン「調査」(作業) から切り離されたもの");
    expect(container.textContent).toContain("閉じたペイン「監視」から残っているもの");
    expect(container.textContent).toContain("閉じたペイン (ID 12345678) から残っているもの");
    expect(container.querySelectorAll("[data-pane-leftover-pid]")).toHaveLength(4);
    expect(container.textContent).toContain("メモリ 25.0 MB");
    expect(container.textContent).toMatch(/起動 \d{2}\/\d{2} \d{2}:\d{2}/);
    const command = container.querySelector("code")!;
    expect(command.textContent).toBe("python watch.py --token [redacted]");
    expect(command.style.whiteSpace).toBe("pre-wrap");
    expect(command.style.overflowWrap).toBe("anywhere");
  });


  it("titles a running pane in another window as running and sorts it after closed panes", async () => {
    mocks.invoke.mockResolvedValue([
      sample({ paneSessionId: "12345678-running", paneRunning: true }),
      sample({ pid: 202 }),
    ]);
    await render();
    const groups = [...container.querySelectorAll<HTMLElement>("[data-pane-leftover-group]")];
    expect(groups[1].getAttribute("data-pane-leftover-group")).toBe("12345678-running");
    expect(groups[1].textContent).toContain("動いているペイン (ID 12345678) から切り離されたもの");
  });

  it("shows roots with descendant counts and total memory in compact rows", async () => {
    mocks.invoke.mockResolvedValue([
      sample({ pid: 103, parentPid: 102, name: "helper.exe", memoryBytes: 2 * 1024 * 1024 }),
      sample({ pid: 102, parentPid: 101, name: "conhost.exe", memoryBytes: 3 * 1024 * 1024 }),
      sample(),
      sample({ pid: 201, parentPid: 999, name: "browser.exe", memoryBytes: 4 * 1024 * 1024 }),
    ]);
    await render();
    const rows = [...container.querySelectorAll<HTMLElement>("[data-pane-leftover-pid]")];
    expect(rows.map((row) => row.dataset.paneLeftoverPid)).toEqual(["101", "201"]);
    expect(rows[0].textContent).toContain("子プロセス 2 件");
    expect(rows[0].textContent).toContain("メモリ 30.0 MB");
    expect(rows[0].firstElementChild?.getAttribute("style")).toContain("display: flex");
    expect(rows[1].textContent).not.toContain("子プロセス");
    expect(rows[1].textContent).toContain("メモリ 4.0 MB");
    expect(container.querySelectorAll("button[aria-label$='を止める']")).toHaveLength(2);
  });

  it("shows the empty state after a successful scan", async () => {
    await render();
    expect(container.textContent).toContain("ペインの外で動いているプロセスはありません。");
  });

  it("keeps and dims the previous rows while updating", async () => {
    const next = deferred<PaneLeftoverProcess[]>();
    mocks.invoke.mockResolvedValueOnce([sample()]).mockReturnValueOnce(next.promise);
    await render();
    await click("再読み込み");
    const list = container.querySelector<HTMLElement>("[data-pane-leftover-list]")!;
    expect(list.getAttribute("aria-busy")).toBe("true");
    expect(Number(list.style.opacity)).toBeLessThan(1);
    expect(container.textContent).toContain("更新中");
    expect(container.querySelector("[data-pane-leftover-pid='101']")).not.toBeNull();
    await act(async () => next.resolve([]));
    expect(list.style.opacity).toBe("1");
    expect(container.querySelector("[data-pane-leftover-pid='101']")).toBeNull();
  });

  it("confirms the root, sends pid and startedAt, removes the whole tree and rescans", async () => {
    const next = deferred<PaneLeftoverProcess[]>();
    mocks.invoke.mockResolvedValueOnce([sample(), sample({ pid: 102, parentPid: 101, name: "helper.exe" })]).mockResolvedValueOnce(undefined).mockReturnValueOnce(next.promise);
    await render();
    await click("止める");
    expect(mocks.confirm).toHaveBeenCalledWith(expect.stringContaining("python.exe"), expect.objectContaining({ kind: "warning", okLabel: "止める" }));
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "stop_pane_leftover_process", { pid: 101, startedAt: 1_800_000_000 });
    expect(mocks.confirm.mock.calls[0][0]).toBe("python.exe\npython watch.py --token [redacted]\n\nこのプロセスと子プロセスを止めますか？作業中の内容は失われることがあります。");
    expect(mocks.invoke).toHaveBeenNthCalledWith(3, "list_pane_leftover_processes");
    expect(container.querySelectorAll("[data-pane-leftover-pid]")).toHaveLength(0);
    await act(async () => next.resolve([]));
  });

  it("does not stop or rescan when confirmation is cancelled", async () => {
    mocks.invoke.mockResolvedValue([sample()]);
    mocks.confirm.mockResolvedValue(false);
    await render();
    await click("止める");
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-pane-leftover-pid='101']")).not.toBeNull();
  });

  it("keeps the row and shows a stop refusal inline", async () => {
    mocks.invoke.mockResolvedValueOnce([sample()]).mockRejectedValueOnce("プロセスが入れ替わりました");
    await render();
    await click("止める");
    const row = container.querySelector("[data-pane-leftover-pid='101']")!;
    expect(row.querySelector("[role='alert']")?.textContent).toContain("入れ替");
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(row.querySelector("button")?.disabled).toBe(false);
  });

  it("keeps previous rows after a failed reload and does not misreport first-scan failure as empty", async () => {
    mocks.invoke.mockRejectedValueOnce("scan refused");
    await render();
    expect(container.querySelector("[role='alert']")?.textContent).toContain("scan refused");
    expect(container.textContent).not.toContain("プロセスはありません");
    mocks.invoke.mockResolvedValueOnce([sample()]);
    await click("再読み込み");
    mocks.invoke.mockRejectedValueOnce("reload refused");
    await click("再読み込み");
    expect(container.querySelector("[data-pane-leftover-pid='101']")).not.toBeNull();
    expect(container.querySelector("[role='alert']")?.textContent).toContain("reload refused");
  });

  it("ignores a stale response after closing and reopening the section", async () => {
    const old = deferred<PaneLeftoverProcess[]>();
    mocks.invoke.mockReturnValueOnce(old.promise).mockResolvedValueOnce([sample({ pid: 202 })]);
    await render();
    await render(false);
    await render(true);
    await act(async () => old.resolve([sample()]));
    expect(container.querySelector("[data-pane-leftover-pid='202']")).not.toBeNull();
    expect(container.querySelector("[data-pane-leftover-pid='101']")).toBeNull();
  });
});
