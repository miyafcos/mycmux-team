import { describe, expect, it, vi } from "vitest";
import { createPtyExitReporter, PTY_EXIT_NOTICE } from "../../src/components/terminal/XTermWrapper";

describe("PTY exit notice", () => {
  it("writes the specified dim notice exactly once before onExit", () => {
    const order: string[] = [];
    const write = vi.fn((notice: string) => order.push(notice));
    const onExit = vi.fn(() => order.push("onExit"));
    const report = createPtyExitReporter(write, onExit);
    report();
    report();
    expect(PTY_EXIT_NOTICE).toBe("\r\n\x1b[2m[プロセスは終了しました。このペインを閉じるか、新しいペインを開いてください]\x1b[0m\r\n");
    expect(order).toEqual([PTY_EXIT_NOTICE, "onExit"]);
    expect(write).toHaveBeenCalledOnce();
    expect(onExit).toHaveBeenCalledOnce();
  });

  it("allows a new session start to report again without an onExit callback", () => {
    const write = vi.fn();
    createPtyExitReporter(write)();
    createPtyExitReporter(write)();
    expect(write).toHaveBeenCalledTimes(2);
  });
});
