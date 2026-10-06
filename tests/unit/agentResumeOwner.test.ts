import { describe, expect, it, vi } from "vitest";
import { ownerWindowInFragments, ownerLocationInFragments, agentResumeOwnerLocation, agentResumeOwnerWindow, openAgentResumeOwner, connectAgentResumeOwnerNavigation } from "../../src/lib/agentResumeOwner";
import type { WindowFragment } from "../../src/lib/ipc";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";

const mocks = vi.hoisted(() => ({ fragments: vi.fn(), emitTo: vi.fn(), show: vi.fn(), focus: vi.fn(), listen: vi.fn().mockResolvedValue(vi.fn()) }));
vi.mock("../../src/lib/ipc", async original => ({ ...await original<typeof import("../../src/lib/ipc")>(), getWindowFragments: mocks.fragments }));
vi.mock("@tauri-apps/api/event", () => ({ emitTo: mocks.emitTo, listen: mocks.listen }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ WebviewWindow: { getByLabel: vi.fn(async () => ({ show: mocks.show, setFocus: mocks.focus })) } }));
vi.mock("../../src/lib/windowContext", () => ({ windowLabel: () => "main" }));
const peer = { window_label: "peer", pending: false, workspaces: [{ name: "Research", panes: [{ agent_id: "claude-code", label: "Parent", tabs: [{ session_id: "owner", label: "Design review" }] }] }] } as unknown as WindowFragment;
describe("SI owner navigation", () => {
  it("distinguishes a hidden PTY from an owner in a peer window", async () => {
    expect(ownerWindowInFragments([peer], "owner")).toBe("peer");
    expect(ownerLocationInFragments([peer], "owner")).toEqual({ windowLabel: "peer", workspaceName: "Research", paneName: "Design review", otherWindow: true });
    expect(ownerWindowInFragments([{ ...peer, pending: true }], "owner")).toBeNull();
    expect(ownerWindowInFragments([peer], "hidden")).toBeNull();
    useWorkspaceListStore.getState()._replaceWorkspaces([]); mocks.fragments.mockResolvedValue([peer]);
    expect(await agentResumeOwnerWindow("owner")).toBe("peer");
    expect(await agentResumeOwnerLocation("owner")).toMatchObject({ workspaceName: "Research", paneName: "Design review", otherWindow: true });
    await openAgentResumeOwner("owner");
    expect(mocks.emitTo).toHaveBeenCalledWith("peer", "mycmux://agent-resume-open-owner", { sessionId: "owner" });
    expect(mocks.show).toHaveBeenCalledOnce(); expect(mocks.focus).toHaveBeenCalledOnce();
  });
  it("binds navigation to the current webview and removes its listener", async () => {
    const stop=connectAgentResumeOwnerNavigation();
    await vi.waitFor(() => expect(mocks.listen).toHaveBeenCalled(), { timeout: 3000 });
    expect(mocks.listen.mock.calls.at(-1)?.[2]).toEqual({ target: { kind: "Webview", label: "main" } });
    stop();
  });
});
