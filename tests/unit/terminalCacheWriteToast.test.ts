import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/ipc", () => ({
  writeToSession: vi.fn(),
}));

import { writeToSession } from "../../src/lib/ipc";
import { enqueueSessionWrite } from "../../src/components/terminal/terminalCache";
import { __resetToastStoreForTests, useToastStore } from "../../src/stores/toastStore";

const mockedWriteToSession = vi.mocked(writeToSession);
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

describe("enqueueSessionWrite failure toast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    mockedWriteToSession.mockReset();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    __resetToastStoreForTests();
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    __resetToastStoreForTests();
    vi.useRealTimers();
  });

  it("debounces write failure toasts per session for three seconds", async () => {
    mockedWriteToSession.mockRejectedValue(new Error("backend gone"));

    enqueueSessionWrite("session-a", "a");
    await flushPromises();
    enqueueSessionWrite("session-a", "b");
    await flushPromises();

    expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual([
      "Terminal input failed to send",
    ]);

    vi.advanceTimersByTime(3000);
    vi.setSystemTime(1_003_000);

    enqueueSessionWrite("session-a", "c");
    await flushPromises();

    expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual([
      "Terminal input failed to send",
      "Terminal input failed to send",
    ]);
  });

  it("debounces write failure toasts independently per session", async () => {
    mockedWriteToSession.mockRejectedValue(new Error("backend gone"));

    enqueueSessionWrite("session-c", "c");
    enqueueSessionWrite("session-d", "d");
    await flushPromises();

    expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual([
      "Terminal input failed to send",
      "Terminal input failed to send",
    ]);
  });
});
