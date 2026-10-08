import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTerminalProgressDiagnostics, TERMINAL_PROGRESS_INTERVAL_MS,
  TERMINAL_PROGRESS_SESSION_CAP, type TerminalProgressViewport } from "../../src/lib/terminalProgressDiagnostics";
import { useSettingsStore } from "../../src/stores/settingsStore";

const TOKEN = "12345678-1234-4123-8123-123456789abc";
const viewport = (): TerminalProgressViewport => ({
  viewportY: 3, baseY: 8, alternate: false, cols: 80, rows: 24, overlayOwners: 0,
});
let enabled: boolean;
let write: ReturnType<typeof vi.fn>;
let diag: ReturnType<typeof createTerminalProgressDiagnostics>;
let releases: (() => void)[];
function watch(sessionId = "private-session-id", read = viewport): void {
  releases.push(diag.watch(sessionId, read));
}
async function sample(): Promise<void> {
  await vi.advanceTimersByTimeAsync(TERMINAL_PROGRESS_INTERVAL_MS);
}
beforeEach(() => {
  vi.useFakeTimers(); enabled = true; releases = [];
  write = vi.fn(async () => {});
  diag = createTerminalProgressDiagnostics({ enabled: () => enabled, write, token: () => TOKEN });
});
afterEach(() => { releases.forEach((release) => release()); vi.useRealTimers(); });

