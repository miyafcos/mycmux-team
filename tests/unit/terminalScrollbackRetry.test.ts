import { describe, expect, it, vi } from "vitest";
import { TerminalScrollbackRetry } from "../../src/components/terminal/XTermWrapper";
describe("scrollback retry state", () => {
  it("does not spend the failure budget after visibility loss or an older generation's completion", async () => {
    let now = 0;
    const retry = new TerminalScrollbackRetry(() => now);
    for (let n = 0; n < 10; n++) { await retry.run(async () => false, () => false); now += 10_000; }
    expect(retry.delay()).toBe(160);
    let finish!: (value: boolean) => void;
    const old = retry.run(() => new Promise(resolve => { finish = resolve; }));
    retry.reset(); finish(false); await old;
    expect(retry.delay()).toBe(160);
    await retry.run(async () => false); now += 160;
    await retry.run(async () => false); expect(retry.delay()).toBe(320);
  });
  it("backs off, admits six attempts, then stops until a visibility resync", async () => {
    let now = 0;
    const retry = new TerminalScrollbackRetry(() => now);
    const sync = vi.fn(async () => false);
    for (const delay of [160, 320, 640, 1280, 2560]) {
      expect(await retry.run(sync)).toBe(false);
      expect(retry.delay()).toBe(delay);
      now += delay - 1;
      await retry.run(sync);
      now += 1;
    }
    await retry.run(sync);
    expect(sync).toHaveBeenCalledTimes(6);
    expect(retry.delay()).toBeNull();
    now += 1_000_000;
    for (let i = 0; i < 1000; i++) await retry.run(sync);
    expect(sync).toHaveBeenCalledTimes(6);
    retry.reset();
    await retry.run(sync);
    expect(sync).toHaveBeenCalledTimes(7);
    expect(retry.delay()).toBe(160);
  });
  it("resets after success and treats rejected IPC as a failed attempt", async () => {
    let now = 0;
    const retry = new TerminalScrollbackRetry(() => now);
    const sync = vi.fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error("failed IPC")).mockResolvedValueOnce(true).mockResolvedValue(false);
    await retry.run(sync);
    now = 160;
    expect(await retry.run(sync)).toBe(true);
    await retry.run(sync);
    expect(retry.delay()).toBe(160);
  });
});
