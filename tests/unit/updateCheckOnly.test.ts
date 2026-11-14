// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  downloadAndInstall: vi.fn(),
  relaunch: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: mocks.relaunch }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("DEV", false);
  mocks.downloadAndInstall.mockResolvedValue(undefined);
  mocks.relaunch.mockResolvedValue(undefined);
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
