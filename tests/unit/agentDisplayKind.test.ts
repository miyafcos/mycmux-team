import { describe, expect, it } from "vitest";
import {
  COMMAND_DISPLAY_KINDS,
  resolveDisplayAgentKind,
} from "../../src/lib/agentDisplayKind";

describe("resolveDisplayAgentKind", () => {
  it("maps agy commands to the Antigravity display kind", () => {
    for (const command of ["agy", "agy.exe", "C:\\tools\\agy.exe", "/usr/local/bin/agy"]) {
      expect(resolveDisplayAgentKind(undefined, [command])).toBe("antigravity");
    }
  });

  it("maps direct Claude, Codex, and Grok commands before backend metadata arrives", () => {
    for (const [command, expected] of [["claude.exe", "claude"], ["C:\\tools\\codex.exe", "codex"], ["grok.exe", "grok"]] as const) {
      expect(resolveDisplayAgentKind(undefined, [command])).toBe(expected);
    }
  });

  it("does not infer through an environment wrapper", () => {
    expect(resolveDisplayAgentKind(undefined, ["env", "agy"])).toBeNull();
  });

  it("prefers persisted agent kinds", () => {
    for (const kind of ["claude", "codex", "claude-codex", "grok"] as const) {
      expect(resolveDisplayAgentKind(kind, ["agy"])).toBe(kind);
    }
  });

  it("returns null when neither source is recognized", () => {
    expect(resolveDisplayAgentKind(null)).toBeNull();
    expect(resolveDisplayAgentKind(undefined, null)).toBeNull();
    expect(resolveDisplayAgentKind("shell", [])).toBeNull();
    expect(resolveDisplayAgentKind("shell", ["node"])).toBeNull();
  });
});

describe("COMMAND_DISPLAY_KINDS", () => {
  it("declares the display-only command mapping", () => {
    expect(COMMAND_DISPLAY_KINDS).toEqual({ agy: "antigravity", claude: "claude", codex: "codex", grok: "grok" });
  });
});
