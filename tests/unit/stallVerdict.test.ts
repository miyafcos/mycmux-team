import { describe, expect, it } from "vitest";

import { resolveStallVerdict } from "../../src/lib/stallVerdict";

const THRESHOLD = 300_000;
const base = {
  processActivity: "unknown" as const,
  queuedInput: false,
  screenAdvanced: false,
  screenSilentMs: 0,
  promptShape: null,
  ptyAlive: true,
};

describe("resolveStallVerdict", () => {
  it("keeps queued input waiting ahead of every other signal", () => {
    expect(resolveStallVerdict({
      ...base,
      queuedInput: true,
      ptyAlive: false,
      promptShape: { line: 0, kind: "question" },
      processActivity: "streaming",
    }, THRESHOLD)).toEqual({ state: "waiting", reason: "queued_input" });
  });

  it("prioritizes a dead PTY", () => {
    expect(resolveStallVerdict({ ...base, ptyAlive: false, promptShape: { line: 0, kind: "question" } }, THRESHOLD))
      .toEqual({ state: "stalled", reason: "pty_dead" });
  });

  it("treats a prompt as waiting even while the process reports streaming", () => {
    expect(resolveStallVerdict({ ...base, processActivity: "streaming", promptShape: { line: 0, kind: "choice" } }, THRESHOLD))
      .toEqual({ state: "waiting", reason: "prompt" });
  });

  it("recognizes active streaming", () => {
    expect(resolveStallVerdict({ ...base, processActivity: "streaming" }, THRESHOLD)).toEqual({ state: "working" });
  });

  it("stalls only when a silent running process also has a silent screen", () => {
    expect(resolveStallVerdict({ ...base, processActivity: "running_silent", screenSilentMs: THRESHOLD }, THRESHOLD))
      .toEqual({ state: "stalled", reason: "silent" });
    expect(resolveStallVerdict({ ...base, processActivity: "running_silent", screenAdvanced: true, screenSilentMs: THRESHOLD }, THRESHOLD))
      .toEqual({ state: "unknown" });
    expect(resolveStallVerdict({ ...base, processActivity: "running_silent", screenSilentMs: THRESHOLD - 1 }, THRESHOLD))
      .toEqual({ state: "unknown" });
  });

  it("requires a static screen before idle becomes stalled", () => {
    expect(resolveStallVerdict({ ...base, processActivity: "idle" }, THRESHOLD))
      .toEqual({ state: "stalled", reason: "silent" });
    expect(resolveStallVerdict({ ...base, processActivity: "idle", screenAdvanced: true }, THRESHOLD))
      .toEqual({ state: "unknown" });
  });

  it("keeps unknown signals unknown", () => {
    expect(resolveStallVerdict(base, THRESHOLD)).toEqual({ state: "unknown" });
  });
});
