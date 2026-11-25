// @vitest-environment jsdom
import { ipc } from "./fixtures/accountManagementAppShell";
import { act } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { WindowTabIndex, WorkspaceConfig } from "../../src/lib/ipc";

import App from "../../src/App";
import LauncherPane from "../../src/components/workspace/LauncherPane";
import { launcherStrings } from "../../src/components/workspace/launcherStrings";
import { OPEN_DASHBOARD_EVENT, QUIT_PREPARE_EVENT, WINDOW_ADOPT_EVENT } from "../../src/lib/ipc";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useUiStore } from "../../src/stores/uiStore";
import { createWorkspaceAtCwd } from "../../src/lib/workspaceBootstrap";
import { titleBarStrings } from "../../src/components/layout/titleBarStrings";
import { closeWindowWorkspacesAndDestroy, WINDOW_CLOSE_TIMEOUT_MS } from "../../src/components/layout/SocketListener";
import { isPreparingLayoutQuit } from "../../src/lib/layoutQuit";
import { ACCOUNT_MANAGEMENT_RESULT_EVENT } from "../../src/lib/mainDashboardRequests";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}

async function mountManagementWindows(label = "mycmux-w2") {
  ipc.current = ipc.child = label;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Element.prototype.scrollIntoView = () => {};
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  const child = document.body.appendChild(document.createElement("div"));
  const source = document.body.appendChild(document.createElement("div"));
  const childRoot = createRoot(child);
  const sourceRoot = createRoot(source);
  function sourceButton(label: string) {
    return [...source.querySelectorAll("button")]
      .find(button => button.textContent === label || button.title === label)!;
  }
  const dispose = async () => {
    await act(async () => { childRoot.unmount(); sourceRoot.unmount(); await vi.dynamicImportSettled(); });
    child.remove();
    source.remove();
    vi.unstubAllGlobals();
  };
  try {
    await act(async () => {
      childRoot.render(<App />);
      sourceRoot.render(<LauncherPane workspaceId="source" paneId="pane" tabId="launch" sessionId="launch" isActive />);
    });
    await act(async () => { await vi.dynamicImportSettled(); });
    await vi.waitFor(() => expect(ipc.startListener).toHaveBeenCalled(), { timeout: 3000 });
    await act(async () => sourceButton(launcherStrings.specTooltip("Grok Build")).click());
  } catch (error) {
    await dispose();
    throw error;
  }
  return {
    child, childRoot, source, sourceRoot, sourceButton, dispose,
    click: async (label = ipc.detached) => {
      ipc.current = label;
      try { await act(async () => sourceButton(launcherStrings.accountManagement).click()); }
      finally { ipc.current = ipc.child; }
    },
    dialog: () => child.querySelectorAll('[role="dialog"][aria-modal="true"]'),
    alert: () => source.querySelector('[role="alert"]')?.textContent,
  };
}

it("refuses management after confirming normal main closure while final metadata is pending", async () => {
  const windows = await mountManagementWindows("main");
  const lastMetadata = deferred<Record<string, unknown>>();
  let closing: Promise<void> | undefined;
  try {
    expect(ipc.readiness.at(-1)).toBe(true);
    await act(async () => { createWorkspaceAtCwd("/fixture/main", { name: "Close fixture", activate: true }); });
    ipc.metadata.mockResolvedValueOnce({}).mockReturnValueOnce(lastMetadata.promise);
    await act(async () => { closing = ipc.close!({ preventDefault: vi.fn() }); });
    expect(ipc.confirm).toHaveBeenCalledOnce();
    expect(ipc.metadata).toHaveLastReturnedWith(lastMetadata.promise);
    expect(ipc.destroy).not.toHaveBeenCalled();
    await windows.click();
    expect(windows.dialog()).toHaveLength(0);
    expect(ipc.focus).not.toHaveBeenCalled();
    expect(windows.alert()).toBe(launcherStrings.accountManagementFailed);
    expect(ipc.readiness.at(-1)).toBe(false);
  } finally {
    await act(async () => { lastMetadata.resolve({}); await closing; });
    await windows.dispose();
  }
});

