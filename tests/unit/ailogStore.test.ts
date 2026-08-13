import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/ailog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/ailog")>()),
  ailogIndexStart: vi.fn(), ailogIndexStatus: vi.fn(), ailogDigestGenerate: vi.fn(), ailogDigestGet: vi.fn(),
}));

import { ailogDigestGenerate, ailogDigestGet, ailogIndexStart, ailogIndexStatus } from "../../src/lib/ailog";
import { __resetAilogStoreForTests, jobDisplayError, useAilogStore } from "../../src/stores/ailogStore";

const indexStatus = (lastError: string | null, running = false) => ({ running, filesDone: 0, filesTotal: 0, sessions: 0, lastFinishedAt: 1, lastError });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((res) => { resolve = res; }); return { promise, resolve }; }

describe("AI log store U0", () => {
  beforeEach(() => { __resetAilogStoreForTests(); vi.mocked(ailogIndexStart).mockReset(); vi.mocked(ailogIndexStatus).mockReset(); vi.mocked(ailogDigestGenerate).mockReset(); vi.mocked(ailogDigestGet).mockReset(); });
  afterEach(__resetAilogStoreForTests);

  it("keeps an action failure when its following status refresh succeeds", async () => {
    vi.mocked(ailogIndexStart).mockRejectedValue(new Error("start failed"));
    await useAilogStore.getState().startIndex(false);
    vi.mocked(ailogIndexStatus).mockResolvedValue(indexStatus(null));
    await useAilogStore.getState().refreshIndexStatus();
    expect(useAilogStore.getState().index.actionError).toContain("start failed");
    expect(jobDisplayError(useAilogStore.getState().index)).toContain("start failed");
  });

  it("dismisses a background failure and clears the dismissal when a new run starts", async () => {
    vi.mocked(ailogIndexStatus).mockResolvedValue(indexStatus("old failure"));
    await useAilogStore.getState().refreshIndexStatus();
    useAilogStore.getState().dismissIndexError();
    expect(jobDisplayError(useAilogStore.getState().index)).toBeNull();
    vi.mocked(ailogIndexStart).mockResolvedValue({ started: true, alreadyRunning: false });
    vi.mocked(ailogIndexStatus).mockResolvedValue(indexStatus(null, true));
    await useAilogStore.getState().startIndex(false);
    expect(useAilogStore.getState().index.dismissedError).toBeNull();
  });

  it("hands digest busy ownership to a new date immediately", async () => {
    const pending = deferred<any>();
    vi.mocked(ailogDigestGenerate).mockReturnValue(pending.promise);
    vi.mocked(ailogDigestGet).mockResolvedValue({ date: "2026-08-12", digest: null, reason: null, parseError: null });
    const run = useAilogStore.getState().generateDigest();
    expect(useAilogStore.getState().digestGenerating).toBe(true);
    useAilogStore.getState().setDigestDate("2026-08-13");
    expect(useAilogStore.getState().digestGenerating).toBe(false);
    pending.resolve({ date: "2026-08-12", digest: null, reason: null, parseError: null });
    await run;
    expect(useAilogStore.getState().digestGenerating).toBe(false);
  });
});
