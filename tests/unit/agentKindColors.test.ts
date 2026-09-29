import { describe, expect, it } from "vitest";
import { agentKindColor, distinctAgentKinds } from "../../src/lib/agentKindColors";

describe("agentKindColor", () => {
  it("returns the shared Claude palette", () => {
    expect(agentKindColor("claude")).toEqual({
      fg: "#f0a878",
      bg: "rgba(255, 138, 61, 0.10)",
    });
  });

  it("returns the shared Codex palette", () => {
    expect(agentKindColor("codex")).toEqual({
      fg: "#8ab8e8",
      bg: "rgba(94, 158, 255, 0.10)",
    });
  });

  it("returns the shared Hybrid palette", () => {
    expect(agentKindColor("claude-codex")).toEqual({
      fg: "#7dcc97",
      bg: "rgba(74, 222, 128, 0.10)",
    });
  });

  it("returns undefined for unknown or missing kinds", () => {
    expect(agentKindColor("shell")).toBeUndefined();
    expect(agentKindColor(undefined)).toBeUndefined();
  });
});

describe("distinctAgentKinds", () => {
  it("deduplicates known kinds in the fixed display order", () => {
    expect(distinctAgentKinds([
      "claude-codex",
      "codex",
      "claude",
      "codex",
      "shell",
      undefined,
    ])).toEqual(["claude", "codex", "claude-codex"]);
  });

  it("returns an empty list when no known kinds are present", () => {
    expect(distinctAgentKinds(["shell", undefined])).toEqual([]);
  });
});
