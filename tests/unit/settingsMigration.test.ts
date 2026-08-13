import { describe, expect, it } from "vitest";
import {
  migratePersistedSettings,
  resolveDefaultTerminalRenderer,
  resolveEffectiveTerminalRenderer,
  SETTINGS_STORE_VERSION,
} from "../../src/stores/settingsMigration";

describe("settings persistence migration", () => {
  it("defaults the renderer to auto on every platform", () => {
    expect(resolveDefaultTerminalRenderer()).toBe("auto");
    expect(migratePersistedSettings(
      { notificationsEnabled: true },
      0,
      "Macintosh; Intel Mac OS X",
    )).toMatchObject({
      terminalRenderer: "auto",
      notificationsEnabled: true,
    });
  });

  it("migrates a legacy DOM preference to auto", () => {
    expect(migratePersistedSettings(
      { useWebglRenderer: false, notificationsEnabled: true },
      0,
      "Windows NT 10.0",
    )).toMatchObject({
      terminalRenderer: "auto",
      notificationsEnabled: true,
    });
  });

  it("keeps an explicit legacy WebGL choice on Windows", () => {
    expect(migratePersistedSettings(
      { useWebglRenderer: true, notificationsEnabled: true },
      0,
      "Windows NT 10.0",
    )).toMatchObject({
      terminalRenderer: "webgl",
      notificationsEnabled: true,
    });
  });

  it("keeps an explicit legacy WebGL choice outside Windows", () => {
    expect(migratePersistedSettings(
      { useWebglRenderer: true, notificationsEnabled: true },
      0,
      "Macintosh; Intel Mac OS X",
    )).toMatchObject({
      terminalRenderer: "webgl",
      notificationsEnabled: true,
    });
  });

  it("migrates the Windows safety reset from version 1 to auto", () => {
    expect(migratePersistedSettings(
      { terminalRenderer: "webgl", notificationsEnabled: true },
      1,
      "Windows NT 10.0",
    )).toMatchObject({
      terminalRenderer: "auto",
      notificationsEnabled: true,
    });
  });

  it("migrates the non-Windows safety reset from version 2 to auto", () => {
    expect(migratePersistedSettings(
      { terminalRenderer: "webgl", notificationsEnabled: true },
      2,
      "Macintosh; Intel Mac OS X",
    )).toMatchObject({
      terminalRenderer: "auto",
      notificationsEnabled: true,
    });
  });

  it("keeps a post-version-2 WebGL choice on Windows", () => {
    expect(migratePersistedSettings(
      { terminalRenderer: "webgl", notificationsEnabled: true },
      2,
      "Windows NT 10.0",
    )).toMatchObject({
      terminalRenderer: "webgl",
      notificationsEnabled: true,
    });
  });

  it("preserves an explicit renderer choice at the current version", () => {
    const persisted = { terminalRenderer: "webgl", notificationsEnabled: true };
    expect(migratePersistedSettings(
      persisted,
      SETTINGS_STORE_VERSION,
      "Macintosh; Intel Mac OS X",
    )).toBe(persisted);
  });

  it("migrates a version 3 DOM renderer to auto", () => {
    expect(migratePersistedSettings(
      { terminalRenderer: "dom", notificationsEnabled: true },
      3,
    )).toMatchObject({
      terminalRenderer: "auto",
      notificationsEnabled: true,
    });
  });

  it("preserves a version 3 WebGL renderer", () => {
    expect(migratePersistedSettings(
      { terminalRenderer: "webgl", notificationsEnabled: true },
      3,
    )).toMatchObject({
      terminalRenderer: "webgl",
      notificationsEnabled: true,
    });
  });

  it("defaults an invalid version 3 renderer to auto", () => {
    expect(migratePersistedSettings(
      { terminalRenderer: "canvas", notificationsEnabled: true },
      3,
    )).toMatchObject({
      terminalRenderer: "auto",
      notificationsEnabled: true,
    });
  });

  it.each([5, 6])("does not migrate settings at version %i", (version) => {
    const persisted = { terminalRenderer: "dom", notificationsEnabled: true };
    expect(migratePersistedSettings(persisted, version)).toBe(persisted);
  });

  it("adds valid watchdog defaults in version 5", () => {
    expect(migratePersistedSettings({ notificationsEnabled: true }, 4)).toMatchObject({
      dispatchWatchdogEnabled: true,
      dispatchWatchdogIntervalMinutes: 10,
      dispatchStallMinutes: 45,
      dispatchWatchdogNotify: true,
    });
  });
});

describe("effective terminal renderer", () => {
  it.each([
    ["webgl", false, 1, "webgl"],
    ["webgl", false, 0.99, "webgl"],
    ["webgl", true, 1, "webgl"],
    ["webgl", true, 0.99, "webgl"],
    ["dom", false, 1, "dom"],
    ["dom", false, 0.99, "dom"],
    ["dom", true, 1, "dom"],
    ["dom", true, 0.99, "dom"],
    ["auto", false, 1, "webgl"],
    ["auto", false, 0.99, "dom"],
    ["auto", true, 1, "dom"],
    ["auto", true, 0.99, "dom"],
  ] as const)(
    "%s with media=%s and opacity=%s resolves to %s",
    (setting, mediaBackgroundActive, terminalOpacity, expected) => {
      expect(resolveEffectiveTerminalRenderer(
        setting,
        mediaBackgroundActive,
        terminalOpacity,
      )).toBe(expected);
    },
  );
});
