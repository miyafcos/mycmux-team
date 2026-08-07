import { describe, expect, it } from "vitest";
import {
  badgeLabel,
  hasAttention,
  runningAgentCounts,
  switchWarningText,
} from "../../src/lib/cliAccounts";
import type { CliAccountProfile, CliLiveLogin } from "../../src/lib/ipc";

function profile(overrides: Partial<CliAccountProfile> = {}): CliAccountProfile {
  return {
    id: "claude-abc12345",
    provider: "claude",
    label: "work",
    email: "someone@example.com",
    identity_key: "uuid-1",
    plan: "max",
    org_name: null,
    captured_at: "2026-08-07T00:00:00Z",
    last_switched_at: null,
    needs_relogin: false,
    ...overrides,
  };
}

function liveLogin(overrides: Partial<CliLiveLogin> = {}): CliLiveLogin {
  return {
    provider: "claude",
    present: true,
    email: "someone@example.com",
    identity_key: "uuid-1",
    plan: "max",
    org_name: null,
    matched_profile_id: null,
    error: null,
    ...overrides,
  };
}

describe("badgeLabel", () => {
  it("shows 未ログイン when live info is absent or not present", () => {
    expect(badgeLabel(undefined, [])).toBe("未ログイン");
    expect(badgeLabel(liveLogin({ present: false, email: null, identity_key: null }), [])).toBe(
      "未ログイン",
    );
  });

  it("shows ? on read errors", () => {
    expect(badgeLabel(liveLogin({ error: "boom" }), [])).toBe("?");
  });

  it("prefers the registered label when matched", () => {
    const p = profile({ id: "claude-x", label: "仕事用" });
    expect(badgeLabel(liveLogin({ matched_profile_id: "claude-x" }), [p])).toBe("仕事用");
  });

  it("falls back to the email localpart, then 未登録", () => {
    expect(badgeLabel(liveLogin({ email: "abc@example.com" }), [])).toBe("abc");
    expect(badgeLabel(liveLogin({ email: null }), [])).toBe("未登録");
  });
});

describe("hasAttention", () => {
  it("flags live read errors and needs_relogin profiles", () => {
    expect(hasAttention([liveLogin({ error: "x" })], [])).toBe(true);
    expect(hasAttention([], [profile({ needs_relogin: true })])).toBe(true);
    expect(hasAttention([liveLogin()], [profile()])).toBe(false);
  });
});

describe("runningAgentCounts", () => {
  it("counts only panes whose foreground process is not a shell", () => {
    const counts = runningAgentCounts({
      a: { agentKind: "claude", processIsShell: false },
      b: { agentKind: "claude", processIsShell: true },
      c: { agentKind: "codex", processIsShell: false },
      d: { agentKind: "claude-codex", processIsShell: false },
      e: { processIsShell: false },
      f: { agentKind: "codex" },
    });
    expect(counts).toEqual({ claude: 2, codex: 2 });
  });
});

describe("switchWarningText", () => {
  it("returns null when nothing is running", () => {
    expect(switchWarningText(0, "claude")).toBeNull();
  });

  it("mentions the provider and count", () => {
    const text = switchWarningText(2, "codex");
    expect(text).toContain("Codex");
    expect(text).toContain("2 件");
  });
});
