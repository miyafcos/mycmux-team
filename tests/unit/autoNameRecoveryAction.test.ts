// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { buildLocalGroupingScan } from "../../src/components/layout/groupingLocalPlan";
import { buildAutoNameEvidence, namingBinding, type AutoNameScan } from "../../src/lib/autoNameMaterial";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useAutoNameRuntimeStore } from "../../src/stores/autoNameRuntimeStore";
import { recoverNamesFromContent, undoRecoveredNames } from "../../src/lib/nameRecoveryAction";
import type { Workspace } from "../../src/types";
const fake = vi.hoisted(() => ({ confirm: vi.fn(), scan: vi.fn() }));
vi.mock("../../src/lib/appConfirmation", () => ({ confirm: fake.confirm }));
vi.mock("../../src/lib/autoNameEvidence", async importOriginal => ({ ...await importOriginal<typeof import("../../src/lib/autoNameEvidence")>(), readAutoNameScan: fake.scan }));
function original(): Workspace {
  return { id: "recover", name: "古い名前", createdAt: 0, gridTemplateId: "1x1", status: "running", splitColumns: [["p"]],
    panes: [{ id: "p", sessionId: "pty", agentId: "shell-starter", activeTabId: "tab", tabs: [{ id: "tab", sessionId: "pty", agentId: "shell-starter", label: "readable launch name", agentKind: "codex", agentSessionId: "agent", cwd: "C:/sample" }] }] };
}
async function scan(): Promise<AutoNameScan> {
  const value = await buildLocalGroupingScan({ workspaces: useWorkspaceListStore.getState().workspaces, metadata: {}, attentionByTabId: {}, now: 0 });
  const evidence = buildAutoNameEvidence(value.tabs[0]); evidence.instructions = ["方程式の解説スライドを作る"]; evidence.contentKey = "current"; evidence.binding = namingBinding(value.tabs[0]);
  evidence.instructionHistoryComplete = true; // Explicit complete unit evidence, not an absent native proof.
  return { ...value, naming: new Map([["tab", evidence]]) };
}
beforeEach(() => {
  vi.useFakeTimers(); fake.confirm.mockReset().mockResolvedValue(true); fake.scan.mockReset().mockImplementation(scan);
  useWorkspaceListStore.setState({ workspaces: [original()], activeWorkspaceId: "recover", layoutRevision: 0 });
  useSettingsStore.setState({ autoPaneNamingEnabled: false, autoWorkspaceNamingEnabled: false });
  useAutoNameRuntimeStore.setState({ recovery: null, meanings: new Map(), descriptions: new Map(), revision: 0 });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
it("does nothing when confirmation is cancelled", async () => {
  fake.confirm.mockResolvedValue(false); await recoverNamesFromContent();
  expect(useWorkspaceListStore.getState().workspaces).toEqual([original()]); expect(fake.scan).not.toHaveBeenCalled(); expect(useAutoNameRuntimeStore.getState().recovery).toBeNull();
});
it("explicitly renames with both automatic flags off and can restore the original fields", async () => {
  await recoverNamesFromContent("recover");
  const renamed = useWorkspaceListStore.getState().workspaces[0];
  expect(renamed.name).toBe("方程式の解説スライド制作"); expect(renamed.nameSource).toBe("auto");
  expect(renamed.panes[0].tabs[0]).toMatchObject({ label: "readable launch name", labelSource: "launch", displayName: "方程式の解説スライド制作" });
  undoRecoveredNames();
  expect(useWorkspaceListStore.getState().workspaces[0].name).toBe(original().name);
  expect(useWorkspaceListStore.getState().workspaces[0].panes[0].tabs).toEqual(original().panes[0].tabs);
});
it("does not overwrite manual changes made during the asynchronous read", async () => {
  let release!: (value: AutoNameScan) => void;
  fake.scan.mockImplementation(async () => { const value = await scan(); return new Promise(resolve => { release = () => resolve(value); }); });
  const running = recoverNamesFromContent("recover"); await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  useWorkspaceListStore.getState().renameWorkspace("recover", "手動ワークスペース");
  const ws = useWorkspaceListStore.getState().workspaces[0];
  useWorkspaceListStore.setState({ workspaces: [{ ...ws, panes: [{ ...ws.panes[0], tabs: [{ ...ws.panes[0].tabs[0], label: "手動ペイン", labelSource: "user" }] }] }] });
  release(await scan()); await running; undoRecoveredNames();
  const after = useWorkspaceListStore.getState().workspaces[0]; expect(after.name).toBe("手動ワークスペース"); expect(after.panes[0].tabs[0].label).toBe("手動ペイン");
});
it("discards an in-flight recovery result when it has already been undone", async () => {
  let release!: (value: AutoNameScan) => void;
  fake.scan.mockImplementation(async () => new Promise(resolve => { release = resolve; }));
  const running = recoverNamesFromContent(); await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const material = await scan(); undoRecoveredNames(); release(material); await running;
  expect(useWorkspaceListStore.getState().workspaces[0].name).toBe(original().name);
  expect(useWorkspaceListStore.getState().workspaces[0].panes[0].tabs).toEqual(original().panes[0].tabs);
});
it("reports an explicit recovery and lets its UI action undo with the same feedback", async () => {
  const feedback = vi.fn();
  await recoverNamesFromContent("recover", feedback);
  expect(feedback).toHaveBeenCalledExactlyOnceWith("applied", expect.any(Function));
  feedback.mock.calls[0][1]();
  expect(feedback).toHaveBeenLastCalledWith("undone");
  expect(feedback).toHaveBeenCalledTimes(2);
  expect(useWorkspaceListStore.getState().workspaces[0].panes[0].tabs).toEqual(original().panes[0].tabs);
});
it("reports a failed explicit read while leaving recovery available, and stays silent on cancellation", async () => {
  const feedback = vi.fn();
  fake.confirm.mockResolvedValue(false);
  await recoverNamesFromContent("recover", feedback);
  expect(feedback).not.toHaveBeenCalled();
  fake.confirm.mockResolvedValue(true);
  fake.scan.mockRejectedValue(new Error("read unavailable"));
  await recoverNamesFromContent("recover", feedback);
  expect(feedback).toHaveBeenCalledExactlyOnceWith("failed");
  expect(useAutoNameRuntimeStore.getState().recovery).not.toBeNull();
});