describe("content-free terminal progress diagnostics (P2)", () => {
  it("defaults off and neither reads viewports nor writes or schedules while off", async () => {
    expect(useSettingsStore.getInitialState().terminalProgressDiagnosticsEnabled).toBe(false);
    enabled = false;
    const read = vi.fn(viewport); watch("secret-id", read);
    diag.receive("secret-id", 1, 100); diag.render("secret-id");
    expect(diag.startWrite("secret-id", 100, 1)).toBeNull();
    await sample();
    expect(write).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("projects only the fixed numeric/bool schema and an unrelated random token", async () => {
    watch("private-session-id", () => ({ ...viewport(), body: "private-body", path: "/private/path", input: "private-input", env: "private-env" }));
    diag.receive("private-session-id", 2, 50);
    diag.finishWrite("private-session-id", diag.startWrite("private-session-id", 40, 2));
    diag.render("private-session-id");
    await sample();
    const request = write.mock.calls[0][0][0];
    expect(request.sessionId).toBe("private-session-id");
    expect(request.sample).toEqual({ ...viewport(), token: TOKEN, receivedGeneration: 2,
      parsedGeneration: 2, receivedEnd: 50, parsedEnd: 40, renderTick: 1 });
    const logged = JSON.stringify(request.sample);
    for (const secret of ["private-body", "private-session-id", "/private/path", "private-input", "private-env"]) expect(logged).not.toContain(secret);
  });

  it("distinguishes received backlog, a stalled parser, and a renderer with no new ticks", async () => {
    watch();
    diag.receive("private-session-id", 1, 100);
    const pending = diag.startWrite("private-session-id", 100, 1);
    await sample();
    expect(write.mock.calls[0][0][0].sample).toMatchObject({ receivedEnd: 100, parsedEnd: null, renderTick: 0 });
    // Only the real callback finishes this token; a write watchdog is not parsing.
    diag.finishWrite("private-session-id", pending);
    await sample();
    expect(write.mock.calls[1][0][0].sample).toMatchObject({ parsedEnd: 100, renderTick: 0 });
    diag.render("private-session-id");
    await sample();
    expect(write.mock.calls[2][0][0].sample.renderTick).toBe(1);
  });

  it("bounds retained sessions, per-tick records, and cancels the last timer", async () => {
    for (let i = 0; i < TERMINAL_PROGRESS_SESSION_CAP + 20; i += 1) watch(`session-${i}`);
    await sample();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toHaveLength(TERMINAL_PROGRESS_SESSION_CAP);
    expect(vi.getTimerCount()).toBe(1);
    releases.forEach((release) => release()); releases = [];
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not accumulate IPC requests when the logger is slow", async () => {
    let resolve!: () => void;
    write.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    watch(); await sample();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(write).toHaveBeenCalledTimes(1);
    resolve(); await Promise.resolve(); await Promise.resolve(); await sample();
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("stops recording and writing immediately when disabled with existing watchers", async () => {
    watch(); enabled = false;
    diag.receive("private-session-id", 1, 100); diag.render("private-session-id");
    await sample(); expect(write).not.toHaveBeenCalled();
    enabled = true; await sample();
    expect(write.mock.calls[0][0][0].sample).toMatchObject({ receivedEnd: null, parsedEnd: null, renderTick: 0 });
  });

  it("ignores late parse callbacks from an old generation and does not move backwards", async () => {
    watch(); diag.receive("private-session-id", 1, 100);
    const oldWrite = diag.startWrite("private-session-id", 100, 1);
    diag.receive("private-session-id", 2, 200);
    diag.finishWrite("private-session-id", oldWrite);
    await sample();
    expect(write.mock.calls[0][0][0].sample).toMatchObject({ receivedGeneration: 2, receivedEnd: 200, parsedEnd: null });
    diag.receive("private-session-id", 1, 300);
    diag.receive("private-session-id", 2, 190);
    diag.finishWrite("private-session-id", diag.startWrite("private-session-id", 200, 2));
    diag.finishWrite("private-session-id", diag.startWrite("private-session-id", 190, 2));
    await sample();
    expect(write.mock.calls[1][0][0].sample).toMatchObject({ receivedEnd: 200, parsedEnd: 200, parsedGeneration: 2 });
  });

  it("does not let an old mount's cleanup or write callback alter a new mount", async () => {
    watch(); diag.receive("private-session-id", 1, 100);
    const oldWrite = diag.startWrite("private-session-id", 100, 1);
    watch(); releases[0]();
    diag.finishWrite("private-session-id", oldWrite);
    await sample();
    expect(write.mock.calls[0][0][0].sample.parsedEnd).toBeNull();
    expect(vi.getTimerCount()).toBe(1);
  });

  it("records a scrollback write without guessing an unobserved generation", async () => {
    watch();
    diag.finishWrite("private-session-id", diag.startWrite("private-session-id", 150));
    await sample();
    expect(write.mock.calls[0][0][0].sample).toMatchObject({ receivedGeneration: null, parsedGeneration: null,
      receivedEnd: null, parsedEnd: 150 });
  });

  it("does not serialize invalid numeric metadata or failed viewport reads", async () => {
    watch("bad", () => ({ ...viewport(), cols: NaN }));
    watch("throw", () => { throw new Error("private failure"); });
    watch("empty", () => null as unknown as TerminalProgressViewport);
    await sample(); expect(write).not.toHaveBeenCalled();
  });

  it("ignores invalid receive/write positions and swallows logger errors", async () => {
    watch(); diag.receive("private-session-id", Infinity, 100);
    diag.receive("private-session-id", 1, -2);
    expect(diag.startWrite("private-session-id", NaN)).toBeNull();
    write.mockRejectedValueOnce(new Error("private logger failure"));
    await sample(); await sample();
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1][0][0].sample.receivedEnd).toBeNull();
  });

  it("instruments real callbacks separately from timeout, ACK, and attach effects", () => {
    const source = readFileSync("src/components/terminal/XTermWrapper.tsx", "utf8");
    const callbackStart = source.indexOf("writeTerm.write(rewrittenOutput, () => {");
    expect(callbackStart).toBeGreaterThan(-1);
    const callback = source.slice(callbackStart, callbackStart + 1_000);
    expect(callback).toContain("terminalProgressDiagnostics.finishWrite(sessionId, progressWrite)");
    const watchdog = source.slice(source.indexOf("const watchdog = window.setTimeout"), source.indexOf("const finish =", source.indexOf("const watchdog = window.setTimeout")));
    expect(watchdog).not.toContain("finishWrite");
    expect(source).toContain("terminalProgressDiagnostics.receive(sessionId, batch.generation, batch.scrollbackEnd)");
    expect(source).toContain("repaintHold.depth + recoveryScreenOwners");
    expect(source).toContain("[sessionId, progressDiagnosticsEnabled]");
  });
});
