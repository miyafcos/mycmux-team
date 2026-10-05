import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalDeadlineError, withTerminalDeadline } from "../../src/lib/terminalDeadline";
afterEach(() => vi.useRealTimers());
describe("terminal IPC deadlines", () => {
  it("rejects a missing response and consumes its later success", async () => {
    vi.useFakeTimers(); let finish!: (value: number) => void;
    const late = new Promise<number>(resolve => { finish = resolve; });
    const apply = vi.fn(); const request = withTerminalDeadline(late, "scrollback", 100).then(apply);
    const rejected = expect(request).rejects.toBeInstanceOf(TerminalDeadlineError);
    await vi.advanceTimersByTimeAsync(100); await rejected;
    finish(1); await Promise.resolve(); expect(apply).not.toHaveBeenCalled();
    expect(await withTerminalDeadline(Promise.resolve(2), "next scrollback", 100)).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("preserves backend rejection and clears a successful request's timer", async () => {
    vi.useFakeTimers(); const error = new Error("backend failed");
    await expect(withTerminalDeadline(Promise.reject(error), "resize")).rejects.toBe(error);
    expect(await withTerminalDeadline(Promise.resolve(3), "resize")).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });
});
