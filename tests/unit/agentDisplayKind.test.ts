import { describe, expect, it } from "vitest";
import {
  COMMAND_DISPLAY_KINDS,
  LAUNCH_TARGET_DISPLAY_KINDS,
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

  it("maps Hermes launched by its full path", () => {
    // The launchers start Hermes as %LOCALAPPDATA%/hermes/bin/hermes.exe and set
    // no agent kind, so the basename is the only thing that identifies the pane.
    for (const command of ["hermes", "hermes.exe", "C:\\Users\\me\\AppData\\Local\\hermes\\bin\\hermes.exe"]) {
      expect(resolveDisplayAgentKind(undefined, [command])).toBe("hermes");
    }
  });

  it("falls back to the launch target for rows the catalog gives no session kind", () => {
    // agy and Hermes are started through the launcher shell, so the PTY command
    // is powershell/bash and MYCMUX_LAUNCH_TARGET is the only identification left.
    expect(resolveDisplayAgentKind(undefined, ["powershell.exe"], "hermes")).toBe("hermes");
    expect(resolveDisplayAgentKind(undefined, ["bash"], "agy")).toBe("antigravity");
    expect(resolveDisplayAgentKind(undefined, ["bash"], "shell")).toBeNull();
    expect(resolveDisplayAgentKind(undefined, null, undefined)).toBeNull();
  });

  it("prefers the command over the launch target", () => {
    expect(resolveDisplayAgentKind(undefined, ["codex.exe"], "hermes")).toBe("codex");
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

describe("LAUNCH_TARGET_DISPLAY_KINDS", () => {
  it("declares the launcher targets that carry no session kind", () => {
    expect(LAUNCH_TARGET_DISPLAY_KINDS).toEqual({ agy: "antigravity", hermes: "hermes" });
  });
});

describe("COMMAND_DISPLAY_KINDS", () => {
  it("declares the display-only command mapping", () => {
    expect(COMMAND_DISPLAY_KINDS).toEqual({ agy: "antigravity", claude: "claude", codex: "codex", grok: "grok", hermes: "hermes" });
  });
});
