import { describe, expect, it } from "vitest";
import {
  buildDuplicateSessionPaneOptions,
  buildForkDuplicateSessionPaneOptions,
  resolveDuplicateSessionSource,
} from "../../src/lib/duplicateSession";

describe("resolveDuplicateSessionSource", () => {
  it("returns null when live agent metadata is missing or incomplete", () => {
    const input = {
      tabCwd: "C:\\source",
      paneCwd: "C:\\pane",
      label: "Source task",
    };

    expect(resolveDuplicateSessionSource({ ...input, metadata: undefined })).toBeNull();
    expect(resolveDuplicateSessionSource({
      ...input,
      metadata: { agentKind: "codex" },
    })).toBeNull();
    expect(resolveDuplicateSessionSource({
      ...input,
      metadata: { agentSessionId: "source-session" },
    })).toBeNull();
  });

  it("prefers the tab working directory over the pane fallback", () => {
    expect(resolveDuplicateSessionSource({
      metadata: {
        agentKind: "claude",
        agentSessionId: "source-session",
      },
      tabCwd: "C:\\tab",
      paneCwd: "C:\\pane",
      label: "Source task",
    })?.cwd).toBe("C:\\tab");
  });
});

describe("buildDuplicateSessionPaneOptions", () => {
  it.each(["claude", "claude-codex"] as const)(
    "builds a four-key fork environment for %s without pinning the source session id",
    (agentKind) => {
      const source = resolveDuplicateSessionSource({
        metadata: {
          agentKind,
          agentSessionId: "source-session",
        },
        paneCwd: "C:\\pane",
        label: "Source task",
      });
      expect(source).not.toBeNull();

      const paneOptions = buildForkDuplicateSessionPaneOptions(source!);

      expect(paneOptions).toEqual({
        agentId: "shell-starter",
        label: "Source task",
        cwd: "C:\\pane",
        agentKind,
        launchEnv: {
          MYCMUX_AGENT_KIND: agentKind,
          MYCMUX_RESUME: agentKind,
          MYCMUX_SESSION_ID: "source-session",
          MYCMUX_RESUME_FORK: "1",
        },
      });
      expect(Object.keys(paneOptions.launchEnv)).toHaveLength(4);
      expect(paneOptions).not.toHaveProperty("agentSessionId");
    },
  );

  it("builds a five-key handoff environment without a resume session id", () => {
    const source = resolveDuplicateSessionSource({
      metadata: {
        agentKind: "codex",
        agentSessionId: "source-session",
      },
      paneCwd: "C:\\pane",
      label: "Source task",
    });
    expect(source).not.toBeNull();

    const paneOptions = buildDuplicateSessionPaneOptions(
      source!,
      "C:\\handoffs\\duplicate.md",
    );

    expect(paneOptions).toEqual({
      agentId: "shell-starter",
      label: "Source task",
      cwd: "C:\\pane",
      agentKind: "codex",
      launchEnv: {
        MYCMUX_AGENT_KIND: "codex",
        MYCMUX_HANDOFF: "codex",
        MYCMUX_HANDOFF_FROM: "codex",
        MYCMUX_HANDOFF_PROMPT_FILE: "C:\\handoffs\\duplicate.md",
        MYCMUX_HANDOFF_FROM_SESSION: "source-session",
      },
    });
    expect(Object.keys(paneOptions.launchEnv)).toHaveLength(5);
    expect(paneOptions).not.toHaveProperty("agentSessionId");
  });
});
