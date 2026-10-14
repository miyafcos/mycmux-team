// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/ipc");
vi.mock("../../src/hooks/usePaneDragSource", () => ({
  usePaneDragSource: () => ({ beginPointerDrag: vi.fn(), shouldSuppressClick: () => false }),
}));

import PaneTabBar from "../../src/components/workspace/PaneTabBar";
import { terminalPaneStrings } from "../../src/components/workspace/terminalPaneStrings";
import { useSavepointDragSource } from "../../src/hooks/useSavepointDragSource";
import { crsmListSessions, getWindowFragments, getPtyMetadataSnapshot, getSessionOutputSnapshot, onSavepointPublishProgress, readAgentSessionMappings } from "../../src/lib/ipc";
import { focusController } from "../../src/lib/focusController";
import { usePaneDragStore } from "../../src/stores/paneDragStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useSavepointDragStore, type SavepointDragItem } from "../../src/stores/savepointDragStore";
import { useSessionAttentionStore } from "../../src/stores/sessionAttentionStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import type { Pane, PaneTab, Workspace } from "../../src/types";

const item: SavepointDragItem = {
  kind: "savepoint", sourceWorkspaceId: "origin", sourceSessionId: "origin-pty",
  sourceAgentKind: "claude", bundleDir: "/synthetic/savepoint", label: "Synthetic savepoint",
};
const paste = {
  mode: "paste", workspaceId: "w", paneId: "p", tabId: "t1",
  sessionId: "pty-1", targetKind: "claude",
};
const right = { mode: "spawn", workspaceId: "w", paneId: "p", direction: "right" };
const exactTarget = "[data-savepoint-drop-workspace-id][data-savepoint-drop-pane-id][data-savepoint-drop-tab-id]";
const kebab = 'button[aria-label="' + terminalPaneStrings.paneActions + '"]';
let root: Root;
let host: HTMLDivElement;
let width: number;
let hit: Element | null;
let originalHitTest: PropertyDescriptor | undefined;

function SavepointHandle() {
  const { beginPointerDrag } = useSavepointDragSource();
  return <button type="button" data-savepoint-drag-handle="true"
    onPointerDown={(event) => beginPointerDrag(event, item)}>Savepoint</button>;
}

function pointer(type: string, x = 10, y = 10): MouseEvent {
  const event = new MouseEvent(type, { button: 0, clientX: x, clientY: y, bubbles: true, cancelable: true });
  Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: "mouse" } });
  return event;
}

async function mount(empty = false) {
  const pane: Pane = {
    id: "p", sessionId: "pty-1", agentId: "shell-starter", activeTabId: empty ? "" : "t1",
    tabs: empty ? [] : [0, 1, 2].map((index): PaneTab => ({
      id: "t" + index, sessionId: "pty-" + index, agentId: "shell-starter",
      type: "terminal", label: "Session " + index,
    })),
  };
  const workspace: Workspace = {
    id: "w", name: "Synthetic", gridTemplateId: "1x1", status: "running", createdAt: 1,
    panes: [pane], splitColumns: [["p"]],
  };
  await act(async () => {
    useWorkspaceListStore.setState({ workspaces: [workspace], activeWorkspaceId: "w" });
    root.render(<>
      <SavepointHandle />
      <div data-savepoint-drop-pane="true" data-dnd-workspace-id="w" data-dnd-pane-id="p">
        <PaneTabBar pane={pane} workspaceId="w" hasTerminalBuffer={() => true} onZoomToggle={() => {}}
          onSplitRight={() => {}} onClose={() => {}} />
        <div data-pane-body="true" />
      </div>
    </>);
  });
  host.querySelector<HTMLElement>("[data-savepoint-drop-pane]")!.getBoundingClientRect = () => ({
    left: 0, right: width, top: 0, bottom: 400, width, height: 400,
  }) as DOMRect;
}

async function startDrag() {
  await act(async () => host.querySelector("[data-savepoint-drag-handle]")!.dispatchEvent(pointer("pointerdown")));
}

