import { describe, expect, it } from "vitest";

import { AGENT_TUI_KINDS, getCommandName, startsAsAgentTui } from "../../src/components/terminal/agentTuiDetection";
import type { AgentSessionKind } from "../../src/types/workspace";

// Every kind the launcher can start. Typed against AgentSessionKind so adding a
// kind to the union without teaching the wheel path about it fails to compile.
const EVERY_AGENT_KIND: readonly AgentSessionKind[] = ["claude", "codex", "claude-codex", "grok"];

describe("startsAsAgentTui", () => {
  it.each(EVERY_AGENT_KIND)("treats a %s pane as an agent TUI on every launch signal", (kind) => {
    expect(startsAsAgentTui("pwsh", [], undefined, kind)).toBe(true);
    expect(startsAsAgentTui("pwsh", [], kind)).toBe(true);
    expect(startsAsAgentTui("pwsh", [], undefined, undefined, { MYCMUX_AGENT_KIND: kind })).toBe(true);
    expect(startsAsAgentTui("pwsh", [], undefined, undefined, { MYCMUX_RESUME: kind })).toBe(true);
  });

  it("covers every launcher kind so a new one cannot be added to only half the app", () => {
    expect([...AGENT_TUI_KINDS].sort()).toEqual([...EVERY_AGENT_KIND].sort());
  });

  it("recognises the agent binaries by command and by argument", () => {
    expect(startsAsAgentTui("C:\\bin\\grok.exe", [])).toBe(true);
    expect(startsAsAgentTui("pwsh", ["-NoLogo", "-Command", "grok"])).toBe(true);
    expect(startsAsAgentTui("/usr/bin/codex", [])).toBe(true);
    expect(startsAsAgentTui("pwsh", ["-Command", "claude"])).toBe(true);
  });

  it("leaves a plain shell alone", () => {
    expect(startsAsAgentTui("pwsh", ["-NoLogo"])).toBe(false);
    expect(startsAsAgentTui("bash", [], "shell", "shell")).toBe(false);
    expect(startsAsAgentTui("pwsh", [], undefined, undefined, { MYCMUX_AGENT_KIND: "" })).toBe(false);
  });

  it("does not match claude-codex as a binary name: it is a launcher target only", () => {
    expect(startsAsAgentTui("claude-codex", [])).toBe(false);
    expect(startsAsAgentTui("pwsh", [], undefined, "claude-codex")).toBe(true);
  });
});

describe("getCommandName", () => {
  it("strips the directory and the windows executable suffix", () => {
    expect(getCommandName("C:\\Program Files\\Grok\\Grok.EXE")).toBe("grok");
    expect(getCommandName("/usr/local/bin/codex")).toBe("codex");
    expect(getCommandName("claude.cmd")).toBe("claude");
    expect(getCommandName("")).toBe("");
  });
});
