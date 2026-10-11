import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { switchCliAccount, getAccountUsage } from "../../src/lib/ipc";
import { handleSocketCommand } from "../../src/components/layout/socketCommands";
import { __resetCliAccountStoreForTests } from "../../src/stores/cliAccountStore";

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tauri-apps/api/core")>(), invoke: vi.fn(),
}));

describe("account switch command bridge", () => {
  afterEach(() => { vi.mocked(invoke).mockReset(); __resetCliAccountStoreForTests(); });

  it("preserves the exact PC args and opts in only the API request", async () => {
    await switchCliAccount("claude", "claude-a");
    expect(invoke).toHaveBeenLastCalledWith("switch_cli_account", { provider: "claude", profileId: "claude-a" });
    await switchCliAccount("claude", "claude-a", true);
    expect(invoke).toHaveBeenLastCalledWith("switch_cli_account", { provider: "claude", profileId: "claude-a", apiRequest: true });
  });

  it("keeps exact PC usage arguments while API refreshes opt into private logging", async () => {
    await getAccountUsage();
    expect(invoke).toHaveBeenLastCalledWith("get_account_usage");
    await getAccountUsage(true);
    expect(invoke).toHaveBeenLastCalledWith("get_account_usage", { refreshMetadata: true });
    await getAccountUsage(false, "account.switch");
    expect(invoke).toHaveBeenLastCalledWith("get_account_usage", { apiCommand: "account.switch" });
  });

  it("dispatches through the actual store and IPC with structured no-op", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "switch_cli_account") throw "cli_account.result.already_active";
      if (command === "list_cli_accounts") return {
        live: [{ provider: "claude", error: null, matched_profile_id: "claude-a" }],
        active: { claude: "claude-a", codex: null, grok: null },
      };
      throw new Error("unexpected command");
    });
    await expect(handleSocketCommand("account.switch", { provider: "claude", profile_id: "claude-a" })).resolves.toMatchObject({ status: "already_active", applied: false, error_code: null, active_profile_id: "claude-a" });
    expect(invoke).toHaveBeenCalledWith("switch_cli_account", { provider: "claude", profileId: "claude-a", apiRequest: true });
  });
});
