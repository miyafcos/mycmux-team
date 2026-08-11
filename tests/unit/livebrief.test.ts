import { describe, expect, it } from "vitest";

import { targetKey, type LiveBinding } from "../../src/lib/livebrief";

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
