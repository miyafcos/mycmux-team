import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_SESSION_ALREADY_RUNNING_NOTICE,
  AGENT_SESSION_ALREADY_RUNNING_PREFIX,
  agentSessionAlreadyRunningNotice,
  findAgentSessionOwner,
  parseAgentSessionAlreadyRunning,
} from "../../src/lib/agentResumeConflict";
import { reportAgentSessionAlreadyRunning } from "../../src/components/terminal/XTermWrapper";
import { focusController } from "../../src/lib/focusController";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useUiStore } from "../../src/stores/uiStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { __resetToastStoreForTests, useToastStore } from "../../src/stores/toastStore";
import type { Workspace } from "../../src/types";

const payload = { kind: "codex", agentSessionId: "conversation", ownerSessionId: "owner-session" };
const error = AGENT_SESSION_ALREADY_RUNNING_PREFIX + JSON.stringify(payload);

function workspaces(): Workspace[] {
  return ["first", "owner"].map((id) => ({
    id,
    name: id === "owner" ? "Workspace" : "First",
    gridTemplateId: "1x1",
    status: "running",
    createdAt: 1,
    panes: [{
      id: `${id}-pane`,
      agentId: "codex",
      sessionId: `${id}-active-session`,
      activeTabId: `${id}-active-tab`,
      tabs: [
        { id: `${id}-active-tab`, sessionId: `${id}-active-session`, agentId: "codex", type: "terminal" },
        { id: `${id}-tab`, sessionId: `${id}-session`, agentId: "codex", type: "terminal", displayName: "Task" },
      ],
    }],
  }));
}

beforeEach(() => {
  __resetToastStoreForTests();
  useWorkspaceListStore.setState({ workspaces: workspaces(), activeWorkspaceId: "first" });
  useUiStore.setState({ activePaneId: "first-active-session", zoomedPaneId: null });
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} });
});

afterEach(() => {
  __resetToastStoreForTests();
  vi.restoreAllMocks();
});

describe("agent resume conflict", () => {
  it("parses backend strings and Error messages without changing ids", () => {
    expect(parseAgentSessionAlreadyRunning(error)).toEqual(payload);
    expect(parseAgentSessionAlreadyRunning(new Error(error))).toEqual(payload);
  });

  it.each([
    null, undefined, 1, {}, "pty failure", "Error: " + error,
    AGENT_SESSION_ALREADY_RUNNING_PREFIX + "broken",
    AGENT_SESSION_ALREADY_RUNNING_PREFIX + "null",
    AGENT_SESSION_ALREADY_RUNNING_PREFIX + "[]",
    ...[
      { ...payload, kind: "shell" },
      { ...payload, agentSessionId: " " },
      { ...payload, ownerSessionId: 1 },
      { kind: "codex", agentSessionId: "conversation" },
    ].map((invalid) => AGENT_SESSION_ALREADY_RUNNING_PREFIX + JSON.stringify(invalid)),
  ])("rejects malformed or unrelated errors: %s", (value) => {
    expect(parseAgentSessionAlreadyRunning(value)).toBeNull();
  });

  it("exports the exact terminal notice and adds hidden-owner detail inside brackets", () => {
    expect(AGENT_SESSION_ALREADY_RUNNING_NOTICE).toBe("\r\n\x1b[33m[\u3053\u306e\u4f1a\u8a71\u306f\u5225\u306e\u30da\u30a4\u30f3\u3067\u52d5\u3044\u3066\u3044\u308b\u305f\u3081\u3001\u3053\u3053\u3067\u306f\u8d77\u52d5\u3057\u307e\u305b\u3093\u3067\u3057\u305f]\x1b[0m\r\n");
    expect(agentSessionAlreadyRunningNotice()).toBe(AGENT_SESSION_ALREADY_RUNNING_NOTICE);
    expect(agentSessionAlreadyRunningNotice("123456789-more")).toBe(AGENT_SESSION_ALREADY_RUNNING_NOTICE.replace("]\x1b[0m", " (\u753b\u9762\u306b\u7121\u3044\u30bb\u30c3\u30b7\u30e7\u30f3 12345678 \u3067\u52d5\u3044\u3066\u3044\u307e\u3059)]\x1b[0m"));
  });

  it("looks through every workspace and background tab using the PTY id", () => {
    const sources = workspaces();
    expect(findAgentSessionOwner(sources, "owner-session")).toEqual({
      workspace: sources[1], pane: sources[1].panes[0], tab: sources[1].panes[0].tabs[1],
    });
    expect(findAgentSessionOwner(sources, "owner-tab")).toBeNull();
    expect(findAgentSessionOwner(sources, "conversation")).toBeNull();
    expect(findAgentSessionOwner([], "owner-session")).toBeNull();
  });

  it("shows one warning action that activates the existing owner pane", () => {
    const write = vi.fn();
    const focus = vi.spyOn(focusController, "request").mockImplementation(() => {});
    expect(reportAgentSessionAlreadyRunning(error, write)).toBe(true);
    expect(write).toHaveBeenCalledExactlyOnceWith(AGENT_SESSION_ALREADY_RUNNING_NOTICE);
    const [toast] = useToastStore.getState().toasts;
    expect(toast.kind).toBe("warning");
    expect(toast.message).toBe("\u3053\u306e\u4f1a\u8a71\u306f\u300cWorkspace / Task\u300d\u3067\u52d5\u3044\u3066\u3044\u307e\u3059");
    expect(toast.action?.label).toBe("\u305d\u306e\u30da\u30a4\u30f3\u3092\u958b\u304f");
    expect(toast.actions).toBeUndefined();
    toast.action!.run();
    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe("owner");
    expect(useWorkspaceListStore.getState().workspaces[1].panes[0].activeTabId).toBe("owner-tab");
    expect(focus).toHaveBeenLastCalledWith("programmatic", { sessionId: "owner-session", focus: true });
  });

  it("writes hidden-owner detail without a toast and leaves ordinary failures to the caller", () => {
    const write = vi.fn();
    const hidden = AGENT_SESSION_ALREADY_RUNNING_PREFIX + JSON.stringify({ ...payload, ownerSessionId: "missing-session" });
    expect(reportAgentSessionAlreadyRunning(hidden, write)).toBe(true);
    expect(write).toHaveBeenCalledExactlyOnceWith(agentSessionAlreadyRunningNotice("missing-session"));
    expect(useToastStore.getState().toasts).toEqual([]);
    expect(reportAgentSessionAlreadyRunning("ordinary error", write)).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
  });
});
