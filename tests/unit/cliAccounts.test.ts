import { describe, expect, it, vi } from "vitest";
import {
  addAccountLabel,
  attentionReason,
  canSwitchCliAccount,
  cliAccountProfileActivity,
  cliAccountMessage,
  executeCliAccountSwitch,
  loginIdentityMismatchMessage,
  loginRemainingLabel,
  loginTabLabel,
  orderCliAccountProfiles,
  runningAgentPaneDetails,
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
  it("warns about undetectable external CLIs even when nothing is running", () => {
    const text = switchWarningText(0, "claude", "仕事用");
    expect(text).toContain("仕事用");
    expect(text).toContain("mycmux の外で動いている CLI は検知できません");
  });

  it("mentions the provider and count", () => {
    const text = switchWarningText(2, "codex", "仕事用", ["Codex / C:\\work / セッション abc123"]);
    expect(text).toContain("Codex");
    expect(text).toContain("2 件");
    expect(text).toContain("新しく起動するセッションから反映");
    expect(text).toContain("C:\\work");
  });
});

describe("runningAgentPaneDetails", () => {
  it("lists only matching live panes with process, cwd, and session id", () => {
    const details = runningAgentPaneDetails({
      "claude-session-1": { agentKind: "claude", processIsShell: false, processTitle: "claude", cwd: "C:\\work" },
      "codex-session-1": { agentKind: "codex", processIsShell: false, cwd: "C:\\other" },
      shell: { agentKind: "claude", processIsShell: true, cwd: "C:\\ignored" },
    }, "claude");
    expect(details).toEqual(["claude / C:\\work / セッション claude-s"]);
  });
});

describe("account UX helpers", () => {
  it("never permits switching the active account", () => {
    expect(canSwitchCliAccount(true, false, false)).toBe(false);
    expect(canSwitchCliAccount(false, false, false)).toBe(true);
    expect(canSwitchCliAccount(false, true, false)).toBe(false);
    expect(canSwitchCliAccount(false, false, true)).toBe(false);
  });

  it("does not confirm or invoke the switch action for the active account", async () => {
    const confirmSwitch = vi.fn(async () => true);
    const switchAccount = vi.fn(async () => ({ switched: true }));

    await expect(
      executeCliAccountSwitch(true, false, false, confirmSwitch, switchAccount),
    ).resolves.toBeNull();
    expect(confirmSwitch).not.toHaveBeenCalled();
    expect(switchAccount).not.toHaveBeenCalled();
  });

  it("treats stale active evidence as possible, not current, after fetch failure", () => {
    expect(
      cliAccountProfileActivity(
        "claude-abc12345",
        "claude-abc12345",
        liveLogin({ matched_profile_id: "claude-abc12345" }),
        "原因: 取得失敗。次にすること: 再試行してください。",
      ),
    ).toEqual({ active: false, possiblyActive: true });
    expect(
      cliAccountProfileActivity(
        "claude-abc12345",
        "claude-abc12345",
        liveLogin({ matched_profile_id: "claude-abc12345" }),
        null,
      ),
    ).toEqual({ active: true, possiblyActive: false });
  });

  it("uses the intended pointer only as possible-active evidence when live state is unknown", () => {
    expect(
      cliAccountProfileActivity("claude-abc12345", "claude-abc12345", undefined, null),
    ).toEqual({ active: false, possiblyActive: true });
    expect(
      cliAccountProfileActivity(
        "claude-abc12345",
        "claude-abc12345",
        liveLogin({ error: "unreadable", matched_profile_id: null }),
        null,
      ),
    ).toEqual({ active: false, possiblyActive: true });
    expect(
      cliAccountProfileActivity("claude-other", "claude-abc12345", undefined, null),
    ).toEqual({ active: false, possiblyActive: false });
  });
  it("describes attention reasons", () => {
    expect(attentionReason([liveLogin({ error: "x" })], [])).toContain("読み取れない");
    expect(attentionReason([], [profile({ needs_relogin: true })])).toContain("再ログイン");
    expect(attentionReason([], [], "fetch failed")).toContain("読み取れない");
    expect(attentionReason([liveLogin()], [profile()])).toBeNull();
  });

  it("orders profiles by last switch without mutating the input", () => {
    const input = [
      profile({ id: "never", label: "未使用", last_switched_at: null }),
      profile({ id: "old", label: "旧", last_switched_at: "2026-08-01T00:00:00Z" }),
      profile({ id: "new", label: "新", last_switched_at: "2026-08-07T00:00:00Z" }),
    ];
    expect(orderCliAccountProfiles(input).map((item) => item.id)).toEqual(["new", "old", "never"]);
    expect(input.map((item) => item.id)).toEqual(["never", "old", "new"]);
  });

  it("keeps the original order for equal, missing, and invalid switch times", () => {
    const input = [
      profile({ id: "null-a", last_switched_at: null }),
      profile({ id: "invalid", last_switched_at: "not-a-date" }),
      profile({ id: "null-b", last_switched_at: null }),
    ];
    expect(orderCliAccountProfiles(input).map((item) => item.id)).toEqual(["null-a", "invalid", "null-b"]);
  });

  it("resolves coded messages and hides unknown backend text", () => {
    expect(cliAccountMessage("cli_account.error.needs_relogin")).toContain("再ログイン");
    expect(cliAccountMessage(new Error("raw backend details"))).not.toContain("raw backend details");
    expect(cliAccountMessage("unknown")).toMatch(/^原因:.*次にすること:/);
  });
});

describe("isolated CLI login", () => {
  const LOGIN_CODES = [
    "cli_account.error.login_staging_failed",
    "cli_account.error.login_identity_mismatch",
    "cli_account.error.login_timeout",
    "cli_account.error.login_cancelled",
    "cli_account.error.login_already_running",
    "cli_account.error.login_session_not_found",
  ] as const;

  it.each(LOGIN_CODES)("explains %s instead of falling back to the generic text", (code) => {
    const message = cliAccountMessage(code);
    expect(message).not.toBe(cliAccountMessage("cli_account.error.__not_a_real_code__"));
    expect(message).toMatch(/^原因:.*次にすること:/);
  });

  it("names the account that logged in when the identity does not match", () => {
    expect(loginIdentityMismatchMessage("other@example.com")).toContain("other@example.com");
    expect(loginIdentityMismatchMessage(null)).toBe(
      cliAccountMessage("cli_account.error.login_identity_mismatch"),
    );
  });

  it("labels the entry points and the login tab per provider and mode", () => {
    expect(addAccountLabel("claude")).toBe("Claude Code のアカウントを追加");
    expect(addAccountLabel("codex")).toBe("Codex のアカウントを追加");
    expect(loginTabLabel("claude", "new")).toBe("Claude Code ログイン");
    expect(loginTabLabel("codex", "reauth")).toBe("Codex 再ログイン");
  });

  it("counts the countdown down from the backend timeout and stops at zero", () => {
    const startedAt = 1_000_000;
    expect(loginRemainingLabel(startedAt, startedAt)).toBe("10:00");
    expect(loginRemainingLabel(startedAt, startedAt + 61_000)).toBe("8:59");
    expect(loginRemainingLabel(startedAt, startedAt + 600_000)).toBe("0:00");
    expect(loginRemainingLabel(startedAt, startedAt + 999_000)).toBe("0:00");
    expect(loginRemainingLabel(null, startedAt)).toBe("10:00");
  });
});
