import { describe, expect, it } from "vitest";
import { cliAccountLaunchErrorMessage, cliAccountMessage, cliAccountSessionErrorMessage, pinnedAgentCounts, runningAgentCounts, runningAgentPaneDetails, switchWarningText } from "../../src/lib/cliAccounts";
import { savepointPublishErrorMessage } from "../../src/components/online/onlineSavepoints";
import { onlineStrings } from "../../src/components/online/onlineStrings";

describe("W-1 account-switch warnings", () => {
  const metadata = {
    ccDefault: { agentKind: "claude" as const, processIsShell: false, processTitle: "CC default" },
    ccPinned: { agentKind: "claude" as const, processIsShell: false, processTitle: "CC pinned" },
    ccMeta: { agentKind: "claude" as const, processIsShell: false, processTitle: "CC metadata only" },
    ccUnknown: { agentKind: "claude" as const, processIsShell: false, processTitle: "CC unknown ownership" },
    ccMismatch: { agentKind: "claude" as const, processIsShell: false, processTitle: "CC conflicting ownership" },
    cxDefault: { agentKind: "codex" as const, processIsShell: false },
    cxPinned: { agentKind: "codex" as const, processIsShell: false },
    cxMeta: { agentKind: "codex" as const, processIsShell: false },
    gkDefault: { agentKind: "grok" as const, processIsShell: false },
    gkPinned: { agentKind: "grok" as const, processIsShell: false },
    gkMeta: { agentKind: "grok" as const, processIsShell: false },
    hybrid: { agentKind: "claude-codex" as const, processIsShell: false, processTitle: "Hybrid" },
    shell: { agentKind: "claude" as const, processIsShell: true },
  };
  const workspaces = [{ panes: [{ tabs: [
    { sessionId: "ccDefault", agentKind: "claude" },
    { sessionId: "ccPinned", agentKind: "claude", agentAccountId: "claude-work" },
    { sessionId: "ccUnknown", agentAccountId: "claude-work" },
    { sessionId: "ccMismatch", agentKind: "codex", agentAccountId: "codex-work" },
    { sessionId: "cxDefault", agentKind: "codex" },
    { sessionId: "cxPinned", agentKind: "codex", agentAccountId: "codex-work" },
    { sessionId: "gkDefault", agentKind: "grok" },
    { sessionId: "gkPinned", agentKind: "grok", agentAccountId: "grok-work" },
    { sessionId: "hybrid", agentKind: "claude-codex", agentAccountId: "claude-work" },
    { sessionId: "shell", agentKind: "claude", agentAccountId: "claude-work" },
  ] }] }];
  it("separates confirmed pinned tabs for all providers and conservatively keeps unknowns and hybrid", () => {
    expect(runningAgentCounts(metadata)).toEqual({ claude: 6, codex: 4, grok: 3 });
    expect(runningAgentCounts(metadata, workspaces)).toEqual({ claude: 5, codex: 3, grok: 2 });
    expect(pinnedAgentCounts(metadata, workspaces)).toEqual({ claude: 1, codex: 1, grok: 1 });
  });
  it("filters the same tabs from paneDetails and explains the unaffected count on its own line", () => {
    const details = runningAgentPaneDetails(metadata, "claude", {}, workspaces);
    expect(details).toHaveLength(5);
    expect(details.join("\n")).not.toContain("CC pinned");
    expect(details.join("\n")).toContain("CC metadata only");
    expect(details.join("\n")).toContain("CC unknown ownership");
    expect(details.join("\n")).toContain("CC conflicting ownership");
    expect(details.join("\n")).toContain("Hybrid");
    const message = switchWarningText(5, "claude", "仕事用", details, 1);
    expect(message).toContain("5 件実行中");
    expect(message.split("\n")).toContain("アカウントを指定したタブ 1 件は、この切り替えの影響を受けません");
    expect(message).toContain("mycmux の外で動いている CLI は検知できません");
    expect(message).not.toContain("CC pinned");
  });
  it("keeps a live tab in the warning if layout ownership is duplicated", () => {
    const duplicate = [{ panes: [{ tabs: [
      { sessionId: "ccPinned", agentKind: "claude", agentAccountId: "claude-work" },
      { sessionId: "ccPinned", agentKind: "claude", agentAccountId: "claude-other" },
    ] }] }];
    expect(runningAgentCounts(metadata, duplicate)).toEqual(runningAgentCounts(metadata));
    expect(pinnedAgentCounts(metadata, duplicate).claude).toBe(0);
  });
  it.each([
    ["claude", { agentId: "claude-code" }], ["codex", { agentId: "codex" }], ["grok", { launchEnv: { MYCMUX_LAUNCH_TARGET: "grok" } }],
  ] as const)("resolves %s ownership from the tab's existing launch markers", (provider, markers) => {
    const live = { one: { agentKind: provider, processIsShell: false } };
    const layout = [{ panes: [{ tabs: [{ sessionId: "one", agentAccountId: provider + "-work", ...markers }] }] }];
    expect(runningAgentCounts(live, layout)[provider]).toBe(0);
    expect(pinnedAgentCounts(live, layout)[provider]).toBe(1);
  });
  it("omits the extra line when no known pinned tabs are running", () => {
    expect(switchWarningText(0, "codex")).not.toContain("影響を受けません");
  });
});

describe("E-1/E-2 coded account errors", () => {
  it.each(["cli_account.error.launch_token_missing", "cli_account.error.launch_token_expired", "cli_account.error.home_not_ready", "launch_account_not_found"])("translates %s with a next action", key => {
    const message = cliAccountLaunchErrorMessage(new Error(key))!;
    expect(message).toContain("原因:");
    expect(message).toContain("設定のアカウントで、タブ用のトークンかログインを済ませてから、タブを開き直してください");
    expect(message).not.toContain("cli_account.error.");
    expect(message).not.toContain("launch_account_not_found");
  });
  it("hides unknown coded errors and preserves the other terminal error paths", () => {
    expect(cliAccountLaunchErrorMessage("cli_account.error.future_code")).toContain(cliAccountMessage("unknown"));
    for (const value of ["ordinary failure", "C:\\private\\path", "cli_account.error.home_not_ready extra-data", { private: true }]) {
      expect(cliAccountLaunchErrorMessage(value)).toBeNull();
    }
  });
  it.each(["cli_account.error.home_session_unsupported", new Error("cli_account.error.home_session_unsupported")])("translates duplicate/shared-save refusals without the internal key", error => {
    const expected = cliAccountMessage("cli_account.error.home_session_unsupported");
    expect(cliAccountSessionErrorMessage(error)).toBe(expected);
    expect(savepointPublishErrorMessage(error)).toBe(expected);
    expect(expected).toContain("元のタブで続けてください");
    expect(expected).not.toContain("cli_account.error.");
  });
  it("keeps the existing savepoint no-transcript and other-error text", () => {
    expect(savepointPublishErrorMessage("Session transcript fixture not found")).toBe(onlineStrings.publishNoTranscript);
    expect(savepointPublishErrorMessage("old error")).toBe(onlineStrings.publishErrorPrefix + "old error");
    expect(cliAccountSessionErrorMessage("old error")).toBeNull();
  });
});
