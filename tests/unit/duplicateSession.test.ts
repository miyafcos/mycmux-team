import { describe, expect, it } from "vitest";
import {
  buildClonedDuplicateSessionPaneOptions,
  buildDuplicateSessionPaneOptions,
  resolveDuplicateSessionSource,
} from "../../src/lib/duplicateSession";
import { agentIdForSessionKind } from "../../src/lib/agentSessionConfig";

describe("agentIdForSessionKind", () => {
  it.each([
    ["claude", "claude-code"],
    ["codex", "codex"],
    ["claude-codex", "shell-starter"],
  ] as const)("maps %s to %s", (kind, agentId) => {
    expect(agentIdForSessionKind(kind)).toBe(agentId);
  });
});

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

  it("prefers the live metadata working directory over tab and pane fallbacks", () => {
    expect(resolveDuplicateSessionSource({
      metadata: {
        agentKind: "claude",
        agentSessionId: "source-session",
      },
      metadataCwd: "C:\\live",
      tabCwd: "C:\\tab",
      paneCwd: "C:\\pane",
      label: "Source task",
    })?.cwd).toBe("C:\\live");
  });
});

describe("buildClonedDuplicateSessionPaneOptions", () => {
  const source = resolveDuplicateSessionSource({
    metadata: {
      agentKind: "claude",
      agentSessionId: "source-session",
    },
    paneCwd: "C:\\pane",
    label: "Source task",
  });

  it("builds saved-session options without launch environment variables", () => {
    expect(source).not.toBeNull();
    const paneOptions = buildClonedDuplicateSessionPaneOptions(source!, {
      agent_kind: "claude",
      source_session_id: "source-session",
      new_session_id: "cloned-session",
      resolved_cwd: "C:\\cloned",
    });

    expect(paneOptions).toEqual({
      agentId: "claude-code",
      label: "Source task",
      cwd: "C:\\cloned",
      agentKind: "claude",
      agentSessionId: "cloned-session",
    });
    expect(paneOptions).not.toHaveProperty("launchEnv");
    expect(JSON.stringify(paneOptions)).not.toContain("MYCMUX_RESUME_FORK");
  });

  it.each([
    ["claude", "claude-code"],
    ["codex", "codex"],
    ["claude-codex", "shell-starter"],
  ] as const)("uses the saved-session agent mapping for %s", (agentKind, agentId) => {
    expect(source).not.toBeNull();
    expect(buildClonedDuplicateSessionPaneOptions(source!, {
      agent_kind: agentKind,
      source_session_id: "source-session",
      new_session_id: "cloned-session",
      resolved_cwd: "C:\\cloned",
    }).agentId).toBe(agentId);
  });

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