it("keeps management available on macOS hide and reports failure to show the hidden main", async () => {
  ipc.isMac = true;
  const windows = await mountManagementWindows("main");
  try {
    expect(ipc.readiness.at(-1)).toBe(true);
    await act(async () => ipc.close!({ preventDefault: vi.fn() }));
    expect(ipc.hide).toHaveBeenCalledOnce();
    expect(ipc.destroy).not.toHaveBeenCalled();
    expect(ipc.readiness.at(-1)).toBe(true);
    ipc.focus.mockRejectedValueOnce("window_restore_failed");
    await windows.click();
    expect(windows.dialog()).toHaveLength(1);
    expect(ipc.focus).toHaveBeenCalledExactlyOnceWith("main");
    expect(windows.alert()).toBe(launcherStrings.accountManagementFailed);
  } finally {
    await windows.dispose();
  }
});

it("does not claim delivery when the selected subscription unmounts ahead of its index update", async () => {
  const windows = await mountManagementWindows();
  const withheld = deferred<void>();
  ipc.publishReadiness.mockImplementation(ready => ready ? Promise.resolve() : withheld.promise);
  try {
    expect(ipc.readiness.at(-1)).toBe(true);
    await act(async () => windows.childRoot.render(null));
    expect(ipc.receive).toBeUndefined();
    expect(ipc.readiness.at(-1)).toBe(true);
    vi.useFakeTimers();
    await windows.click();
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(windows.alert()).toBe(launcherStrings.accountManagementFailed);
    expect(ipc.focus).not.toHaveBeenCalled();
    expect(vi.mocked(emitTo).mock.calls.filter(([, name]) => name === OPEN_DASHBOARD_EVENT)).toHaveLength(1);
  } finally {
    await act(async () => withheld.resolve(undefined));
    await windows.dispose();
  }
});

it("refuses an indexed request delivered after its child label was reused by a subscribed successor", async () => {
  vi.stubGlobal("__MYCMUX_LAYOUT_PUBLICATION_ID__", "first-generation");
  const windows = await mountManagementWindows();
  const deliver = deferred<void>();
  ipc.beforeDelivery.mockReturnValueOnce(deliver.promise);
  try {
    expect(ipc.readiness.at(-1)).toBe(true);
    const firstSubscription = ipc.advertised?.subscription_id;
    await windows.click();
    expect(ipc.beforeDelivery).toHaveBeenCalledOnce();
    await act(async () => windows.childRoot.render(null));
    vi.stubGlobal("__MYCMUX_LAYOUT_PUBLICATION_ID__", "replacement-generation");
    const { default: AppShell } = await import("../../src/components/layout/AppShell");
    await act(async () => windows.childRoot.render(<AppShell />));
    expect(ipc.readiness.at(-1)).toBe(true);
    expect(ipc.advertised?.subscription_id).toEqual(expect.any(String));
    expect(ipc.advertised?.subscription_id).not.toBe(firstSubscription);
    await act(async () => deliver.resolve(undefined));
    expect(windows.dialog()).toHaveLength(0);
    expect(ipc.focus).not.toHaveBeenCalled();
    expect(windows.alert()).toBe(launcherStrings.accountManagementFailed);
  } finally {
    deliver.resolve(undefined);
    await windows.dispose();
  }
});

it("refuses a request indexed before main entered quit preparation", async () => {
  const windows = await mountManagementWindows("main");
  const deliver = deferred<void>();
  ipc.beforeDelivery.mockReturnValueOnce(deliver.promise);
  try {
    await windows.click();
    expect(ipc.beforeDelivery).toHaveBeenCalledOnce();
    await act(async () => ipc.events.get(QUIT_PREPARE_EVENT)!({ payload: null }));
    expect(isPreparingLayoutQuit()).toBe(true);
    await act(async () => deliver.resolve(undefined));
    expect(windows.dialog()).toHaveLength(0);
    expect(ipc.focus).not.toHaveBeenCalled();
    expect(emitTo).toHaveBeenCalledWith({ kind: "Webview", label: ipc.detached },
      ACCOUNT_MANAGEMENT_RESULT_EVENT, { requestId: expect.any(String), fromWindow: "main", reason: "refused" });
  } finally {
    deliver.resolve(undefined);
    await windows.dispose();
  }
});

