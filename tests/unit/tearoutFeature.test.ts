// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { nativePaneTearoutEnabled, supportsNativePaneTearout, usesNativePaneShell } from "../../src/lib/tearout/feature";

describe("native pane tear-out switch", () => {
  it("keeps the legacy route when off and requires explicit Mac consent and retains the Windows route", () => {
    expect(nativePaneTearoutEnabled(false, "Win32")).toBe(false);
    expect(nativePaneTearoutEnabled(true, "Win32")).toBe(true);
    // The Mac follows its own switch (on by default since 0.83.0), not the Windows one.
    expect(nativePaneTearoutEnabled(true, "MacIntel", false)).toBe(false);
    expect(nativePaneTearoutEnabled(true, "Linux x86_64")).toBe(false);
    expect(supportsNativePaneTearout("MacIntel")).toBe(true);
    expect(nativePaneTearoutEnabled(true, "MacIntel", true)).toBe(true);
    expect(nativePaneTearoutEnabled(false, "MacIntel", true)).toBe(false);
  });
  it("exposes the common receiver in existing detached Windows windows only while opted in", () => {
    expect(usesNativePaneShell(false, true, true, "Win32")).toBe(true);
    expect(usesNativePaneShell(false, true, false, "Win32")).toBe(false);
    expect(usesNativePaneShell(false, true, true, "MacIntel", false)).toBe(false);
    expect(usesNativePaneShell(false, true, true, "MacIntel", true)).toBe(true);
    expect(usesNativePaneShell(false, false, true, "Win32")).toBe(false);
  });
  it("retains the shell of newly created tear-out windows when the setting is turned off", () => {
    expect(usesNativePaneShell(true, true, false, "Win32")).toBe(true);
    expect(usesNativePaneShell(true, false, false, "Win32")).toBe(true);
  });
});
