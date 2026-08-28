import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPersistenceRetryQueue } from "../../src/components/layout/SocketListener";

const sourcePath = path.resolve("src/components/layout/SocketListener.tsx");
const source = fs.readFileSync(sourcePath, "utf8");

describe("SocketListener persistence production contracts", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps one workspace serializer for autosave and request-bound persistence", () => {
    expect(source).not.toContain("function requestWorkspaceConfigs(");
    expect(source.match(/\.map\(\(workspace\) => toConfig\(workspace\)\)/g)).toHaveLength(2);
    expect(source.match(/serializePersistentWorkspaceSet\(\{/g)).toHaveLength(2);
  });

  it("does not cancel a pending complete autosave for an immediate request", () => {
    const leaderDriver = source.slice(
      source.indexOf("registerPersistenceLeader({"),
      source.indexOf("const countLiveAgentSessions"),
    );
    expect(leaderDriver).not.toMatch(/sync:\s*\(request\)[\s\S]*?clearTimeout\(debounceTimer\)/);
  });

  it("runs the newest retry generation against the current world", async () => {
    vi.useFakeTimers();
    let currentWorld = "R1";
    const writes: Array<[number, string]> = [];
    let queue: ReturnType<typeof createPersistenceRetryQueue<string>>;
    queue = createPersistenceRetryQueue({
      delayMs: () => 100,
      canSchedule: () => true,
      run: async (record) => {
        writes.push([record.generation, currentWorld]);
        queue.clear(record.generation);
        return true;
      },
    });
    queue.schedule({ generation: 1, request: "R1" });
    queue.schedule({ generation: 2, request: "R2" });
    currentWorld = "R3";

    await vi.advanceTimersByTimeAsync(100);

    expect(writes).toEqual([[2, "R3"]]);
    expect(queue.active()).toBeNull();
  });

  it("requeues an observed transition-time rejection without losing its generation", async () => {
    vi.useFakeTimers();
    let transitionActive = true;
    const attempts: number[] = [];
    let queue: ReturnType<typeof createPersistenceRetryQueue<null>>;
    queue = createPersistenceRetryQueue({
      delayMs: () => 100,
      canSchedule: () => true,
      run: async (record) => {
        attempts.push(record.generation);
        if (transitionActive) throw new Error("transition active");
        queue.clear(record.generation);
        return true;
      },
    });
    queue.schedule({ generation: 7, request: null });

    await vi.advanceTimersByTimeAsync(100);
    expect(attempts).toEqual([7]);
    expect(queue.hasScheduledTimer()).toBe(true);

    transitionActive = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(attempts).toEqual([7, 7]);
    expect(queue.active()).toBeNull();
  });
});
