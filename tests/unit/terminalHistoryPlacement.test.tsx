// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ mappings: vi.fn() }));
vi.mock("../../src/lib/ipc", async original => ({
  ...await original<typeof import("../../src/lib/ipc")>(), readAgentSessionMappings: mocks.mappings,
}));
import PaneTabBar from "../../src/components/workspace/PaneTabBar";
import { useTerminalHistoryPanel } from "../../src/components/terminal/useTerminalHistoryPanel";
import { beginTerminalHistoryRequest } from "../../src/components/terminal/terminalHistoryRequests";
import { TERMINAL_SEARCH_EVENT } from "../../src/components/terminal/terminalSearchEvents";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useDashboardViewStore } from "../../src/stores/dashboardViewStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import type { Workspace } from "../../src/types";
const mapping = { "placement-session": { agent_kind: "claude", session_id: "exact-placement-conversation" } };
const workspace: Workspace = { id: "placement-workspace", name: "Placement fixture", createdAt: 1, status: "running", gridTemplateId: "1x1", panes: [{
  id: "placement-pane", sessionId: "placement-session", activeTabId: "placement-tab", agentId: "shell", tabs: [{ id: "placement-tab", sessionId: "placement-session", type: "terminal", agentId: "shell" }],
}], splitColumns: [["placement-pane"]] };
let root: Root, host: HTMLDivElement, width: number;
function Harness({ visible = true, sessionId = "placement-session" }: { visible?: boolean; sessionId?: string }) {
  const panel = useTerminalHistoryPanel(sessionId, visible);
  return <>
    <PaneTabBar pane={workspace.panes[0]} workspaceId={workspace.id} isVisible={visible} hasTerminalBuffer={() => true} onZoomToggle={() => {}} />
    <output data-history-open={String(panel.transcriptPanelOpen)} />
  </>;
}
async function render(visible = true) { await act(async () => root.render(<Harness visible={visible} />)); }
async function menu() {
  await act(async () => host.querySelector<HTMLButtonElement>("button[aria-haspopup=menu]:not(.pane-hidden-tabs)")!.click());
  return host.querySelector<HTMLButtonElement>(".pane-actions-menu [data-terminal-magnifier=true]")!;
}
async function click(button: HTMLButtonElement) { await act(async () => button.click()); }
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { constructor(private callback: () => void) {} observe() { this.callback(); } disconnect() {} });
  width = 800;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
  mocks.mappings.mockReset(); mocks.mappings.mockResolvedValue(mapping);
  useSettingsStore.setState({ showTerminalHistoryButton: true });
  useWorkspaceListStore.setState({ workspaces: [workspace], activeWorkspaceId: workspace.id });
  useUiStore.setState({ activePaneId: "placement-session" });
  useDashboardViewStore.setState({ open: false });
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} });
  host = document.createElement("div"); host.dataset.cmuxThemedRoot = "true"; document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
describe("L29 history in the U3 one-row header", () => {
  it.each([800, 500, 330, 240, 200, 160, 100])("keeps plan B's header placement and a history-only menu at width %i", async value => {
    width = value; await render();
    const header = host.querySelector<HTMLButtonElement>(".pane-heading-row [data-terminal-magnifier=true]");
    expect(Boolean(header)).toBe([800, 500, 330, 240].includes(value));
    expect(Boolean(header)).toBe(Boolean(host.querySelector(".pane-tabbar-zoom")));
    const item = await menu();
    expect(item.getAttribute("data-terminal-magnifier-destination")).toBe("history");
    expect(item.textContent).toBe("会話履歴を開く"); expect(item.getAttribute("aria-disabled")).toBe("false");
    expect([...host.querySelectorAll(".pane-actions-menu [role=menuitem]")].filter(n => n.textContent === "端末内を検索")).toHaveLength(1);
  });
  it.each([800, 160])("opens the clicked history after the menu unmounts during revalidation at width %i", async value => {
    width = value; await render(); const item = await menu();
    let release!: (value: typeof mapping) => void;
    mocks.mappings.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await click(item);
    expect(host.querySelector(".pane-actions-menu")).toBeNull();
    expect(host.querySelector("output")!.dataset.historyOpen).toBe("false");
    await act(async () => release(mapping));
    expect(host.querySelector("output")!.dataset.historyOpen).toBe("true");
  });
  it.each([800, 160].flatMap(value => ["missing", "failed"].map(result => ({ value, result }))))("never falls back to terminal search after the panel's $result second check at width $value", async ({ value, result }) => {
    width = value; await render(); const item = await menu();
    const before = mocks.mappings.mock.calls.length;
    mocks.mappings.mockResolvedValueOnce(mapping);
    if (result === "failed") mocks.mappings.mockRejectedValueOnce(new Error("Mapping no longer readable"));
    else mocks.mappings.mockResolvedValueOnce({});
    const search = vi.fn(); window.addEventListener(TERMINAL_SEARCH_EVENT, search);
    try {
      await click(item);
      expect(host.querySelector(".pane-actions-menu")).toBeNull();
      expect(host.querySelector("output")!.dataset.historyOpen).toBe("false");
      expect(mocks.mappings).toHaveBeenCalledTimes(before + 2);
      expect(search).not.toHaveBeenCalled();
    } finally { window.removeEventListener(TERMINAL_SEARCH_EVENT, search); }
  });
  it.each([800, 160])("keeps missing history disabled without duplicating terminal search at width %i", async value => {
    width = value; mocks.mappings.mockResolvedValue({}); await render(); const item = await menu();
    const search = vi.fn(); window.addEventListener(TERMINAL_SEARCH_EVENT, search);
    try {
      expect(item.getAttribute("aria-disabled")).toBe("true");
      expect(item.getAttribute("data-terminal-magnifier-destination")).toBe("history");
      await click(item); expect(host.querySelector(".pane-actions-menu")).not.toBeNull();
      expect(search).not.toHaveBeenCalled(); expect(host.querySelector("output")!.dataset.historyOpen).toBe("false");
    } finally { window.removeEventListener(TERMINAL_SEARCH_EVENT, search); }
  });
  it.each(["hide", "unmount"])("still cancels pending history when the persistent owner must %s", async action => {
    await render(); const request = beginTerminalHistoryRequest("placement-session");
    if (action === "hide") await render(false);
    else await act(async () => root.render(<div />));
    expect(request.signal.aborted).toBe(true);
  });
});