it("does not advertise a window whose real TitleBar failed within its error boundary", async () => {
  ipc.breakTitleBar = true;
  vi.spyOn(console, "error").mockImplementation(() => {});
  const windows = await mountManagementWindows();
  try {
    expect([...windows.child.querySelectorAll("button")].some(button => button.textContent?.trim() === "再試行")).toBe(true);
    expect(windows.child.textContent).toContain("タイトルバーが予期せず停止しました");
    expect(windows.child.textContent).toContain("fixture TitleBar failed");
    expect([...windows.child.querySelectorAll("button")].some(button => button.title === titleBarStrings.settings)).toBe(false);
    expect(ipc.receive).toBeDefined();
    await windows.click();
    expect(windows.alert()).toBe(launcherStrings.accountManagementFailed);
    expect(ipc.focus).not.toHaveBeenCalled();
    expect(ipc.readiness).not.toContain(true);
  } finally {
    await windows.dispose();
  }
});

it.each(["advertising", "withdrawing", "listening"] as const)(
  "recovers from one transient failure while %s at the next layout publication", async failure => {
    if (failure === "advertising") ipc.publishReadiness.mockRejectedValueOnce(new Error("fixture ready IPC failed"));
    if (failure === "listening") ipc.startListener.mockRejectedValueOnce(new Error("fixture listen failed"));
    const windows = await mountManagementWindows();
    try {
      if (failure === "withdrawing") {
        expect(ipc.readiness.at(-1)).toBe(true);
        ipc.publishReadiness.mockRejectedValueOnce(new Error("fixture withdrawal failed"));
        await act(async () => {
          const id = createWorkspaceAtCwd("/fixture/detached", { name: "Detached", activate: true });
          const ws = useWorkspaceListStore.getState().getWorkspace(id)!;
          useWorkspaceListStore.setState({ workspaces: [{ ...ws, detached: true }], activeWorkspaceId: id });
          await vi.dynamicImportSettled();
        });
        expect(ipc.receive).toBeUndefined();
      }
      const before = ipc.published.length;
      await act(async () => {
        const state = useWorkspaceListStore.getState();
        useWorkspaceListStore.setState({ workspaces: [...state.workspaces] });
      });
      await vi.waitFor(() => expect(ipc.published.length).toBeGreaterThan(before), { timeout: 3000 });
      expect(ipc.readiness.at(-1)).toBe(failure !== "withdrawing");
      if (failure === "listening") expect(ipc.startListener).toHaveBeenCalledTimes(2);
      if (failure !== "withdrawing") {
        await windows.click();
        expect(windows.dialog()).toHaveLength(1);
        expect(ipc.focus).toHaveBeenCalledExactlyOnceWith(ipc.child);
      }
    } finally {
      await windows.dispose();
    }
  },
);

it("publishes withdrawal without waiting for an unanswered readiness publication", async () => {
  const pending = deferred<void>();
  ipc.publishReadiness.mockReturnValueOnce(pending.promise);
  const windows = await mountManagementWindows();
  try {
    expect(ipc.publishReadiness).toHaveBeenCalledWith(true);
    await act(async () => windows.childRoot.render(null));
    expect(ipc.publishReadiness.mock.calls).toEqual([[true], [false]]);
    expect(ipc.readiness.at(-1)).toBe(false);
    await act(async () => pending.resolve(undefined));
    expect(ipc.readiness.at(-1)).toBe(false);
  } finally {
    await act(async () => pending.resolve(undefined));
    await windows.dispose();
  }
});


it("opens and raises a live main exactly once through the real AppShell listener", async () => {
  const windows = await mountManagementWindows("main");
  expect([...windows.child.querySelectorAll("button")].some(button => button.title === titleBarStrings.settings)).toBe(true);
  const opened: unknown[][] = [];
  const original = useUiStore.getState().requestSettingsTab;
  useUiStore.setState({ requestSettingsTab: (...args) => { opened.push(args); original(...args); } });
  try {
    await windows.click();
    expect(opened).toEqual([["usage", "grok", undefined, expect.any(String)]]);
    expect(windows.dialog()).toHaveLength(1);
    expect(ipc.focus).toHaveBeenCalledExactlyOnceWith("main");
    expect(windows.alert()).toBeUndefined();
  } finally {
    useUiStore.setState({ requestSettingsTab: original });
    await windows.dispose();
  }
});

