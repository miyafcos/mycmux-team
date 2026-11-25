// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  downloadAndInstall: vi.fn(),
  relaunch: vi.fn(),
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: mocks.relaunch }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("DEV", false);
  mocks.downloadAndInstall.mockResolvedValue(undefined);
  mocks.relaunch.mockResolvedValue(undefined);
  let pending: { version: string; currentVersion: string } | null = null;
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command !== "update_restart_pending") return null;
    if (!pending && args?.installVersion) {
      await mocks.downloadAndInstall();
      pending = { version: args.installVersion, currentVersion: "1.0.0" };
    }
    return pending;
  });
  (await import("../../src/lib/windowContext")).setWindowRole(true);
});
afterEach(() => vi.unstubAllEnvs());

describe("check without installing", () => {
  it("only discovers an update until the user confirms a restart", async () => {
    mocks.check.mockResolvedValue({
      version: "1.1.0",
      currentVersion: "1.0.0",
      downloadAndInstall: mocks.downloadAndInstall,
      close: vi.fn(async () => {}),
    });
    const { runUpdateCheck } = await import("../../src/lib/forcedAutoUpdater");
    const result = await runUpdateCheck({ source: "manual" });
    expect(mocks.downloadAndInstall).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ phase: "available", updateInstalled: false, version: "1.1.0" });
  });

  it("continues to report the latest version when no update is returned", async () => {
    mocks.check.mockResolvedValue(null);
    const { runUpdateCheck } = await import("../../src/lib/forcedAutoUpdater");
    expect(await runUpdateCheck({ source: "manual" })).toMatchObject({
      phase: "latest",
      updateInstalled: false,
    });
  });
});


it("L6 retries only the relaunch after installation, including after checking again", async () => {
  const makeHandle = () => ({
    version: "1.1.0", currentVersion: "1.0.0", downloadAndInstall: mocks.downloadAndInstall,
    close: vi.fn(async () => {}),
  });
  mocks.check.mockImplementation(async () => makeHandle());
  mocks.relaunch.mockRejectedValueOnce(new Error("simulated relaunch failure"));
  const { runUpdateCheck, installAvailableUpdate } = await import("../../src/lib/forcedAutoUpdater");
  await runUpdateCheck({ source: "manual" });
  expect(await installAvailableUpdate()).toMatchObject({ phase: "error", version: "1.1.0" });
  await runUpdateCheck({ source: "manual" });
  expect(await installAvailableUpdate()).toMatchObject({ phase: "ready", updateInstalled: true, version: "1.1.0" });
  expect(mocks.downloadAndInstall).toHaveBeenCalledTimes(1);
  expect(mocks.relaunch).toHaveBeenCalledTimes(2);
});

it("L6 fix2 restarts an installed update once window B takes over from window A", async () => {
  let pending: { version: string; currentVersion: string } | null = null;
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command !== "update_restart_pending") return null;
    if (!pending && args?.installVersion) {
      await mocks.downloadAndInstall();
      pending = { version: args.installVersion, currentVersion: "1.0.0" };
    }
    return pending;
  });
  mocks.check.mockResolvedValue({
    version: "1.1.0", currentVersion: "1.0.0", downloadAndInstall: mocks.downloadAndInstall,
    close: vi.fn(async () => {}),
  });
  mocks.relaunch.mockRejectedValueOnce(new Error("simulated relaunch failure"));
  const a = await import("../../src/lib/forcedAutoUpdater");
  await a.runUpdateCheck();
  expect(await a.installAvailableUpdate()).toMatchObject({ phase: "error", updateInstalled: true });
  (await import("../../src/lib/windowContext")).setWindowRole(false);

  vi.resetModules();
  (await import("../../src/lib/windowContext")).setWindowRole(true);
  const b = await import("../../src/lib/forcedAutoUpdater");
  expect(b).not.toBe(a);
  await b.runUpdateCheck();
  expect(await b.installAvailableUpdate()).toMatchObject({ phase: "ready", updateInstalled: true });
  expect(mocks.downloadAndInstall).toHaveBeenCalledOnce();
  expect(mocks.relaunch).toHaveBeenCalledTimes(2);
  expect(mocks.check).toHaveBeenCalledOnce();
});

it("L6 fix3 carries an accepted install through loss of the requesting window", async () => {
  const selected = { version: "1.1.0", currentVersion: "1.0.0" };
  let pending: typeof selected | null = null;
  let legacyReservation = false;
  let finishDownload!: () => void;
  const download = new Promise<void>(resolve => { finishDownload = resolve; });
  let releaseLegacy!: () => void;
  const legacyReply = new Promise<void>(resolve => { releaseLegacy = resolve; });
  mocks.downloadAndInstall.mockImplementation(() => download);
  const legacyInstall = vi.fn(() => legacyReply);
  mocks.check.mockResolvedValue({ ...selected, downloadAndInstall: legacyInstall, close: vi.fn(async () => {}) });
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command !== "update_restart_pending") return null;
    if (args?.installVersion === selected.version) {
      await mocks.downloadAndInstall();
      pending = selected;
    } else if (args?.installing) {
      if (legacyReservation) throw new Error("an update is already installing");
      legacyReservation = true;
    } else if (args?.installed) {
      pending = args.installed;
    }
    return pending;
  });

  const a = await import("../../src/lib/forcedAutoUpdater");
  const roleA = await import("../../src/lib/windowContext");
  await a.runUpdateCheck();
  const fromA = a.installAvailableUpdate();
  await vi.waitFor(() => expect(mocks.downloadAndInstall.mock.calls.length + legacyInstall.mock.calls.length).toBe(1));
  roleA.setWindowRole(false);

  vi.resetModules();
  (await import("../../src/lib/windowContext")).setWindowRole(true);
  const b = await import("../../src/lib/forcedAutoUpdater");
  try {
    // The WebView that initiated the install no longer owns the restart.
    // Finish the native work and let the new owner read the result.
    finishDownload();
    await b.runUpdateCheck();
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(await b.installAvailableUpdate()).toMatchObject({ phase: "ready", updateInstalled: true });
    expect(mocks.downloadAndInstall).toHaveBeenCalledOnce();
    expect(mocks.relaunch).toHaveBeenCalledOnce();
  } finally {
    finishDownload();
    releaseLegacy();
    await fromA;
  }
});

it("L6 fix3 omits the plugin URL from discovery and installation warnings", async () => {
  const exception = "https://example.test/fixture?marker=private-path";
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.check.mockRejectedValueOnce(new Error(exception)).mockResolvedValue({
    version: "1.1.0", currentVersion: "1.0.0", downloadAndInstall: mocks.downloadAndInstall,
    close: vi.fn(async () => {}),
  });
  mocks.downloadAndInstall.mockRejectedValue(new Error(exception));
  const { installAvailableUpdate, runUpdateCheck } = await import("../../src/lib/forcedAutoUpdater");
  try {
    expect((await runUpdateCheck()).phase).toBe("error");
    expect((await runUpdateCheck()).phase).toBe("available");
    expect((await installAvailableUpdate()).phase).toBe("error");
    expect(warn).toHaveBeenCalledTimes(2);
    const argumentsLogged = warn.mock.calls.flat().map(value => String(value)).join(" ");
    expect(argumentsLogged).not.toContain(exception);
  } finally { warn.mockRestore(); }
});
