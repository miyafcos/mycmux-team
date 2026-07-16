import { describe, expect, it } from "vitest";
import {
  migratePersistedSettings,
  resolveDefaultTerminalRenderer,
  SETTINGS_STORE_VERSION,
} from "../../src/stores/settingsMigration";

describe("settings persistence migration", () => {
  it("defaults the renderer to DOM on every platform", () => {
    expect(resolveDefaultTerminalRenderer()).toBe("dom");
    expect(migratePersistedSettings(
      { notificationsEnabled: true },
      0,
      "Macintosh; Intel Mac OS X",
    )).toEqual({
      terminalRenderer: "dom",
      notificationsEnabled: true,
    });
  });

  it("carries a legacy DOM preference into the renamed setting", () => {
    expect(migratePersistedSettings(
      { useWebglRenderer: false, notificationsEnabled: true },
      0,
      "Windows NT 10.0",
    )).toEqual({
      terminalRenderer: "dom",
      notificationsEnabled: true,
    });
  });

  it("keeps an explicit legacy WebGL choice on Windows", () => {
    expect(migratePersistedSettings(
      { useWebglRenderer: true, notificationsEnabled: true },
      0,
      "Windows NT 10.0",
    )).toEqual({
      terminalRenderer: "webgl",
      notificationsEnabled: true,
    });
  });

  it("keeps an explicit legacy WebGL choice outside Windows", () => {
    expect(migratePersistedSettings(
      { useWebglRenderer: true, notificationsEnabled: true },
      0,
      "Macintosh; Intel Mac OS X",
    )).toEqual({
      terminalRenderer: "webgl",
      notificationsEnabled: true,
    });
  });

  it("restores the Windows DOM safety default from a version 1 WebGL state", () => {
    expect(migratePersistedSettings(
      { terminalRenderer: "webgl", buddyEnabled: true },
      1,
      "Windows NT 10.0",
    )).toEqual({
      terminalRenderer: "dom",
      buddyEnabled: true,
    });
  });

  it("resets the old non-Windows WebGL default carried through version 2", () => {
    expect(migratePersistedSettings(
      { terminalRenderer: "webgl", buddyEnabled: true },
      2,
      "Macintosh; Intel Mac OS X",
    )).toEqual({
      terminalRenderer: "dom",
      buddyEnabled: true,
    });
  });

  it("keeps a post-version-2 WebGL choice on Windows", () => {
    expect(migratePersistedSettings(
      { terminalRenderer: "webgl", buddyEnabled: true },
      2,
      "Windows NT 10.0",
    )).toEqual({
      terminalRenderer: "webgl",
      buddyEnabled: true,
    });
  });

  it("preserves an explicit renderer choice at the current version", () => {
    const persisted = { terminalRenderer: "webgl", buddyEnabled: true };
    expect(migratePersistedSettings(
      persisted,
      SETTINGS_STORE_VERSION,
      "Macintosh; Intel Mac OS X",
    )).toBe(persisted);
  });
});
