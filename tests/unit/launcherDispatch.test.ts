import { describe, expect, it } from "vitest";
import { requiresLauncherDispatch } from "../../src/lib/launcherDispatch";

describe("requiresLauncherDispatch", () => {
  it.each([
    [{ MYCMUX_LAUNCH_TARGET: "claude" }],
    [{ MYCMUX_RESUME: "codex", MYCMUX_SESSION_ID: "session-id" }],
    [{ MYCMUX_HANDOFF: "claude", MYCMUX_HANDOFF_FROM_SESSION: "source-id" }],
  ])("keeps agent-identified tabs on the launcher for %o", (launchEnv) => {
    expect(requiresLauncherDispatch(launchEnv)).toBe(true);
  });

  it("does not redirect ordinary direct agent tabs", () => {
    expect(requiresLauncherDispatch({ MYCMUX_AGENT_KIND: "claude" })).toBe(false);
  });
});
