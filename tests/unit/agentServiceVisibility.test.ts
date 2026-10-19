import { describe, expect, it } from "vitest";
import { LAUNCHABLE_AGENTS } from "../../src/lib/agentCatalog";
import { hasUnresolvedAgentServices, initializeAgentServiceVisibility, isAgentServiceVisible } from "../../src/lib/agentServiceVisibility";

describe("service visibility resolver (T1)", () => {
  it("honors explicit values before defaults and successful detection", () => {
    expect(isAgentServiceVisible("claude", { claude: false })).toBe(false);
    expect(isAgentServiceVisible("hermes", { hermes: true }, { status: "success", installed: {} })).toBe(true);
    expect(isAgentServiceVisible("hermes", { hermes: false }, { status: "success", installed: { hermes: true } })).toBe(false);
  });
  it("keeps unresolved Claude and Codex on even when not installed", () => {
    for (const target of ["claude", "codex"]) expect(isAgentServiceVisible(target, {}, { status: "success", installed: {} })).toBe(true);
  });
  it("preserves choices before detection and on failure", () => {
    for (const status of ["idle", "detecting", "failed"] as const) expect(isAgentServiceVisible("hermes", {}, { status })).toBe(true);
  });
  it("uses successful installation results for unresolved optional services", () => {
    expect(isAgentServiceVisible("hermes", {}, { status: "success", installed: { hermes: true } })).toBe(true);
    expect(isAgentServiceVisible("omp", {}, { status: "success", installed: { omp: false } })).toBe(false);
  });
});

describe("initial visibility persistence (T2)", () => {
  const detection = { status: "success" as const, installed: { hermes: true, grok: true } };
  it("fills catalog keys exactly once without overwriting user choices", () => {
    const saved = { grok: false, omp: true };
    const next = initializeAgentServiceVisibility(saved, detection, true)!;
    expect(next).toEqual(Object.fromEntries(LAUNCHABLE_AGENTS.map(({ target }) => [target, target in saved ? saved[target as keyof typeof saved] : ["claude", "codex", "hermes"].includes(target)])));
    expect(saved).toEqual({ grok: false, omp: true });
    expect(hasUnresolvedAgentServices(next)).toBe(false);
    expect(initializeAgentServiceVisibility(next, detection, true)).toBeNull();
  });
  it("never writes on failure, before success, or from a detached window", () => {
    for (const status of ["idle", "detecting", "failed"] as const) expect(initializeAgentServiceVisibility({}, { status }, true)).toBeNull();
    expect(initializeAgentServiceVisibility({}, detection, false)).toBeNull();
  });
});