async function hover(selector: string, x: number, y: number) {
  hit = host.querySelector(selector);
  expect(hit).not.toBeNull();
  await act(async () => window.dispatchEvent(pointer("pointermove", x, y)));
  expect(useSavepointDragStore.getState().item).toEqual(item);
  return useSavepointDragStore.getState().target;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: () => void) {}
    observe() { this.callback(); }
    disconnect() {}
  });
  width = 800;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function () {
    return (this as HTMLElement).classList.contains("pane-tabbar") ? width : 800;
  });
  vi.spyOn(focusController, "request").mockImplementation(() => {});
  useSettingsStore.setState({ showTerminalHistoryButton: false });
  usePaneMetadataStore.setState({
    metadata: { "pty-0": { agentKind: "codex" }, "pty-1": { agentKind: "claude" } }, volatileMetadata: {},
  });
  useSessionAttentionStore.getState().resetForTests();
  useUiStore.setState({ activePaneId: "pty-1" });
  usePaneDragStore.getState().clearDrag();
  useSavepointDragStore.getState().clearDrag();
  vi.mocked(crsmListSessions).mockResolvedValue([]);
  vi.mocked(getWindowFragments).mockResolvedValue([]);
  vi.mocked(getPtyMetadataSnapshot).mockResolvedValue({});
  vi.mocked(getSessionOutputSnapshot).mockResolvedValue({});
  vi.mocked(onSavepointPublishProgress).mockResolvedValue(() => {});
  vi.mocked(readAgentSessionMappings).mockResolvedValue({});
  hit = null;
  originalHitTest = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => hit) });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  // Inspect real resolution while dragging; cancel instead of committing synthetic IPC work.
  await act(async () => {
    window.dispatchEvent(pointer("pointercancel"));
    root.unmount();
  });
  host.remove();
  if (originalHitTest) Object.defineProperty(document, "elementFromPoint", originalHitTest);
  else Reflect.deleteProperty(document, "elementFromPoint");
  useSavepointDragStore.getState().clearDrag();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("real savepoint resolution over the rendered heading", () => {
  it.each([800, 500, 320, 244, 204, 181, 164, 120])(
    "preserves name/spacer paste and right-edge control spawn at width %i", async (value) => {
      width = value;
      await mount();
      await startDrag();
      expect(await hover(".pane-active-heading-name", 50, 18)).toEqual(paste);
      expect(await hover(".pane-heading-spacer", width / 2, 18)).toEqual(paste);
      // The tab's own × belongs to the name; the right-edge controls keep spawn.
      expect(await hover(".pane-heading-content > .pane-header-close", 60, 18)).toEqual(paste);
      for (const selector of [".pane-hidden-tabs", ".pane-tabbar-split", ".pane-tabbar-zoom", ".pane-place-close", kebab]) {
        if ((selector === ".pane-tabbar-zoom" && value < 210) || ((selector === ".pane-tabbar-split" || selector === ".pane-place-close") && value < 250)) {
          expect(host.querySelector(selector)).toBeNull();
          continue;
        }
        expect(await hover(selector, width - 12, 18)).toEqual(right);
        expect(hit!.closest(exactTarget)).toBeNull();
      }
    },
  );

  it.each([
    [".pane-hidden-tabs", '[data-menu-tab-id="t0"]'],
    [kebab, '[data-pane-action="new-tab"]'],
  ])("keeps the menu opened by %s outside the exact active-session target", async (trigger, entry) => {
    await mount();
    await startDrag();
    expect(await hover(".pane-heading-spacer", 400, 18)).toEqual(paste);
    // A click without pointerdown models a menu opened by keyboard during the drag.
    await act(async () => host.querySelector<HTMLButtonElement>(trigger)!.click());
    expect(await hover(entry, 788, 80)).toEqual(right);
    expect(hit!.closest(exactTarget)).toBeNull();
    expect(await hover(entry, 400, 80)).toBeNull();
  });

  it.each([
    [12, 200, { mode: "spawn", workspaceId: "w", paneId: "p", direction: "left" }],
    [788, 200, right],
    [400, 392, paste],
    [400, 200, null],
    [400, 18, null],
  ] as const)("retains body resolution at %i,%i", async (x, y, expected) => {
    await mount();
    await startDrag();
    expect(await hover("[data-pane-body]", x, y)).toEqual(expected);
    expect(hit!.closest(exactTarget)).toBeNull();
  });

  it.each([800, 120])("uses pane fallback for an empty heading at width %i", async (value) => {
    width = value;
    await mount(true);
    expect(host.querySelector(".pane-active-heading")).toBeNull();
    await startDrag();
    expect(await hover(".pane-heading-spacer", value - 12, 18)).toEqual(right);
    expect(hit!.closest(exactTarget)).toBeNull();
    expect(await hover("[data-pane-body]", value / 2, 392)).toBeNull();
  });
});
