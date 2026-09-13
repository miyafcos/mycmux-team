// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  close: vi.fn(async () => {}),
  setTitle: vi.fn(async () => {}),
  terminal: vi.fn(),
  browser: vi.fn(),
  webController: vi.fn(),
  emit: vi.fn(async () => {}),
  setPosition: vi.fn(async () => {}),
  outerPosition: vi.fn(async () => ({ x: 300, y: 150 })),
  scaleFactor: vi.fn(async () => 1.5),
  confirmPaneClose: vi.fn(async () => true),
  killSession: vi.fn(async () => {}),
  discardAndClose: vi.fn(async () => {}),
  evictTerminalCache: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ emit: mocks.emit }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "child", close: mocks.close, setTitle: mocks.setTitle, setPosition: mocks.setPosition, outerPosition: mocks.outerPosition, scaleFactor: mocks.scaleFactor }),
}));
vi.mock("../../src/lib/paneCloseConfirmation", () => ({ confirmPaneClose: mocks.confirmPaneClose }));
vi.mock("../../src/lib/focusController", () => ({ focusController: { request: vi.fn() } }));
vi.mock("../../src/lib/paneCloseLifecycle", () => ({ beforePaneClose: vi.fn() }));
vi.mock("../../src/lib/ipc", () => ({ killSession: mocks.killSession }));
vi.mock("../../src/components/layout/SocketListener", () => ({ discardWindowWorkspacesAndClose: mocks.discardAndClose }));
vi.mock("../../src/components/terminal/XTermWrapper", () => ({
  default: (props: { sessionId: string }) => { mocks.terminal(props); return <div data-terminal-session={props.sessionId} />; },
  evictTerminalCache: mocks.evictTerminalCache,
}));
vi.mock("../../src/components/workspace/BrowserPane", () => ({
  default: (props: { htmlPath: string }) => { mocks.browser(props); return <div data-browser-path={props.htmlPath} />; },
}));
vi.mock("../../src/components/workspace/WebPaneController", () => ({
  default: () => { mocks.webController(); return null; },
}));
vi.mock("../../src/components/workspace/WebPaneStatusBar", () => ({
  default: (props: { tabId: string }) => <div data-web-status-tab-id={props.tabId} />,
}));
vi.mock("../../src/components/workspace/LauncherPane", () => ({ default: () => <div data-launcher-content="true" /> }));
vi.mock("../../src/components/workspace/TerminalPane", () => ({ buildLaunchArgs: (_command: string, args: string[]) => args }));
vi.mock("../../src/components/layout/AppShell", () => ({ buildThemeVars: () => ({}) }));

import DetachedPaneShell from "../../src/components/layout/DetachedPaneShell";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import type { DetachedWorkspace } from "../../src/lib/detachedPane";

function workspace(type: "terminal" | "launcher" | "browser" | "web" = "terminal"): DetachedWorkspace {
  const tab = { id: "tab", sessionId: "pty-original-pane-tab", agentId: "shell", label: "Session", type, ...(type === "browser" ? { htmlPath: "C:/preview.pdf", sourceKind: "pdf" as const } : {}),
    ...(type === "web" ? { presetId: "browser" } : {}) };
  return { id: "transfer", name: "Transfer", gridTemplateId: "1x1", status: "running", createdAt: 0,
    detached: true, panes: [{ id: "pane", agentId: tab.agentId, sessionId: tab.sessionId, activeTabId: tab.id, tabs: [tab] }] };
}

afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("DetachedPaneShell", () => {
  it.each(["terminal", "browser", "web"] as const)("coalesces %s screen-space moves, ignores buttons, and restores on Escape", async (type) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let nextFrame: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback) => { nextFrame = callback; return 1; }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn(() => { nextFrame = null; }));
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const pointer = (node: Element, type: string, x: number, y: number) => {
      const event = new MouseEvent(type, { bubbles: true, button: 0, screenX: x, screenY: y });
      Object.defineProperty(event, "pointerId", { value: 7 });
      node.dispatchEvent(event);
    };
    try {
      await act(async () => root.render(<DetachedPaneShell workspace={workspace(type)} />));
      const band = host.querySelector("[data-detached-pane-shell]")!.children[0] as HTMLElement;
      band.setPointerCapture = vi.fn();
      band.hasPointerCapture = () => true;
      band.releasePointerCapture = vi.fn();
      await act(async () => pointer(band.querySelector("button")!, "pointerdown", 220, 110));
      expect(mocks.outerPosition).not.toHaveBeenCalled();
      await act(async () => pointer(band, "pointerdown", 220, 110));
      await act(async () => {
        pointer(band, "pointermove", 250, 130);
        pointer(band, "pointermove", 280, 150);
      });
      expect(mocks.setPosition).not.toHaveBeenCalled();
      expect(mocks.emit.mock.calls.map((call: unknown[]) => (call[1] as { phase: string }).phase)).toEqual(["start"]);
      await act(async () => { nextFrame?.(0); });
      expect(mocks.setPosition).toHaveBeenCalledTimes(1);
      expect(mocks.emit).toHaveBeenLastCalledWith("mycmux://detached-drag", expect.objectContaining({
        label: "child", workspaceId: "transfer", sessionId: "pty-original-pane-tab", tabId: "tab",
        screenX: 280, screenY: 150, phase: "move",
      }));
      expect(mocks.setPosition).toHaveBeenLastCalledWith(expect.objectContaining({ x: 260, y: 140 }));
      await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
      expect(mocks.setPosition).toHaveBeenLastCalledWith(expect.objectContaining({ x: 200, y: 100 }));
      await act(async () => pointer(band, "pointermove", 999, 999));
      expect(mocks.setPosition).toHaveBeenCalledTimes(2);
      await act(async () => pointer(band, "pointerdown", 220, 110));
      await act(async () => pointer(band, "pointerup", 300, 160));
      expect(mocks.setPosition).toHaveBeenLastCalledWith(expect.objectContaining({ x: 280, y: 150 }));
      expect(nextFrame).toBeNull();
      expect(mocks.close).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
  it.each(["terminal", "launcher", "browser", "web"] as const)("renders only the band and %s content", async (type) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(<DetachedPaneShell workspace={workspace(type)} />));
      const shell = host.querySelector("[data-detached-pane-shell]")!;
      const band = shell.children[0] as HTMLElement;
      expect(band.style.height).toBe("30px");
      expect(band.hasAttribute("data-tauri-drag-region")).toBe(false);
      expect(band.textContent).toContain("Session");
      // × closes the pane; the way back is dragging the band onto a tab strip.
      expect(band.querySelectorAll("button")).toHaveLength(1);
      expect(band.querySelector("button")!.textContent).toBe("×");
      expect(band.querySelector("button")!.getAttribute("aria-label")).toBe("このペインを閉じる");
      expect(shell.children).toHaveLength(2);
      if (type === "terminal") {
        expect(host.querySelector("[data-terminal-session]")?.getAttribute("data-terminal-session")).toBe("pty-original-pane-tab");
        expect(mocks.browser).not.toHaveBeenCalled();
      } else {
        expect(mocks.terminal).not.toHaveBeenCalled();
        if (type === "browser") {
          expect(host.querySelector("[data-browser-path]")?.getAttribute("data-browser-path")).toBe("C:/preview.pdf");
          expect(mocks.browser).toHaveBeenCalledWith(expect.objectContaining({
            htmlPath: "C:/preview.pdf", previewPath: "C:/preview.pdf", sourceKind: "pdf",
            reloadKey: 0, isDirty: false,
          }));
        } else if (type === "web") {
          expect(mocks.webController).toHaveBeenCalled();
          expect(host.querySelector("[data-web-pane-host-tab-id]")?.getAttribute("data-web-pane-host-tab-id")).toBe("tab");
          expect(host.querySelector("[data-web-pane-preset-id]")?.getAttribute("data-web-pane-preset-id")).toBe("browser");
          expect(host.querySelector("[data-web-status-tab-id]")).not.toBeNull();
        } else {
          expect(host.querySelector("[data-launcher-content]")).not.toBeNull();
        }
      }
      await act(async () => band.querySelector("button")!.click());
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(mocks.confirmPaneClose).toHaveBeenCalledTimes(1);
      // A launcher tab holds no PTY, so there is nothing to kill for it.
      if (type === "terminal" || type === "browser") expect(mocks.killSession).toHaveBeenCalledWith("pty-original-pane-tab");
      else expect(mocks.killSession).not.toHaveBeenCalled();
      expect(mocks.discardAndClose).toHaveBeenCalledTimes(1);
      // Closing the pane must not hand it back: that is what the drag is for.
      expect(mocks.close).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it.each(["html", "office"] as const)("preserves %s preview props and edit callbacks", async (sourceKind) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const dirty = vi.spyOn(useWorkspaceLayoutStore.getState(), "setBrowserTabDirty").mockImplementation(() => {});
    const saved = vi.spyOn(useWorkspaceLayoutStore.getState(), "refreshBrowserTabPreview").mockImplementation(() => {});
    const value = workspace("browser");
    Object.assign(value.panes[0].tabs[0], {
      sourcePath: "C:/source.docx", sourceKind, previewPath: "C:/preview.html",
      reloadCounter: 3, isDirty: true,
    });
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      await act(async () => root.render(<DetachedPaneShell workspace={value} />));
      const props = mocks.browser.mock.calls.at(-1)![0];
      expect(props).toMatchObject({
        sourcePath: "C:/source.docx", sourceKind, previewPath: "C:/preview.html", reloadKey: 3, isDirty: true,
      });
      props.onDirtyChange(false);
      props.onSaved({ previewPath: "C:/saved.html", sourcePath: "C:/source.docx" });
      expect(dirty).toHaveBeenCalledWith("transfer", "pane", "tab", false);
      expect(saved).toHaveBeenCalledWith("transfer", "pane", "tab", {
        previewPath: "C:/saved.html", sourcePath: "C:/source.docx", sourceKind,
      });
      expect(mocks.terminal).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dirty.mockRestore();
      saved.mockRestore();
    }
  });

  it("does not launch a terminal for a browser tab missing its path", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const value = workspace("browser");
    delete value.panes[0].tabs[0].htmlPath;
    const root = createRoot(document.createElement("div"));
    try {
      await act(async () => root.render(<DetachedPaneShell workspace={value} />));
      expect(mocks.browser).not.toHaveBeenCalled();
      expect(mocks.terminal).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("names the undecorated window after the pane", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(<DetachedPaneShell workspace={workspace()} />));
      expect(mocks.setTitle).toHaveBeenCalledWith("Session");
      expect(document.title).toBe("Session");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
