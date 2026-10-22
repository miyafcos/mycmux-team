import { afterEach, expect, it, vi } from "vitest";
import { publishSavepoint, finalizeSavepoint } from "../../src/lib/ipc";

const transport = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue({}) }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: transport.invoke }));
vi.mock("../../src/lib/windowContext", () => ({ windowLabel: () => "fixture-window" }));
afterEach(() => transport.invoke.mockClear());

it.each([publishSavepoint, finalizeSavepoint])("keeps Hybrid identity in both save commands without a native Claude alias", async save => {
  await save({ cwd: "C:/fixture", agentKind: "claude-codex", agentSessionId: "11111111-1111-4111-8111-111111111111" });
  expect(transport.invoke).toHaveBeenCalledTimes(1);
  expect(transport.invoke.mock.calls[0][1]).toMatchObject({ agentKind: "claude-codex", agentSessionId: "11111111-1111-4111-8111-111111111111", claudeSessionId: null });
});
