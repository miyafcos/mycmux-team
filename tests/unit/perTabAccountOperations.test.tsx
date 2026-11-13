// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(async () => {}), listen: vi.fn(async () => () => {}) }));
vi.mock("../../src/hooks/usePaneDragSource", () => ({ usePaneDragSource: () => ({ beginPointerDrag: vi.fn(), shouldSuppressClick: () => false }) }));
vi.mock("../../src/hooks/useSavepointDragSource", () => ({ useSavepointDragSource: () => ({ beginPointerDrag: vi.fn(), shouldSuppressClick: () => false }) }));

import OnlinePanel from "../../src/components/online/OnlinePanel";
import PaneTabBar from "../../src/components/workspace/PaneTabBar";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useCliAccountStore } from "../../src/stores/cliAccountStore";
import { useToastStore } from "../../src/stores/toastStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { commitSavepointPaste } from "../../src/lib/savepointHandoffRuntime";
import { cliAccountMessage } from "../../src/lib/cliAccounts";
import { terminalPaneStrings } from "../../src/components/workspace/terminalPaneStrings";
import { onlineStrings } from "../../src/components/online/onlineStrings";
import type { Workspace } from "../../src/types";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const key = "cli_account.error.home_session_unsupported";
const expected = cliAccountMessage(key);
let host: HTMLDivElement;
let root: Root;
const entry = {
  bundle_dir: "fixture-bundle", author: "fixture", machine: "fixture", summary_line: "Fixture shared work", cwd: "fixture-work",
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", expires_at: "2099-01-01T00:00:00Z",
  pinned: false, warnings_count: 0, agent_kind: "codex", agent_session_id: "fixture-agent", files_written_count: 0, handoff_path: "fixture-handoff",
};
function Bar() {
  const pane = useWorkspaceListStore(state => state.workspaces[0].panes[0]);
  return <PaneTabBar pane={pane} workspaceId="w" hasTerminalBuffer={() => false} />;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.invoke.mockImplementation(async (command: string) => {
    if (["duplicate_agent_session", "publish_savepoint", "finalize_savepoint", "join_savepoint_summary", "join_savepoint_full"].includes(command)) throw key;
    if (command === "cleanup_online_savepoints") return { deleted_count: 0 };
    if (command === "list_online_savepoints") return [entry];
    if (command === "list_trashed_online_savepoints") return [];
    return undefined;
  });
  const workspace: Workspace = { id: "w", name: "Fixture", gridTemplateId: "1x1", status: "running", createdAt: 1, panes: [{
    id: "p", sessionId: "pty", agentId: "codex", activeTabId: "tab", cwd: "fixture-work", tabs: [
      { id: "tab", sessionId: "pty", agentId: "codex", type: "terminal", agentKind: "codex", agentSessionId: "fixture-agent", agentAccountId: "codex-work", label: "Fixture tab", cwd: "fixture-work" },
      { id: "hidden", sessionId: "hidden-pty", agentId: "codex", type: "terminal", agentKind: "codex", agentAccountId: "codex-work", label: "Hidden" },
    ],
  }] };
  useWorkspaceListStore.setState({ workspaces: [workspace], activeWorkspaceId: "w" });
  usePaneMetadataStore.setState({ metadata: { pty: { agentKind: "codex", agentSessionId: "fixture-agent", processIsShell: false, cwd: "fixture-work" } }, volatileMetadata: {} });
  useUiStore.setState({ activePaneId: "pty" });
  useSettingsStore.setState({ agentTabContent: "terminal", conversationHistoryMode: "legacy" });
  useCliAccountStore.setState({ profiles: [{ id: "codex-work", provider: "codex", label: "仕事用", email: null, identity_key: "fixture", plan: null, org_name: null, captured_at: "", last_switched_at: null, needs_relogin: false }] });
  useToastStore.setState({ toasts: [] });
  localStorage.setItem("mycmux:onlinePanel:localSessionsCollapsed", "0");
  host = document.createElement("div");
  host.dataset.cmuxThemedRoot = "true";
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function click(label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === label || button.getAttribute("aria-label") === label);
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}
async function menuAction(id: string) {
  await click(terminalPaneStrings.paneActions);
  const action = host.querySelector<HTMLButtonElement>(`button[data-pane-action="${id}"]`)!;
  expect(action, id).not.toBeNull();
  await act(async () => action.click());
}
const toastMessages = () => useToastStore.getState().toasts.map(toast => toast.message);
const calls = (command: string) => mocks.invoke.mock.calls.filter(([name]) => name === command);

