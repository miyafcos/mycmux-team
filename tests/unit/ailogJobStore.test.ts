import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/ailog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/ailog")>()),
  ailogIndexStart: vi.fn(),
  ailogIndexStatus: vi.fn(),
}));

import { ailogIndexStart, ailogIndexStatus } from "../../src/lib/ailog";
import { jobDisplayError } from "../../src/stores/ailogStore";
import { __resetAilogJobStoreForTests, useAilogJobStore } from "../../src/stores/useAilogJobStore";

const idle = { running: false, filesDone: 0, filesTotal: 0, sessions: 0, lastFinishedAt: 1, lastError: null };

describe("ailog job store auto index", () => {
  beforeEach(() => {
    __resetAilogJobStoreForTests();
    vi.mocked(ailogIndexStart).mockReset();
    vi.mocked(ailogIndexStatus).mockReset().mockResolvedValue(idle);
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
});
