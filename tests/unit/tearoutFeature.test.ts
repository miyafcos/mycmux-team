import { describe, expect, it } from "vitest";
import { nativePaneTearoutEnabled, supportsNativePaneTearout, usesNativePaneShell } from "../../src/lib/tearout/feature";

describe("native pane tear-out switch", () => {
  it("keeps the legacy route when off and only opts in on Windows", () => {
    expect(nativePaneTearoutEnabled(false, "Win32")).toBe(false);
    expect(nativePaneTearoutEnabled(true, "Win32")).toBe(true);
    expect(nativePaneTearoutEnabled(true, "MacIntel")).toBe(false);
    expect(nativePaneTearoutEnabled(true, "Linux x86_64")).toBe(false);
    expect(supportsNativePaneTearout("MacIntel")).toBe(false);
  });
  it("exposes the common receiver in existing detached Windows windows only while opted in", () => {
    expect(usesNativePaneShell(false, true, true, "Win32")).toBe(true);
    expect(usesNativePaneShell(false, true, false, "Win32")).toBe(false);
    expect(usesNativePaneShell(false, true, true, "MacIntel")).toBe(false);
    expect(usesNativePaneShell(false, false, true, "Win32")).toBe(false);
  });
  it("retains the shell of newly created tear-out windows when the setting is turned off", () => {
    expect(usesNativePaneShell(true, true, false, "Win32")).toBe(true);
    expect(usesNativePaneShell(true, false, false, "Win32")).toBe(true);
  });
});