it("restores management in main after its native close fails and is cancelled", async () => {
  const windows = await mountManagementWindows("main");
  try {
    expect(ipc.readiness.at(-1)).toBe(true);
    const subscription = ipc.advertised?.subscription_id;
    ipc.destroy.mockRejectedValueOnce(new Error("fixture close cancelled"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await act(async () => ipc.close!({ preventDefault: vi.fn() }));
    expect(ipc.destroy).toHaveBeenCalledOnce();
    expect(ipc.readiness.slice(-3)).toEqual([true, false, true]);
    expect(ipc.advertised?.subscription_id).toBe(subscription);
    await windows.click();
    expect(windows.dialog()).toHaveLength(1);
    expect(ipc.focus).toHaveBeenCalledExactlyOnceWith("main");
  } finally {
    await windows.dispose();
  }
});

function managementResults() {
  return vi.mocked(emitTo).mock.calls.filter(([, event]) => event === ACCOUNT_MANAGEMENT_RESULT_EVENT);
}

it("F4-02 sends explicit close first and leaves the detached terminal out of main after destruction", async () => {
  const windows = await mountManagementWindows("main");
  const mainAdopt = ipc.events.get(WINDOW_ADOPT_EVENT)!;
  const adoption = new Map<string, WorkspaceConfig[]>([[ipc.detached, [{
    id: "detached-close-workspace", name: "Detached terminal", grid_template_id: "1x1",
    detached: true, created_at: 0, panes: [{
      pane_id: "detached-close-pane", agent_id: "claude", label: "Detached terminal",
      active_tab_id: "detached-terminal", tabs: [{
        tab_id: "detached-terminal", session_id: "pty-detached-terminal",
        agent_id: "claude", type: "terminal",
      }],
    }],
  }]]]);
  const invokeBase = vi.mocked(invoke).getMockImplementation()!;
  const closeCalls: string[] = [];
  let trackClose = false;
  vi.mocked(invoke).mockImplementation((name, args, options) => {
    if (name === "take_pending_adoption" && args && "label" in args && typeof args.label === "string") {
      if (trackClose) closeCalls.push(name);
      const pending = adoption.get(args.label) ?? [];
      adoption.delete(args.label);
      return Promise.resolve(pending) as ReturnType<typeof invoke>;
    }
    if (trackClose) {
      if (name === "publish_window_fragment" && args && "readAccountManagementDocument" in args) {
        closeCalls.push("read_document");
      } else if (name === "set_window_close_intent" || name === "kill_session") {
        closeCalls.push(name);
      }
    }
    return invokeBase(name, args, options);
  });
  try {
    vi.resetModules();
    const { default: DetachedApp } = await import("../../src/App");
    const listenerCount = ipc.startListener.mock.calls.length;
    ipc.current = ipc.detached;
    await act(async () => { windows.sourceRoot.render(<DetachedApp />); });
    await vi.waitFor(() => expect(windows.source.querySelector("[data-detached-pane-shell]")).not.toBeNull());
    expect(ipc.startListener).toHaveBeenCalledTimes(listenerCount);
    const lastDetached = () => ipc.published.findLast(fragment => fragment.window_label === ipc.detached);
    await vi.waitFor(() => expect(lastDetached()?.workspaces).toHaveLength(1), { timeout: 3000 });
    expect(lastDetached()?.workspaces.flatMap(ws => ws.panes.flatMap(pane => pane.tabs?.map(tab => tab.tab_id) ?? [])))
      .toEqual(["detached-terminal"]);
    expect(useWorkspaceListStore.getState().workspaces).toHaveLength(0);

    // Substitute the native Destroyed callback. Its close-intent branch drops the
    // layout, while its crash branch queues the last published layout for main.
    ipc.destroy.mockImplementationOnce(async () => {
      if (!ipc.closing) adoption.set("main", lastDetached()!.workspaces);
    });
    ipc.readDocument.mockReturnValueOnce(new Promise<number>(() => {}));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    trackClose = true;
    const close = windows.source.querySelector<HTMLButtonElement>('button[aria-label="このタブを閉じる"]')!;
    expect(close.textContent?.trim()).toBe("×");
    await act(async () => { close.click(); });
    expect(ipc.confirm).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(WINDOW_CLOSE_TIMEOUT_MS + 1));
    expect(ipc.killSession).toHaveBeenCalledOnce();
    expect(ipc.destroy).toHaveBeenCalledOnce();
    trackClose = false;
    ipc.current = "main";
    if (adoption.has("main")) {
      await act(async () => { mainAdopt({ payload: { from_label: ipc.detached, to_label: "main" } }); });
    }
    const mainTabs = useWorkspaceListStore.getState().workspaces
      .flatMap(ws => ws.panes.flatMap(pane => pane.tabs.map(tab => tab.id)));
    expect.soft(closeCalls).toEqual(["set_window_close_intent", "take_pending_adoption", "kill_session"]);
    expect(mainTabs).not.toContain("detached-terminal");
  } finally {
    vi.useRealTimers();
    ipc.current = "main";
    vi.mocked(invoke).mockImplementation(invokeBase);
    await windows.dispose();
  }
}, 15000);

it("F4-05 refuses a delivered request when quit preparation precedes rendering", async () => {
  await prepareQuitDuringManagementRequest(false);
});

it("F4-05 keeps an opened reply when quit preparation follows rendering", async () => {
  await prepareQuitDuringManagementRequest(true);
});

async function prepareQuitDuringManagementRequest(renderFirst: boolean) {
  const windows = await mountManagementWindows("main");
  const render = deferred<void>();
  const prepareMain = ipc.events.get(QUIT_PREPARE_EVENT)!;
  try {
    // Separate module state lets only main receive prepare, as in two WebViews.
    vi.resetModules();
    const { default: SourceLauncher } = await import("../../src/components/workspace/LauncherPane");
    const { default: SourceTitleBar } = await import("../../src/components/layout/TitleBar");
    const { isPreparingLayoutQuit: sourcePreparing } = await import("../../src/lib/layoutQuit");
    const sourceLabel = "mycmux-w3";
    ipc.current = sourceLabel;
    await act(async () => windows.sourceRoot.render(<>
      <SourceTitleBar onOpenOnlinePanel={() => {}} />
      <SourceLauncher workspaceId="source" paneId="pane" tabId="launch" sessionId="launch" isActive />
    </>));
    await act(async () => windows.sourceButton(launcherStrings.specTooltip("Grok Build")).click());
    ipc.current = "main";

    ipc.settingsPending = render.promise;
    const showSettings = async () => {
      ipc.settingsPending = undefined;
      await act(async () => render.resolve(undefined));
    };
    vi.useFakeTimers();
    await windows.click(sourceLabel);
    expect(ipc.beforeDelivery).toHaveBeenCalledOnce();
    expect(managementResults()).toHaveLength(0);
    expect(windows.dialog()).toHaveLength(0);
    if (renderFirst) await showSettings();
    ipc.quitting = true;
    await act(async () => prepareMain({ payload: null }));
    expect(isPreparingLayoutQuit()).toBe(true);
    expect(sourcePreparing()).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(200));
    if (!renderFirst) await showSettings();

    expect.soft(ipc.focus).toHaveBeenCalledTimes(renderFirst ? 1 : 0);
    expect(managementResults()).toEqual([[
      { kind: "Webview", label: sourceLabel }, ACCOUNT_MANAGEMENT_RESULT_EVENT,
      { requestId: expect.any(String), fromWindow: "main", reason: renderFirst ? "opened" : "refused" },
    ]]);
    expect(windows.alert()).toBeUndefined();
  } finally {
    ipc.settingsPending = undefined;
    ipc.current = "main";
    render.resolve(undefined);
    vi.useRealTimers();
    await windows.dispose();
  }
}

