// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PaneTabBar from "../../src/components/workspace/PaneTabBar";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useUiStore } from "../../src/stores/uiStore";
import { focusController } from "../../src/lib/focusController";
import type { PaneTab, Workspace } from "../../src/types";

let root: Root;
let container: HTMLDivElement;
const select = vi.fn();
function Bar() {
  const pane = useWorkspaceListStore(s => s.workspaces[0].panes[0]);
  return createElement(PaneTabBar, { pane, workspaceId: "w", hasTerminalBuffer: () => false, onSelectTab: select });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.clearAllMocks();
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  useUiStore.setState({ activePaneId: "pty-active" });
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} });
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
async function render(state: string) {
  const tabs: PaneTab[] = [{ id: "active", sessionId: "pty-active", agentId: "shell", type: "terminal", label: "Active" }];
  if (state !== "active") tabs.push({ id: "target", sessionId: "pty-target", agentId: "shell", type: "terminal", label: "Target", ...(state === "declared" ? { lifecycle: "declared", agentKind: "codex" } : {}) });
  if (state === "overflow") for (let i = 0; i < 40; i++) tabs.push({ id: `extra-${i}`, sessionId: `pty-${i}`, agentId: "shell", type: "launcher" });
  const workspace: Workspace = { id: "w", name: "Rename", gridTemplateId: "1x1", status: "running", createdAt: 1, panes: [{
    id: "p", sessionId: "pty-active", agentId: "shell", tabs, activeTabId: "active", ...(state === "pinned" ? { pinnedTabId: "target" } : {}),
  }] };
  useWorkspaceListStore.setState({ workspaces: [workspace], activeWorkspaceId: "w" });
  await act(async () => root.render(createElement(Bar)));
  return state === "active" ? "active" : "target";
}
function pill(id: string) { return container.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)!; }
function editor() { return document.querySelector<HTMLInputElement>('[data-pane-tab-rename-input]'); }
async function change(value: string) {
  const input = editor()!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function key(value: string) { await act(async () => editor()!.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true }))); }

describe("C4 rename without selection or terminal activation", () => {
  for (const state of ["active", "inactive", "pinned", "declared", "overflow"]) {
    for (const entry of ["context", "double-click"]) {
      it(`${state}, ${entry}, three saves and cancellations`, async () => {
        const id = await render(state);
        const request = vi.spyOn(focusController, "request");
        for (let i = 0; i < 3; i++) {
          const open = async () => {
            if (entry === "context") {
              await act(async () => pill(id).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 })));
              const button = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(b => b.textContent === "\u540d\u524d\u3092\u5909\u66f4")!;
              expect(button).toBeDefined(); await act(async () => button.click());
            } else {
              await act(async () => {
                pill(id).dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
                pill(id).dispatchEvent(new MouseEvent("click", { detail: 2, bubbles: true }));
                pill(id).dispatchEvent(new MouseEvent("dblclick", { detail: 2, bubbles: true }));
              });
            }
            expect(editor()).not.toBeNull();
          };
          await open(); await change(`Saved-${i}`); await key("Enter");
          expect(editor()).toBeNull();
          expect(useWorkspaceListStore.getState().workspaces[0].panes[0].tabs.find(t => t.id === id)?.label).toBe(`Saved-${i}`);
          await open(); await change("Cancelled"); await key("Escape");
          expect(editor()).toBeNull();
          expect(useWorkspaceListStore.getState().workspaces[0].panes[0].tabs.find(t => t.id === id)?.label).toBe(`Saved-${i}`);
          expect(select).not.toHaveBeenCalled();
          expect(useWorkspaceListStore.getState().workspaces[0].panes[0].activeTabId).toBe("active");
          expect(useUiStore.getState().activePaneId).toBe("pty-active");
          expect(request.mock.calls.some(([, options]) => options?.focus === true)).toBe(false);
        }
      });
    }
  }
});