describe("E-2 duplicate and save/share UI refusals", () => {
  it("translates duplicate refusal and does not fall through to the legacy handoff fallback", async () => {
    await act(async () => root.render(<Bar />));
    await menuAction("duplicate");
    expect(calls("duplicate_agent_session")).toHaveLength(1);
    expect(calls("crsm_create_handoff")).toHaveLength(0);
    expect(toastMessages()).toContain(expected);
    expect(toastMessages().join("\n")).not.toContain(key);
    expect(useWorkspaceListStore.getState().workspaces[0].panes).toHaveLength(1);
  });
  it.each(["current", "final"] as const)("translates tab %s save refusal", async kind => {
    await act(async () => root.render(<Bar />));
    await menuAction("publish");
    if (kind === "final") await click(onlineStrings.finalizeConfirm);
    else {
      const form = host.querySelector("form")!;
      await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    }
    expect(calls(kind === "final" ? "finalize_savepoint" : "publish_savepoint")).toHaveLength(1);
    expect(toastMessages()).toContain(expected);
    expect(toastMessages().join("\n")).not.toContain(key);
  });
  it.each([onlineStrings.joinSummary, onlineStrings.joinCodex, onlineStrings.joinFull])("translates the online join action %s", async label => {
    await act(async () => root.render(<OnlinePanel workspaceId="w" paneId="p" />));
    await click(onlineStrings.expandCardDetails);
    await click(label);
    expect(host.textContent).toContain(expected);
    expect(host.textContent).not.toContain(key);
    expect(calls(label === onlineStrings.joinFull ? "join_savepoint_full" : "join_savepoint_summary")).toHaveLength(1);
  });
  it("translates local-session publishing in the online panel", async () => {
    await act(async () => root.render(<OnlinePanel workspaceId="w" paneId="p" />));
    const publish = host.querySelector<HTMLButtonElement>(".online-local-publish-button")!;
    expect(publish).not.toBeNull();
    await act(async () => publish.click());
    expect(calls("publish_savepoint")).toHaveLength(1);
    expect(host.textContent).toContain(expected);
    expect(host.textContent).not.toContain(key);
  });
  it("translates joining a shared summary by dropping it on an existing tab", async () => {
    let result = true;
    await act(async () => {
      result = await commitSavepointPaste("fixture-bundle", { mode: "paste", workspaceId: "w", paneId: "p", tabId: "tab", sessionId: "pty", targetKind: "codex" });
    });
    expect(result).toBe(false);
    expect(toastMessages()).toContain(expected);
    expect(toastMessages().join("\n")).not.toContain(key);
    expect(calls("write_to_session")).toHaveLength(0);
  });
});

describe("T-1 actual tab headings", () => {
  it("uses the same account badge on the active heading and hidden-tab list", async () => {
    await act(async () => root.render(<Bar />));
    expect(host.querySelector('[data-tab-id="tab"] [data-tab-account-badge]')?.textContent).toBe("仕事用");
    await act(async () => host.querySelector<HTMLButtonElement>(".pane-hidden-tabs")!.click());
    const badge = host.querySelector<HTMLElement>('[data-menu-tab-id="hidden"] [data-tab-account-badge]')!;
    expect(badge.textContent).toBe("仕事用");
    expect(badge.title).toBe("アカウント: 仕事用 (このタブだけ)");
  });
});