it("F4-07 replies to both detached sources when they request the same company", async () => {
  await selectCompanyForTwoDetachedSources("Grok Build");
});

it("F4-07 replies only when each requested company is selected", async () => {
  await selectCompanyForTwoDetachedSources("Codex");
});

async function selectCompanyForTwoDetachedSources(secondCompany: "Grok Build" | "Codex") {
  const windows = await mountManagementWindows("main");
  const second = document.body.appendChild(document.createElement("div"));
  const secondRoot = createRoot(second);
  const render = deferred<void>();
  const secondLabel = "mycmux-w3";
  const secondButton = (label: string) => [...second.querySelectorAll("button")]
    .find(button => button.textContent === label || button.title === label)!;
  try {
    ipc.current = secondLabel;
    await act(async () => secondRoot.render(
      <LauncherPane workspaceId="other-source" paneId="other" tabId="other" sessionId="other" isActive />,
    ));
    await act(async () => secondButton(launcherStrings.specTooltip(secondCompany)).click());
    ipc.current = "main";
    ipc.settingsPending = render.promise;
    vi.useFakeTimers();

    await windows.click();
    ipc.current = secondLabel;
    await act(async () => secondButton(launcherStrings.accountManagement).click());
    ipc.current = "main";
    const requests = vi.mocked(emitTo).mock.calls.filter(([, event]) => event === OPEN_DASHBOARD_EVENT)
      .map(([, , payload]) => payload as { requestId: string; sourceWindow: string; accountProvider: string });
    expect(requests.map(({ sourceWindow, accountProvider }) => [sourceWindow, accountProvider]))
      .toEqual([[ipc.detached, "grok"], [secondLabel, secondCompany === "Codex" ? "codex" : "grok"]]);
    expect(windows.dialog()).toHaveLength(0);
    expect(managementResults()).toHaveLength(0);

    await act(async () => vi.advanceTimersByTimeAsync(200));
    ipc.settingsPending = undefined;
    await act(async () => render.resolve(undefined));
    const responseFor = ({ sourceWindow, requestId }: typeof requests[number]) => [
      { kind: "Webview", label: sourceWindow }, ACCOUNT_MANAGEMENT_RESULT_EVENT,
      { requestId, fromWindow: "main", reason: "opened" },
    ];
    if (secondCompany === "Codex") {
      expect(managementResults()).toEqual([responseFor(requests[1])]);
      expect(document.activeElement?.getAttribute("data-account-provider")).toBe("codex");
      await act(async () => { useUiStore.getState().requestSettingsTab("usage", "grok"); });
      expect(document.activeElement?.getAttribute("data-account-provider")).toBe("grok");
      expect(managementResults()).toEqual([responseFor(requests[1]), responseFor(requests[0])]);
    } else {
      expect.soft(managementResults()).toEqual(requests.map(responseFor));
    }
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect.soft(ipc.focus.mock.calls).toEqual([["main"], ["main"]]);
    expect(windows.alert()).toBeUndefined();
    expect(second.querySelector('[role="alert"]')).toBeNull();
  } finally {
    ipc.settingsPending = undefined;
    ipc.current = "main";
    render.resolve(undefined);
    vi.useRealTimers();
    await act(async () => secondRoot.unmount());
    second.remove();
    await windows.dispose();
  }
}

