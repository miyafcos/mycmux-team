import { describe, expect, it } from "vitest";
import { parseAgentRestoreChoice } from "../../src/lib/agentRestoreChoice";
import { buildAgentRecoveryLaunch } from "../../src/components/terminal/terminalLaunchParams";

const a = "11111111-1111-4111-8111-111111111111";
const b = "22222222-2222-4222-8222-222222222222";
describe("SI saved conversation choices", () => {
  it("parses the optional choice without changing duplicate response parsing", () => {
    expect(parseAgentRestoreChoice(`AGENT_RESTORE_CHOICE_REQUIRED:${JSON.stringify({ kind: "claude", agentSessionId: a, candidates: [b,b] })}`))
      .toEqual({ kind: "claude", agentSessionId: a, candidates: [b] });
    expect(parseAgentRestoreChoice(`AGENT_SESSION_ALREADY_RUNNING:{}`)).toBeNull();
    expect(parseAgentRestoreChoice(`AGENT_RESTORE_CHOICE_REQUIRED:{"kind":"claude","agentSessionId":"a","candidates":["../"]}`)).toBeNull();
  });
  it("selects the original id and preserves provider model/effort arguments", () => {
    const result = buildAgentRecoveryLaunch({ command: "C:\\fake\\claude.exe", args: ["fake.cjs", "--resume", a, "--model", "model", "--effort", "high"], launchEnv: { MYCMUX_TAB_ID: a } }, "claude", b, false);
    expect(result.args).toEqual(["fake.cjs", "--model", "model", "--effort", "high", "--resume", b]);
    expect(result.launchEnv).toMatchObject({ MYCMUX_SESSION_ID: b, MYCMUX_RESUME: "claude", MYCMUX_TAB_ID: a });
  });
  it("fresh starts with a new id rather than continuing the same tab's old conversation", () => {
    const result = buildAgentRecoveryLaunch({ command: "claude", args: ["--session-id", a], launchEnv: { MYCMUX_RESUME: "claude", MYCMUX_SESSION_ID: a } }, "claude", b, true);
    expect(result.args).toEqual(["--session-id", b]);
    expect(result.launchEnv).toMatchObject({ MYCMUX_SESSION_ID: b, MYCMUX_RESUME: "claude" });
  });
  it("launches shell wrappers through the existing launcher", () => {
    const result = buildAgentRecoveryLaunch({ command: "powershell.exe", args: ["-NoProfile", "-File", "launcher.ps1"] }, "claude-codex", b, true);
    expect(result.args).toEqual(["-NoProfile", "-File", "launcher.ps1"]);
    expect(result.launchEnv).toMatchObject({ MYCMUX_LAUNCH_TARGET: "claude-codex", MYCMUX_SESSION_ID: b, MYCMUX_RESUME: "claude-codex" });
  });
});
