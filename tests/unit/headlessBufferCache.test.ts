import { beforeEach, describe, expect, it, vi } from "vitest";

const headlessState = vi.hoisted(() => ({
  instances: [] as Array<{
    options: Record<string, unknown>;
    writes: Uint8Array[];
    dispose: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("@xterm/headless/lib-headless/xterm-headless.mjs", () => {
  class FakeTerminal {
    readonly buffer = {
      active: {
        length: 0,
        getLine: () => undefined,
      },
    };
    readonly writes: Uint8Array[] = [];
    readonly dispose = vi.fn();

    constructor(readonly options: Record<string, unknown>) {
      headlessState.instances.push(this);
    }

    write(data: Uint8Array, callback?: () => void): void {
      this.writes.push(data.slice());
      callback?.();
    }
  }

  return { Terminal: FakeTerminal };
});

import {
  __resetHeadlessBufferCacheForTests,
  getHeadlessBufferLines,
} from "../../src/components/terminal/headlessBuffer";

beforeEach(() => {
  __resetHeadlessBufferCacheForTests();
  headlessState.instances.length = 0;
});

describe("headless terminal scrollback cache", () => {
  it("writes only the new byte range on the second read", async () => {
    await getHeadlessBufferLines(
      "session",
      { data: new Uint8Array([1, 2, 3]), startOffset: 0, endOffset: 3 },
      80,
    );
    await getHeadlessBufferLines(
      "session",
      { data: new Uint8Array([1, 2, 3, 4, 5]), startOffset: 0, endOffset: 5 },
      80,
    );

    expect(headlessState.instances).toHaveLength(1);
    expect(headlessState.instances[0].writes.map((bytes) => [...bytes])).toEqual([
      [1, 2, 3],
      [4, 5],
    ]);
    expect(headlessState.instances[0].options).toMatchObject({
      cols: 80,
      rows: 24,
      scrollback: 5000,
      allowProposedApi: true,
    });
  });

  it("disposes the oldest terminal on eviction and every remaining terminal on reset", async () => {
    for (let index = 0; index < 13; index++) {
      await getHeadlessBufferLines(
        `session-${index}`,
        { data: new Uint8Array([index]), startOffset: 0, endOffset: 1 },
        80,
      );
    }

    expect(headlessState.instances).toHaveLength(13);
    expect(headlessState.instances[0].dispose).toHaveBeenCalledTimes(1);
    expect(headlessState.instances.slice(1).every((instance) => instance.dispose.mock.calls.length === 0)).toBe(
      true,
    );

    __resetHeadlessBufferCacheForTests();
    expect(headlessState.instances.every((instance) => instance.dispose.mock.calls.length === 1)).toBe(true);
  });
});
