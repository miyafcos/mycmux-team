// @vitest-environment jsdom
import { ipc } from "./fixtures/accountManagementAppShell";
import { act } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import App from "../../src/App";
import LauncherPane from "../../src/components/workspace/LauncherPane";
import { launcherStrings } from "../../src/components/workspace/launcherStrings";
import { OPEN_DASHBOARD_EVENT } from "../../src/lib/ipc";
import { ACCOUNT_MANAGEMENT_RESULT_EVENT } from "../../src/lib/mainDashboardRequests";

it("routes the detached launcher only after the booting child has registered its management listener", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Element.prototype.scrollIntoView = () => {};
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  const child = document.body.appendChild(document.createElement("div"));
  const detached = document.body.appendChild(document.createElement("div"));
  const childRoot = createRoot(child);
  const detachedRoot = createRoot(detached);
  let loadShell!: () => void;
  let registerListener!: () => void;
  ipc.shellReady = new Promise(resolve => { loadShell = resolve; });
  ipc.listenerReady = new Promise(resolve => { registerListener = resolve; });
  const button = (label: string) => [...detached.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => button.textContent === label || button.title === label)!;
  const clickRegistration = async () => {
    ipc.current = ipc.detached;
    try {
      await act(async () => button(launcherStrings.accountManagement).click());
    } finally {
      ipc.current = ipc.child;
    }
  };
  const dialog = () => child.querySelectorAll('[role="dialog"][aria-modal="true"]');
  try {
    await act(async () => {
      childRoot.render(<App />);
      detachedRoot.render(<LauncherPane workspaceId="detached" paneId="pane" tabId="launcher" sessionId="launcher" isActive />);
    });
    await vi.waitFor(() => {
      expect(ipc.startingShell).toHaveBeenCalledOnce();
      expect(ipc.published.some(fragment => fragment.window_label === ipc.child)).toBe(true);
    });
    expect(vi.mocked(listen).mock.calls.some(([name]) => name === OPEN_DASHBOARD_EVENT)).toBe(false);
    await act(async () => button(launcherStrings.specTooltip("Grok Build")).click());
    await clickRegistration();
    expect(detached.querySelector('[role="alert"]')?.textContent).toBe(launcherStrings.accountManagementFailed);
    expect(emitTo).not.toHaveBeenCalled();
    expect(ipc.focus).not.toHaveBeenCalled();

    await act(async () => { loadShell(); await vi.dynamicImportSettled(); });
    await vi.waitFor(() => expect(listen).toHaveBeenCalledWith(OPEN_DASHBOARD_EVENT, expect.any(Function), {
      target: { kind: "Webview", label: ipc.child },
    }), { timeout: 3000 });
    expect(ipc.readiness).not.toContain(true);
    await clickRegistration();
    expect(detached.querySelector('[role="alert"]')?.textContent).toBe(launcherStrings.accountManagementFailed);
    expect(dialog()).toHaveLength(0);
    expect(emitTo).not.toHaveBeenCalled();

    const publications = ipc.published.length;
    await act(async () => registerListener());
    expect(ipc.readiness).toEqual([true]);
    expect(ipc.published).toHaveLength(publications);
    await clickRegistration();
    const calls = vi.mocked(emitTo).mock.calls;
    const requestId = (calls[0]?.[2] as { requestId?: string } | undefined)?.requestId;
    expect(calls).toEqual([
      [{ kind: "Webview", label: ipc.child }, OPEN_DASHBOARD_EVENT, {
        accountProvider: "grok", sourceWindow: ipc.detached, targetWindow: ipc.child,
        publicationId: ipc.advertised?.publication_id, subscriptionId: ipc.advertised?.subscription_id,
        requestId: expect.any(String), expiresAt: expect.any(Number),
      }],
      [{ kind: "Webview", label: ipc.detached }, ACCOUNT_MANAGEMENT_RESULT_EVENT, {
        requestId, fromWindow: ipc.child, reason: "opened",
      }],
    ]);
    expect(ipc.focus).toHaveBeenCalledExactlyOnceWith(ipc.child);
    expect(dialog()).toHaveLength(1);
    expect(document.activeElement).toBe(dialog()[0].querySelector('[data-account-provider="grok"]'));
    expect(detached.querySelector('[role="alert"]')).toBeNull();

    await act(async () => childRoot.render(null));
    expect(ipc.readiness).toEqual([true, false]);
    expect(ipc.receive).toBeUndefined();
    await clickRegistration();
    expect(detached.querySelector('[role="alert"]')?.textContent).toBe(launcherStrings.accountManagementFailed);
    expect(emitTo).toHaveBeenCalledTimes(2);
  } finally {
    loadShell();
    registerListener();
    await act(async () => { childRoot.unmount(); detachedRoot.unmount(); await vi.dynamicImportSettled(); });
    child.remove();
    detached.remove();
    vi.unstubAllGlobals();
  }
});
