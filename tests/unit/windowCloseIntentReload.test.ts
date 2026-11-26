import { afterEach, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(), invoke,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  invoke.mockReset();
});

it.each([true, false])("accepts the first intent after reload without storage (closing: %s)", async firstIntent => {
  vi.resetModules();
  const unavailable = () => { throw new DOMException("Storage is unavailable", "SecurityError"); };
  vi.stubGlobal("sessionStorage", { getItem: unavailable, setItem: unavailable });
  vi.stubGlobal("__MYCMUX_LAYOUT_PUBLICATION_ID__", "publisher");
  let generation = 0;
  let sequenceGeneration = generation;
  let lastSequence = 0;
  let closingState = false;
  let holdNext = false;
  let delivered!: () => void;
  let resume!: () => void;
  const waiting = new Promise<void>(resolve => { delivered = resolve; });
  invoke.mockImplementation(async (command: string, args: {
    publicationId: string; sequence: number; closing: boolean; document?: number; readCloseIntentDocument?: boolean;
  }) => {
    expect(args.publicationId).toBe("publisher");
    if (command === "publish_window_fragment" && args.readCloseIntentDocument) return generation;
    expect(command).toBe("set_window_close_intent");
    if (holdNext) {
      holdNext = false;
      await new Promise<void>(resolve => { resume = resolve; delivered(); });
    }
    if (args.document !== undefined) {
      if (args.document !== generation) throw new Error("stale document");
      if (sequenceGeneration !== generation) lastSequence = 0;
      sequenceGeneration = generation;
    }
    if (args.sequence <= lastSequence) throw new Error("stale sequence");
    lastSequence = args.sequence;
    closingState = args.closing;
  });

  const old = await import("../../src/lib/ipc");
  await old.setWindowCloseIntent(true);
  await old.setWindowCloseIntent(false);
  holdNext = true;
  const late = old.setWindowCloseIntent(true).then(() => null, error => error as Error);
  await waiting;
  generation++;
  vi.resetModules();
  const current = await import("../../src/lib/ipc");
  try {
    await current.setWindowCloseIntent(firstIntent);
    expect(closingState).toBe(firstIntent);
    await current.setWindowCloseIntent(!firstIntent);
    expect(closingState).toBe(!firstIntent);
  } finally {
    resume();
  }
  expect(await late).toEqual(new Error("stale document"));
  expect(closingState).toBe(!firstIntent);
});