it("F3-01 answers the new subscription once while the retired listen reply is pending", async () => {
  const oldListen = deferred<void>();
  ipc.firstListenReply = oldListen.promise;
  const windows = await mountManagementWindows();
  try {
    expect(ipc.receivers.size).toBe(1);
    expect(ipc.advertised).toBeUndefined();
    await act(async () => windows.childRoot.render(null));
    const { default: AppShell } = await import("../../src/components/layout/AppShell");
    await act(async () => windows.childRoot.render(<AppShell />));
    expect(ipc.receivers.size).toBe(2);
    expect(ipc.advertised?.subscription_id).toEqual(expect.any(String));

    await windows.click();
    expect(managementResults()).toEqual([[
      { kind: "Webview", label: ipc.detached }, ACCOUNT_MANAGEMENT_RESULT_EVENT,
      { requestId: expect.any(String), fromWindow: ipc.child, reason: "opened" },
    ]]);
    expect(windows.child.querySelectorAll('[data-account-provider="grok"]')).toHaveLength(1);
    expect(ipc.focus).toHaveBeenCalledExactlyOnceWith(ipc.child);
    expect(windows.alert()).toBeUndefined();
  } finally {
    await act(async () => oldListen.resolve(undefined));
    await windows.dispose();
  }
});

it("F3-02 treats an opened child replaced before focus as a vanished destination", async () => {
  vi.stubGlobal("__MYCMUX_LAYOUT_PUBLICATION_ID__", "original-child");
  const windows = await mountManagementWindows();
  const opened = deferred<void>();
  ipc.beforeResult.mockReturnValueOnce(opened.promise);
  try {
    await windows.click();
    expect(managementResults()).toEqual([[
      { kind: "Webview", label: ipc.detached }, ACCOUNT_MANAGEMENT_RESULT_EVENT,
      { requestId: expect.any(String), fromWindow: ipc.child, reason: "opened" },
    ]]);
    expect(windows.child.querySelectorAll('[data-account-provider="grok"]')).toHaveLength(1);
    expect(ipc.focus).not.toHaveBeenCalled();

    await act(async () => windows.childRoot.render(null));
    vi.stubGlobal("__MYCMUX_LAYOUT_PUBLICATION_ID__", "successor-child");
    const { default: AppShell } = await import("../../src/components/layout/AppShell");
    await act(async () => windows.childRoot.render(<AppShell />));
    expect(ipc.advertised?.publication_id).toBe("successor-child");

    await act(async () => opened.resolve(undefined));
    expect(windows.child.querySelectorAll('[data-account-provider="grok"]')).toHaveLength(0);
    expect(ipc.focus).not.toHaveBeenCalled();
    expect(windows.alert()).toBe(launcherStrings.accountManagementFailed);
    expect(vi.mocked(emitTo).mock.calls.filter(([, event]) => event === OPEN_DASHBOARD_EVENT)).toHaveLength(1);
  } finally {
    opened.resolve(undefined);
    await windows.dispose();
  }
});

