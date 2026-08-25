import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/ailog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/ailog")>()),
  ailogIndexStart: vi.fn(),
  ailogIndexStatus: vi.fn(),
}));

vi.mock("../../src/stores/ailogStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/stores/ailogStore")>()),
  invalidateAilogCaches: vi.fn(),
}));

import { ailogIndexStart, ailogIndexStatus } from "../../src/lib/ailog";
import { invalidateAilogCaches, jobDisplayError } from "../../src/stores/ailogStore";
import { __resetAilogJobStoreForTests, useAilogJobStore } from "../../src/stores/useAilogJobStore";

const idle = { running: false, filesDone: 0, filesTotal: 0, sessions: 0, lastFinishedAt: 1, lastError: null };

describe("ailog job store auto index", () => {
  beforeEach(() => {
    __resetAilogJobStoreForTests();
    vi.mocked(ailogIndexStart).mockReset();
    vi.mocked(ailogIndexStatus).mockReset().mockResolvedValue(idle);
    vi.mocked(invalidateAilogCaches).mockReset();
  });
  afterEach(__resetAilogJobStoreForTests);

  it("records a silent start without treating alreadyRunning as an action error", async () => {
    vi.mocked(ailogIndexStart).mockResolvedValue({ started: false, alreadyRunning: true });
    await useAilogJobStore.getState().startIndex(false, { silent: true });
    expect(useAilogJobStore.getState().index.autoStarted).toBe(true);
    expect(useAilogJobStore.getState().lastAutoStartedAt).toBeGreaterThan(0);
    expect(useAilogJobStore.getState().index.actionError).toBeNull();
    expect(jobDisplayError(useAilogJobStore.getState().index)).toBeNull();
  });

  it("still surfaces alreadyRunning when the start is manual", async () => {
    vi.mocked(ailogIndexStart).mockResolvedValue({ started: false, alreadyRunning: true });
    await useAilogJobStore.getState().startIndex(false);
    expect(useAilogJobStore.getState().index.autoStarted).toBe(false);
    expect(useAilogJobStore.getState().index.actionError).toContain("すでに実行中");
  });

  it("invalidates once when an event refresh and a poll observe the same stop", async () => {
    let finish!: (value: typeof idle) => void;
    const stopped = new Promise<typeof idle>((resolve) => { finish = resolve; });
    vi.mocked(ailogIndexStatus).mockReset().mockReturnValue(stopped);
    useAilogJobStore.setState((state) => ({ index: { ...state.index, status: { ...idle, running: true } } }));

    useAilogJobStore.getState().applyIndexProgress({ phase: "done", filesDone: 1, filesTotal: 1, sessions: 1, bytesDone: 1, bytesTotal: 1, elapsedMs: 1 });
    const pollRefresh = useAilogJobStore.getState().refreshIndexStatus();
    expect(ailogIndexStatus).toHaveBeenCalledTimes(2);

    finish(idle);
    await pollRefresh;
    await Promise.resolve();
    expect(invalidateAilogCaches).toHaveBeenCalledOnce();
  });
});
