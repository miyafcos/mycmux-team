import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { scanTerminalAskQuestion } from "../../src/components/terminal/XTermWrapper";
import { useAskQuestionStore } from "../../src/stores/askQuestionStore";
const fixtures = JSON.parse(readFileSync(new URL("../fixtures/askQuestionScreens.json", import.meta.url), "utf8")) as Record<string, string[]>;
beforeEach(() => useAskQuestionStore.getState().resetForTests());
describe("output question scan", () => {
  it("makes no revision IPC for 5000 ordinary output scans", async () => {
    const read = vi.fn(async () => 7);
    for (let index = 0; index < 5000; index++) {
      await expect(scanTerminalAskQuestion("ordinary", ["Building " + index, "1. ordinary numbered output"], index, read)).resolves.toBeNull();
    }
    expect(read).not.toHaveBeenCalled();
  });
  it("reads the accepted screen again after awaiting its revision", async () => {
    let release!: (revision: number) => void;
    const read = vi.fn(() => new Promise<number>((resolve) => { release = resolve; }));
    let lines = fixtures.single;
    const pending = scanTerminalAskQuestion("changed", () => lines, 100, read);
    lines = ["Working on the next turn"];
    release(17);
    await expect(pending).resolves.toBeNull();
    expect(useAskQuestionStore.getState().bySession.changed?.screen ?? null).toBeNull();
  });
  it.each(["single", "tabbed", "review", "multiSelect"])("preserves %s questions and their revision", async (kind) => {
    const read = vi.fn(async () => 17);
    const screen = await scanTerminalAskQuestion("question", fixtures[kind], 100, read);
    expect(screen).not.toBeNull();
    expect(read).toHaveBeenCalledExactlyOnceWith("question");
    expect(useAskQuestionStore.getState().bySession.question).toMatchObject({ screen, expectedInputRevision: 17 });
    await scanTerminalAskQuestion("question", ["Working on the next turn"], 101, read);
    expect(read).toHaveBeenCalledOnce();
    expect(useAskQuestionStore.getState().bySession.question.screen).toBeNull();
  });
});
