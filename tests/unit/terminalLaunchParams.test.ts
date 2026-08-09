import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildLaunchRequest,
  type TerminalLaunchParams,
} from "../../src/components/terminal/terminalLaunchParams";

const xtermWrapperSource = readFileSync(
  new URL("../../src/components/terminal/XTermWrapper.tsx", import.meta.url),
  "utf8",
);

function freshTabParams(): TerminalLaunchParams {
  return {
    command: "claude",
    args: ["--dangerously-skip-permissions", "--session-id", "new-session"],
    cwd: "C:/repo",
    launchEnv: { MYCMUX_PANE_SESSION_ID: "pane-1", MYCMUX_AGENT_KIND: "claude" },
    restoreFallbackSessionIds: [],
  };
}

function resumedTabParams(): TerminalLaunchParams {
  return {
    command: "claude",
    args: ["--dangerously-skip-permissions", "--resume", "saved-session"],
    cwd: "C:/repo/worktree",
    launchEnv: {
      MYCMUX_PANE_SESSION_ID: "pane-1",
      MYCMUX_AGENT_KIND: "claude",
      MYCMUX_SESSION_ID: "saved-session",
      MYCMUX_RESUME: "claude",
    },
    restoreFallbackSessionIds: ["older-session"],
  };
}

describe("buildLaunchRequest", () => {
  it("maps launch parameters onto the createSession argument shape", () => {
    expect(buildLaunchRequest(resumedTabParams())).toEqual({
      command: "claude",
      args: ["--dangerously-skip-permissions", "--resume", "saved-session"],
      cwd: "C:/repo/worktree",
      env: {
        MYCMUX_PANE_SESSION_ID: "pane-1",
        MYCMUX_AGENT_KIND: "claude",
        MYCMUX_SESSION_ID: "saved-session",
        MYCMUX_RESUME: "claude",
      },
      restoreFallbackSessionIds: ["older-session"],
    });
  });

  it("keeps the historical undefined-vs-empty env distinction", () => {
    expect(buildLaunchRequest({ command: "bash", args: [] }).env).toBeUndefined();
    expect(buildLaunchRequest({ command: "bash", args: [], launchEnv: {} }).env).toEqual({});
  });
});

describe("latest-value launch params ref (B-1 stale closure)", () => {
  // Models the XTermWrapper wiring: a long-lived effect closure created at mount
  // that attaches the PTY asynchronously, while the saved agent session for the
  // tab resolves after mount and rewrites args/env.
  it("spawns with the resume parameters that landed after the effect was created", async () => {
    const ref: { current: TerminalLaunchParams } = { current: freshTabParams() };
    const spawned: ReturnType<typeof buildLaunchRequest>[] = [];

    // Created once, at "mount" — this is the closure that used to freeze props.
    const attachFrontendChannel = async (): Promise<void> => {
      const launch = buildLaunchRequest(ref.current);
      spawned.push(launch);
    };

    // Render commit after the agent-session mapping resolved.
    ref.current = resumedTabParams();

    await attachFrontendChannel();

    expect(spawned).toHaveLength(1);
    expect(spawned[0].args).toContain("--resume");
    expect(spawned[0].env?.MYCMUX_RESUME).toBe("claude");
    expect(spawned[0].env?.MYCMUX_SESSION_ID).toBe("saved-session");
    expect(spawned[0].cwd).toBe("C:/repo/worktree");
    expect(spawned[0].restoreFallbackSessionIds).toEqual(["older-session"]);
  });
});

describe("XTermWrapper launch-parameter wiring", () => {
  it("keeps the terminal effect keyed on sessionId only", () => {
    // Adding launch params to the dependency array would dispose and respawn
    // every terminal whenever agent metadata changes.
    expect(xtermWrapperSource).toContain("  }, [sessionId]);");
  });

  it("refreshes the launch params ref on every render", () => {
    expect(xtermWrapperSource).toContain(
      "launchParamsRef.current = { command, args, cwd, launchEnv, restoreFallbackSessionIds };",
    );
  });

  it("attaches the PTY from the ref instead of the effect closure", () => {
    const attachStart = xtermWrapperSource.indexOf("const attachFrontendChannel = async (");
    const attachEnd = xtermWrapperSource.indexOf("const registerScanListener", attachStart);
    const attachBlock = xtermWrapperSource.slice(attachStart, attachEnd);

    expect(attachStart).toBeGreaterThan(-1);
    expect(attachEnd).toBeGreaterThan(attachStart);
    expect(attachBlock).toContain("buildLaunchRequest(launchParamsRef.current)");
    expect(attachBlock).toContain("launch.command,");
    expect(attachBlock).toContain("launch.args,");
    expect(attachBlock).toContain("launch.cwd,");
    expect(attachBlock).toContain("launch.env,");
    expect(attachBlock).toContain("launch.restoreFallbackSessionIds,");
    // No raw prop reads left in the spawn path.
    expect(attachBlock).not.toContain("launchEnv || undefined");
  });

  it("reads deferred command and cwd from the ref too", () => {
    expect(xtermWrapperSource).toContain(
      "getShiftEnterSequence(launchParamsRef.current.command, processTitle)",
    );
    expect(xtermWrapperSource).toContain(
      "usePaneMetadataStore.getState().metadata[sessionId]?.cwd ?? launchParamsRef.current.cwd",
    );
  });
});
