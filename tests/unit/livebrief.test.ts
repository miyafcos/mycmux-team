import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(() => Promise.resolve([])),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

import { getLiveEvents, LIVE_EVENT_LIMIT, targetKey, type LiveBinding } from "../../src/lib/livebrief";

describe("live brief target identity", () => {
  it("keeps draft/result ownership separate when a PTY generation changes", () => {
    const base: LiveBinding = {
      ptySessionId: "pane-1",
      agentSessionId: "agent-1",
      agentKind: "codex",
      ptyInstanceId: "pty-7",
      ptyGeneration: 7,
      sourceRevision: 12,
      ptyInputRevision: 4,
    };
    expect(targetKey(base)).not.toBe(targetKey({ ...base, ptyGeneration: 8, ptyInstanceId: "pty-8" }));
  });
});

describe("getLiveEvents", () => {
  beforeEach(() => {
    mocks.invoke.mockClear();
  });

  it("sends the session ids under the camelCase argument name", async () => {
    await getLiveEvents(["pane-1", "pane-2"], 20);
    expect(mocks.invoke).toHaveBeenCalledWith("get_live_events", { ptySessionIds: ["pane-1", "pane-2"], limit: 20 });
  });

  it("defaults the limit to the shared window size", async () => {
    await getLiveEvents(["pane-1"]);
    expect(LIVE_EVENT_LIMIT).toBe(50);
    expect(mocks.invoke).toHaveBeenCalledWith("get_live_events", { ptySessionIds: ["pane-1"], limit: LIVE_EVENT_LIMIT });
  });
});
