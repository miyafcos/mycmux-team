import { expect, it } from "vitest";
import { __terminalSnapshotCacheForTests } from "../../src/components/layout/SocketListener";
import { __turnListPromptCacheForTests } from "../../src/components/terminal/XTermWrapper";
import { evictTerminalCache } from "../../src/components/terminal/terminalCache";
it("closing one session clears both actual caches and retains the other session", () => {
  const snapshots = __terminalSnapshotCacheForTests;
  const prompts = __turnListPromptCacheForTests;
  for (const id of ["closing", "keeper"]) {
    snapshots.set(id, { writeCounter: 1, lines: ["output"] });
    prompts.set(id, { fetchedAt: 1, prompts: [] });
  }
  try {
    evictTerminalCache("closing");
    expect(snapshots.has("closing")).toBe(false);
    expect(prompts.has("closing")).toBe(false);
    expect(snapshots.has("keeper")).toBe(true);
    expect(prompts.has("keeper")).toBe(true);
  } finally { snapshots.clear(); prompts.clear(); }
});
