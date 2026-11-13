import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { getTabAccountEvidence, recheckTabAccount, recheckCliLaunchToken, type TabAccountEvidence } from "../../src/lib/ipc";
vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(), invoke: vi.fn(),
}));
describe("V2 non-secret session evidence IPC", () => {

  it("preserves the optional non-secret owner status code while accepting legacy replies", async () => {
    const record: TabAccountEvidence = {
      provider: "claude", profile_id: "claude-fixture", method: "claude_launch_token", result: "unverified",
      checked_at: "2026-11-12T00:00:00Z", launched_at: "2026-11-12T00:00:00Z", owner_check_status: 403,
    };
    expectTypeOf<TabAccountEvidence["owner_check_status"]>().toEqualTypeOf<number | undefined>();
    vi.mocked(invoke).mockResolvedValueOnce(record);
    expect((await getTabAccountEvidence("pty-fixture"))?.owner_check_status).toBe(403);
    const { owner_check_status: _status, ...legacy } = record;
    vi.mocked(invoke).mockResolvedValueOnce(legacy);
    expect((await getTabAccountEvidence("pty-fixture"))?.owner_check_status).toBeUndefined();
  });

  it("sends only a session ID or profile ID to the three confirmation commands", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    expect(await getTabAccountEvidence("pty-fixture")).toBeNull();
    expect(invoke).toHaveBeenLastCalledWith("get_tab_account_evidence", { sessionId: "pty-fixture" });
    expect(await recheckTabAccount("pty-fixture")).toBeNull();
    expect(invoke).toHaveBeenLastCalledWith("recheck_tab_account", { sessionId: "pty-fixture" });
    await recheckCliLaunchToken("claude-fixture");
    expect(invoke).toHaveBeenLastCalledWith("recheck_cli_launch_token", { profileId: "claude-fixture" });
    type ContainsSecret = "token" extends keyof TabAccountEvidence ? true : false;
    expectTypeOf<ContainsSecret>().toEqualTypeOf<false>();
  });
});
