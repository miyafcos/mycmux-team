import { beforeEach, describe, expect, it, vi } from "vitest";
import { listOnlineSavepoints } from "../../src/lib/ipc";
import { useOnlineSavepointStore } from "../../src/stores/onlineSavepointStore";
import type { OnlineSavepointEntry } from "../../src/components/online/onlineSavepoints";

vi.mock("../../src/lib/ipc", () => ({
  listOnlineSavepoints: vi.fn(),
}));

const mockedListOnlineSavepoints = vi.mocked(listOnlineSavepoints);

function entry(
  claudeSessionId: string,
  overrides: Partial<OnlineSavepointEntry> = {},
): OnlineSavepointEntry {
  return {
    bundle_dir: `C:/online/${claudeSessionId}`,
    author: "author",
    machine: "machine",
    summary_line: "summary",
    cwd: "C:/work",
    created_at: "2026-07-11T00:00:00Z",
    updated_at: "2026-07-11T00:00:00Z",
    expires_at: "2026-07-13T00:00:00Z",
    pinned: false,
    warnings_count: 0,
    claude_session_id: claudeSessionId,
    files_written_count: 0,
    handoff_path: `C:/online/${claudeSessionId}/handoff.md`,
    ...overrides,
  };
}

describe("useOnlineSavepointStore", () => {
  beforeEach(() => {
    mockedListOnlineSavepoints.mockReset();
    useOnlineSavepointStore.getState().setFromEntries([]);
  });

  it("refresh populates published session ids", async () => {
    mockedListOnlineSavepoints.mockResolvedValue([entry("session-a"), entry("session-b")]);

    await useOnlineSavepointStore.getState().refresh();

    expect(useOnlineSavepointStore.getState().publishedSessionIds).toEqual({
      "claude:session-a": true,
      "claude:session-b": true,
    });
  });

  it("refresh keeps the previous state when listing fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    useOnlineSavepointStore.getState().setFromEntries([entry("existing")]);
    mockedListOnlineSavepoints.mockRejectedValue(new Error("unavailable"));

    await useOnlineSavepointStore.getState().refresh();

    expect(useOnlineSavepointStore.getState().publishedSessionIds).toEqual({
      "claude:existing": true,
    });
    warn.mockRestore();
  });

  it("setFromEntries replaces the published session ids", () => {
    useOnlineSavepointStore.getState().setFromEntries([entry("old")]);

    useOnlineSavepointStore.getState().setFromEntries([entry("new")]);

    expect(useOnlineSavepointStore.getState().publishedSessionIds).toEqual({
      "claude:new": true,
    });
  });

  it("tracks only updateable current records", () => {
    useOnlineSavepointStore.getState().setFromEntries([
      entry("current", { record_kind: "current", lifecycle_status: "active" }),
      entry("legacy"),
      entry("final", { record_kind: "final", lifecycle_status: "closed" }),
      entry("closed-head", { record_kind: "current", lifecycle_status: "closed" }),
      entry("trashed", {
        record_kind: "current",
        lifecycle_status: "active",
        trash_id: "trash-id",
        deleted_at: "2026-07-14T12:00:00Z",
      }),
    ]);

    expect(useOnlineSavepointStore.getState().publishedSessionIds).toEqual({
      "claude:current": true,
      "claude:legacy": true,
    });
  });

  it("keeps identical Claude and Codex session ids in separate namespaces", () => {
    useOnlineSavepointStore.getState().setFromEntries([
      entry("same"),
      entry("codex-bundle", {
        agent_kind: "codex",
        agent_session_id: "same",
        claude_session_id: null,
      }),
    ]);

    expect(useOnlineSavepointStore.getState().publishedSessionIds).toEqual({
      "claude:same": true,
      "codex:same": true,
    });
  });
});