it("F3-05 refuses a request when the first settings render fails inside TitleBar", async () => {
  const windows = await mountManagementWindows();
  vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(ipc.advertised?.subscription_id).toEqual(expect.any(String));
    ipc.breakSettings = true;
    await windows.click();
    expect(windows.child.textContent).toContain("fixture settings render failed");
    expect(windows.dialog()).toHaveLength(0);
    expect(managementResults()).toEqual([[
      { kind: "Webview", label: ipc.detached }, ACCOUNT_MANAGEMENT_RESULT_EVENT,
      { requestId: expect.any(String), fromWindow: ipc.child, reason: "refused" },
    ]]);
    expect(ipc.focus).not.toHaveBeenCalled();
    expect(windows.alert()).toBe(launcherStrings.accountManagementFailed);
    expect(useUiStore.getState().requestedSettingsTab).toBeNull();
  } finally {
    await windows.dispose();
  }
});

it("F3-05 leaves a company section visible without replying when it renders after expiry", async () => {
  const windows = await mountManagementWindows();
  const render = deferred<void>();
  ipc.settingsPending = render.promise;
  void render.promise.then(() => { ipc.settingsPending = undefined; });
  vi.useFakeTimers();
  try {
    await windows.click();
    expect(managementResults()).toHaveLength(0);
    expect(windows.dialog()).toHaveLength(0);
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(windows.alert()).toBe(launcherStrings.accountManagementFailed);

    await act(async () => render.resolve(undefined));
    expect(windows.child.querySelectorAll('[data-account-provider="grok"]')).toHaveLength(1);
    expect(managementResults()).toHaveLength(0);
    expect(ipc.focus).not.toHaveBeenCalled();
  } finally {
    render.resolve(undefined);
    vi.useRealTimers();
    await windows.dispose();
  }
});

it("F3-14 reuses the child layout across watchdog reload and routes only after the new document listens", async () => {
  vi.stubGlobal("__MYCMUX_LAYOUT_PUBLICATION_ID__", "watchdog-child");
  const windows = await mountManagementWindows();
  const listening = deferred<void>();
  try {
    let workspaceId = "";
    await act(async () => {
      workspaceId = createWorkspaceAtCwd("/fixture/recovered", { name: "Recovered", activate: false });
    });
    const layout = useWorkspaceListStore.getState().workspaces;
    const oldMark = ipc.advertised?.subscription_id;
    expect(oldMark).toEqual(expect.any(String));
    await vi.waitFor(() => expect(ipc.published.at(-1)?.workspaces.map(workspace => workspace.id)).toContain(workspaceId));

    // The mock index withdraws readiness before the replacement document listens.
    ipc.document++;
    ipc.readinessSequence = 0;
    ipc.advertised = undefined;
    ipc.readiness.push(false);
    await act(async () => windows.childRoot.render(null));

    // A new document has its own module state, under the same native publisher.
    vi.doUnmock("../../src/components/settings/SettingsDialog");
    vi.resetModules();
    const { useWorkspaceListStore: replacementStore } = await import("../../src/stores/workspaceListStore");
    expect(replacementStore).not.toBe(useWorkspaceListStore);
    replacementStore.setState({ workspaces: layout, activeWorkspaceId: null });
    const { default: ReplacementShell } = await vi.importActual<typeof import("../../src/components/layout/AppShell")>(
      "../../src/components/layout/AppShell",
    );
    ipc.listenerReady = listening.promise;
    await act(async () => windows.childRoot.render(<ReplacementShell />));
    expect(ipc.advertised).toBeUndefined();
    expect(ipc.published.at(-1)?.workspaces.map(workspace => workspace.id)).toContain(workspaceId);

    await windows.click();
    expect(windows.alert()).toBe(launcherStrings.accountManagementFailed);
    expect(emitTo).not.toHaveBeenCalled();
    expect(ipc.focus).not.toHaveBeenCalled();

    await act(async () => listening.resolve(undefined));
    const ready = ipc.advertised as WindowTabIndex["account_management_subscription"];
    expect(ready?.publication_id).toBe("watchdog-child");
    expect(ready?.subscription_id).toEqual(expect.any(String));
    expect(ready?.subscription_id).not.toBe(oldMark);
    await windows.click();
    expect(windows.child.querySelectorAll('[data-account-provider="grok"]')).toHaveLength(1);
    expect(ipc.focus).toHaveBeenCalledExactlyOnceWith(ipc.child);
    const requests = vi.mocked(emitTo).mock.calls.filter(([, event]) => event === OPEN_DASHBOARD_EVENT);
    expect(requests).toEqual([[
      { kind: "Webview", label: ipc.child }, OPEN_DASHBOARD_EVENT, {
        accountProvider: "grok", sourceWindow: ipc.detached, targetWindow: ipc.child,
        publicationId: ready?.publication_id, subscriptionId: ready?.subscription_id,
        requestId: expect.any(String), expiresAt: expect.any(Number),
      },
    ]]);
    expect(windows.alert()).toBeUndefined();
  } finally {
    listening.resolve(undefined);
    await windows.dispose();
  }
});

