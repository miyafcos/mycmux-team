import { describe, expect, it } from "vitest";
import type { CliLiveLogin } from "../../src/lib/ipc";
import { switchRevertMessage, switchWasReverted } from "../../src/lib/switchRevertWatch";

function live(overrides: Partial<CliLiveLogin> = {}): CliLiveLogin {
  return {
    provider: "claude",
    present: true,
    email: null,
    identity_key: "target",
    plan: null,
    org_name: null,
    matched_profile_id: null,
    error: null,
    ...overrides,
  } as CliLiveLogin;
}

describe("switchWasReverted", () => {
  it("is quiet while the target is still the live login", () => {
    expect(switchWasReverted("claude", "target", [live()])).toBe(false);
  });

  it("reports a drift to another identity", () => {
    expect(switchWasReverted("claude", "target", [live({ identity_key: "other" })])).toBe(true);
  });

  it("only judges the provider that was switched", () => {
    const other = live({ provider: "codex", identity_key: "other" });
    expect(switchWasReverted("claude", "target", [other])).toBe(false);
  });

  it("stays quiet when the live login cannot be named", () => {
    expect(switchWasReverted("claude", "target", [live({ identity_key: null })])).toBe(false);
    expect(switchWasReverted("claude", "target", [live({ present: false })])).toBe(false);
    expect(switchWasReverted("claude", "target", [live({ error: "boom" })])).toBe(false);
    expect(switchWasReverted("claude", "target", [])).toBe(false);
  });

  it("stays quiet when the target itself has no identity", () => {
    expect(switchWasReverted("claude", null, [live({ identity_key: "other" })])).toBe(false);
  });
});

describe("switchRevertMessage", () => {
  it("names the account and points at running sessions", () => {
    const message = switchRevertMessage("someone@example.com");
    expect(message).toContain("someone@example.com");
    expect(message).toContain("実行中のセッション");
  });
});
