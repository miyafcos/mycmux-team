import { beforeEach, describe, expect, it, vi } from "vitest";
import { consumeHandoffLaunchEnv, consumePaneHandoffLaunchEnv, HANDOFF_LAUNCH_ENV_KEYS } from "../../src/lib/handoffLaunchEnv";
import { buildTerminalPaneLaunchEnv } from "../../src/lib/terminalPaneLaunchEnv";
import { startBackgroundTabSession } from "../../src/components/layout/socketCommands";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import type { Pane, Workspace } from "../../src/types";

const ipc = vi.hoisted(() => ({ createSession: vi.fn(), ackFrontendData: vi.fn() }));
vi.mock("../../src/lib/ipc", () => ipc);

const handoff = {
  MYCMUX_HANDOFF: "claude",
  MYCMUX_HANDOFF_FROM: "codex",
  MYCMUX_HANDOFF_PROMPT_FILE: "C:/spec/prompt.txt",
  MYCMUX_HANDOFF_FROM_SESSION: "source-conversation",
  MYCMUX_HANDOFF_LAUNCH_KIND: "handoff",
  MYCMUX_LAUNCH_TARGET: "codex",
  MYCMUX_MODEL: "keep-model",
  PATH: "keep-path",
};

function pane(inherited = false): Pane {
  const tab = {
    id: "tab", sessionId: "pty", agentId: "shell-starter", type: "terminal" as const,
    agentKind: "codex" as const, agentSessionId: "own-conversation",
    ...(inherited ? {} : { launchEnv: { ...handoff } }),
  };
  return {
    id: "pane", agentId: tab.agentId, sessionId: tab.sessionId, activeTabId: tab.id,
    launchEnv: { ...handoff },
    tabs: [tab, { id: "other", sessionId: "other-pty", agentId: "shell-starter", type: "terminal" }],
  };
}

function installPane(value: Pane): void {
  const workspace: Workspace = { id: "workspace", name: "Workspace", gridTemplateId: "1x1", status: "running", createdAt: 1, panes: [value] };
  useWorkspaceListStore.setState({ workspaces: [workspace], activeWorkspaceId: workspace.id });
}

function currentPane(): Pane { return useWorkspaceListStore.getState().workspaces[0].panes[0]; }

beforeEach(() => { vi.clearAllMocks(); ipc.createSession.mockResolvedValue(undefined); });

describe("handoff launch consumption", () => {
  it.each([false, true])("strips only the five keys immutably (inherited=%s)", (inherited) => {
    const original = pane(inherited);
    const snapshot = structuredClone(original);
    const consumed = consumePaneHandoffLaunchEnv(original, "pty");
    expect(original).toEqual(snapshot);
    expect(consumed).not.toBe(original);
    expect(consumed.tabs[0]).not.toBe(original.tabs[0]);
    expect(consumed.tabs[1]).toBe(original.tabs[1]);
    expect(consumed.tabs[0].launchEnv).toEqual({ MYCMUX_LAUNCH_TARGET: "codex", MYCMUX_MODEL: "keep-model", PATH: "keep-path" });
    expect(consumed.launchEnv).toBe(original.launchEnv);
    for (const key of HANDOFF_LAUNCH_ENV_KEYS) expect(consumed.tabs[0].launchEnv).not.toHaveProperty(key);
    expect(consumePaneHandoffLaunchEnv(consumed, "pty")).toBe(consumed);
    expect(consumePaneHandoffLaunchEnv(original, "missing")).toBe(original);
  });

  it("gives an inactive inheriting tab its own env without consuming another tab's first launch", () => {
    const original = pane(true);
    const consumed = consumePaneHandoffLaunchEnv(original, "other-pty");
    expect(consumed.tabs[1].launchEnv).toEqual({ MYCMUX_LAUNCH_TARGET: "codex", MYCMUX_MODEL: "keep-model", PATH: "keep-path" });
    expect(consumed.launchEnv).toBe(original.launchEnv);
    expect(consumed.tabs[0]).toBe(original.tabs[0]);
  });

  it("updates the workspace store and resumes the tab's own conversation on wake", () => {
    installPane(pane(true));
    const first = currentPane();
    const saved = { kind: "codex" as const, sessionId: "own-conversation" };
    const firstEnv = buildTerminalPaneLaunchEnv(first, first.tabs[0], true, saved);
    expect(firstEnv?.MYCMUX_HANDOFF).toBe("claude");
    expect(firstEnv?.MYCMUX_RESUME).toBeUndefined();
    consumeHandoffLaunchEnv("pty");
    const consumed = currentPane();
    expect(consumed).not.toBe(first);
    const resume = buildTerminalPaneLaunchEnv(consumed, consumed.tabs[0], true, saved);
    expect(resume).toMatchObject({ MYCMUX_RESUME: "codex", MYCMUX_SESSION_ID: "own-conversation", MYCMUX_AGENT_KIND: "codex", MYCMUX_PANE_SESSION_ID: "pty", MYCMUX_TAB_ID: "tab", __CMUX_LAUNCHER_DONE: "1", MYCMUX_MODEL: "keep-model" });
    expect(resume).not.toHaveProperty("MYCMUX_HANDOFF");
    expect(buildTerminalPaneLaunchEnv(consumed, undefined, false, null)).toBeUndefined();
  });

  it("consumes a background launch only once createSession has succeeded", async () => {
    installPane(pane());
    let resolve!: () => void;
    ipc.createSession.mockReturnValueOnce(new Promise<void>((done) => { resolve = done; }));
    const source = currentPane();
    const pending = startBackgroundTabSession(source.tabs[0], source);
    await vi.waitFor(() => expect(ipc.createSession).toHaveBeenCalled(), { timeout: 10000 });
    expect(currentPane().tabs[0].launchEnv?.MYCMUX_HANDOFF).toBe("claude");
    resolve();
    await pending;
    expect(currentPane().tabs[0].launchEnv).not.toHaveProperty("MYCMUX_HANDOFF");
  });

  it("keeps the handoff env and original backend text when a background start fails", async () => {
    installPane(pane());
    const backendError = 'AGENT_SESSION_ALREADY_RUNNING:{"kind":"codex","agentSessionId":"conversation","ownerSessionId":"owner"}';
    ipc.createSession.mockRejectedValueOnce(backendError);
    const source = currentPane();
    await expect(startBackgroundTabSession(source.tabs[0], source)).rejects.toBe(backendError);
    expect(currentPane()).toBe(source);
    expect(currentPane().tabs[0].launchEnv?.MYCMUX_HANDOFF).toBe("claude");
  });
});