it("F3-15 opens the normal child locally while main close awaits the final metadata", async () => {
  const windows = await mountManagementWindows("main");
  const metadata = deferred<Record<string, unknown>>();
  let closing: Promise<void> | undefined;
  try {
    await act(async () => { createWorkspaceAtCwd("/fixture/closing", { name: "Closing main", activate: true }); });
    ipc.metadata.mockResolvedValueOnce({}).mockReturnValueOnce(metadata.promise);
    await act(async () => { closing = ipc.close!({ preventDefault: vi.fn() }); });
    expect(ipc.confirm).toHaveBeenCalledOnce();
    expect(ipc.metadata).toHaveLastReturnedWith(metadata.promise);
    expect(ipc.destroy).not.toHaveBeenCalled();
    expect(ipc.advertised).toBeUndefined();

    // The child has its own settings store just as it does in a different WebView.
    vi.doUnmock("../../src/components/settings/SettingsDialog");
    vi.resetModules();
    const { default: ChildTitleBar } = await import("../../src/components/layout/TitleBar");
    const { default: ChildLauncher } = await import("../../src/components/workspace/LauncherPane");
    const { useUiStore: childUi } = await import("../../src/stores/uiStore");
    expect(childUi).not.toBe(useUiStore);
    const local = vi.spyOn(childUi.getState(), "requestSettingsTab");
    const main = vi.spyOn(useUiStore.getState(), "requestSettingsTab");
    // The two WebViews share one jsdom document in this fixture. Give the source
    // its own first themed root so its portal stays with the source DOM.
    windows.source.setAttribute("data-cmux-themed-root", "");
    windows.child.before(windows.source);
    ipc.current = ipc.detached;
    await act(async () => windows.sourceRoot.render(<>
      <ChildTitleBar onOpenOnlinePanel={() => {}} />
      <ChildLauncher workspaceId="source" paneId="pane" tabId="launch" sessionId="launch" isActive />
    </>));
    await act(async () => windows.sourceButton(launcherStrings.specTooltip("Grok Build")).click());
    await windows.click();
    expect(windows.child.querySelectorAll('[data-account-provider="grok"]')).toHaveLength(0);
    expect(ipc.focus).not.toHaveBeenCalled();
    expect(emitTo).not.toHaveBeenCalled();
    expect(main).not.toHaveBeenCalled();
    expect(local).toHaveBeenCalledExactlyOnceWith("usage", "grok");
    expect(windows.source.querySelectorAll('[data-account-provider="grok"]')).toHaveLength(1);
    expect(windows.alert()).toBeUndefined();
  } finally {
    ipc.current = "main";
    await act(async () => { metadata.resolve({}); await closing; });
    await windows.dispose();
  }
});
