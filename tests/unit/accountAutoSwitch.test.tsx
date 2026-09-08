// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chooseAutoSwitch, AUTO_SWITCH_COOLDOWN_MS } from "../../src/lib/accountAutoSwitch";
import type { CliAccountProfile, CliLiveLogin, CliProvider, ProfileUsage } from "../../src/lib/ipc";

const mocks = vi.hoisted(() => ({ cli: {} as any, usage: {} as any, toast: vi.fn() }));
vi.mock("../../src/stores/cliAccountStore", () => ({ useCliAccountStore: { getState: () => mocks.cli } }));
vi.mock("../../src/stores/usageStore", () => ({ useUsageStore: { getState: () => mocks.usage } }));
vi.mock("../../src/stores/toastStore", () => ({ useToastStore: { getState: () => ({ pushToast: mocks.toast }) } }));
import { useAccountAutoSwitchStore as store } from "../../src/stores/accountAutoSwitchStore";
import { AccountAutoSwitchSettings } from "../../src/components/settings/AccountAutoSwitchSettings";

const NOW = Date.parse("2026-09-08T12:00:00Z");
const reset = "2026-09-08T15:00:00Z";
function profile(id: string, provider: CliProvider = "claude"): CliAccountProfile {
  return { id, provider, label: id, email: null, identity_key: id, plan: null, org_name: null,
    captured_at: "", last_switched_at: null, needs_relogin: false };
}
function row(id: string, pct: number, provider: CliProvider = "claude"): ProfileUsage {
  return { profile_id: id, provider, label: id, email: null, plan: null, registered: true,
    is_active: id === "a", needs_relogin: false, state: "ok", five_hour: { pct, resets_at: reset },
    seven_day: { pct: 10, resets_at: reset }, seven_day_sonnet: null, seven_day_opus: null,
    model_windows: [], error_code: null, retry_at: null, fetched_at: new Date(NOW).toISOString() };
}
function live(provider: CliProvider = "claude"): CliLiveLogin {
  return { provider, present: true, email: null, identity_key: "a", matched_profile_id: "a",
    plan: null, org_name: null, error: null };
}
function pick(rows = [row("a", 100), row("b", 20)], profiles = [profile("a"), profile("b")], login = live()) {
  return chooseAutoSwitch(login.provider, rows, profiles, [login], NOW);
}
beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  mocks.toast.mockClear();
  localStorage.clear();
  store.setState({ enabled: { claude: false, codex: false, grok: false }, attempts: {}, status: {} });
  mocks.usage = { accounts: [row("a", 100), row("b", 20)], lastError: null };
  mocks.cli = { profiles: [profile("a"), profile("b")], live: [live()], loading: false,
    fetchError: null, busyByProvider: { claude: null, codex: null, grok: null },
    fetch: vi.fn(async () => {}), switchTo: vi.fn(async (_provider, _target, guard) => {
      if (!guard()) return null;
      return { profile: profile("b"), warnings: [] };
    }) };
});

describe("automatic account selection", () => {
  it.each(["claude", "codex", "grok"] as const)("selects spare capacity for %s", (provider) => {
    expect(pick([row("a", 100, provider), row("b", 20, provider)],
      [profile("a", provider), profile("b", provider)], live(provider))?.target?.id).toBe("b");
  });
  it("chooses the lowest worst-window usage deterministically", () => {
    const rows = [row("a", 100), row("c", 10), row("b", 10)];
    expect(pick(rows, [profile("c"), profile("b"), profile("a")])?.target?.id).toBe("b");
  });
  it("requires a reached limit, not approaching or model-only limits", () => {
    const source = row("a", 99.9);
    source.seven_day_opus = { pct: 100, resets_at: reset };
    expect(pick([source, row("b", 1)])).toBeNull();
    source.seven_day!.pct = 100;
    expect(pick([source, row("b", 1)])?.target?.id).toBe("b");
  });
  it.each(["cooldown", "needs_relogin", "unsupported", "error", "wait_for_cli"] as const)("ignores %s rows", (state) => {
    const source = row("a", 100); source.state = state;
    expect(pick([source, row("b", 1)])).toBeNull();
    const target = row("b", 1); target.state = state;
    expect(pick([row("a", 100), target])?.target).toBeNull();
  });
  it.each(["2026-09-08T11:54:59Z", "invalid", "2026-09-08T12:01:00Z"])("rejects untrusted timestamps %s", (fetched_at) => {
    const source = row("a", 100); source.fetched_at = fetched_at;
    expect(pick([source, row("b", 1)])).toBeNull();
    const target = row("b", 1); target.fetched_at = fetched_at;
    expect(pick([row("a", 100), target])?.target).toBeNull();
  });
  it("rejects reset windows, NaN, missing corresponding limits, and exhausted targets", () => {
    for (const window of [null, { pct: NaN, resets_at: reset }, { pct: 100, resets_at: reset },
      { pct: 1, resets_at: "2026-09-08T11:00:00Z" }]) {
      const target = row("b", 1); target.five_hour = window;
      expect(pick([row("a", 100), target])?.target).toBeNull();
    }
  });
  it("excludes other providers, aliases of the same identity and relogin profiles", () => {
    for (const target of [{ ...profile("b"), needs_relogin: true },
      { ...profile("b"), identity_key: "a" }, profile("b", "codex")]) {
      expect(pick(undefined, [profile("a"), target])?.target).toBeNull();
    }
  });
  it("requires agreement with the live login", () => {
    expect(pick(undefined, undefined, { ...live(), error: "unavailable" })).toBeNull();
    expect(pick(undefined, undefined, { ...live(), identity_key: "other" })).toBeNull();
    expect(pick(undefined, undefined, { ...live(), matched_profile_id: null })).toBeNull();
  });
});

describe("automatic switching lifecycle", () => {
  it("is off by default and does not call IPC", async () => {
    await store.getState().evaluate();
    expect(mocks.cli.fetch).not.toHaveBeenCalled();
    expect(mocks.cli.switchTo).not.toHaveBeenCalled();
  });
  it("switches once, persists preferences and enforces cooldown", async () => {
    store.getState().setEnabled("claude", true);
    await store.getState().evaluate();
    await store.getState().evaluate();
    expect(mocks.cli.switchTo).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(localStorage.getItem("mycmux-account-auto-switch")!);
    expect(saved.state.enabled.claude).toBe(true);
    expect(saved.state.attempts.claude.source).toBe("a");
    expect(saved.state.status).toBeUndefined();
    store.getState().setEnabled("claude", false);
    store.getState().setEnabled("claude", true);
    await store.getState().evaluate();
    expect(mocks.cli.switchTo).toHaveBeenCalledTimes(1);
  });
  it("waits and notifies once when no eligible target exists, then recovers", async () => {
    store.getState().setEnabled("claude", true);
    mocks.usage.accounts[1].five_hour.pct = 100;
    await store.getState().evaluate(); await store.getState().evaluate();
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(mocks.cli.switchTo).not.toHaveBeenCalled();
    mocks.usage.accounts[1].five_hour.pct = 0;
    await store.getState().evaluate();
    expect(mocks.cli.switchTo).toHaveBeenCalledTimes(1);
  });
  it("does nothing when usage fetch failed or another operation is busy", async () => {
    store.getState().setEnabled("claude", true);
    mocks.usage.lastError = "offline";
    await store.getState().evaluate();
    mocks.usage.lastError = null; mocks.cli.busyByProvider.claude = "login";
    await store.getState().evaluate();
    expect(mocks.cli.switchTo).not.toHaveBeenCalled();
  });
  it("deduplicates overlapping evaluations and cancels when disabled during refresh", async () => {
    store.getState().setEnabled("claude", true);
    let release!: () => void;
    mocks.cli.fetch.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const pending = store.getState().evaluate();
    await store.getState().evaluate();
    expect(mocks.cli.fetch).toHaveBeenCalledTimes(1);
    store.getState().setEnabled("claude", false);
    release(); await pending;
    expect(mocks.cli.switchTo).not.toHaveBeenCalled();
  });
  it("cancels a queued switch after opt-out", async () => {
    store.getState().setEnabled("claude", true);
    mocks.cli.switchTo.mockImplementation(async (_p: string, _id: string, guard: () => boolean) => {
      store.getState().setEnabled("claude", false);
      expect(guard()).toBe(false);
      return null;
    });
    await store.getState().evaluate();
    expect(store.getState().attempts.claude).toBeUndefined();
  });
  it("rechecks identity after refresh", async () => {
    store.getState().setEnabled("claude", true);
    mocks.cli.fetch.mockImplementation(async () => { mocks.cli.live[0].matched_profile_id = "b"; });
    await store.getState().evaluate();
    expect(mocks.cli.switchTo).not.toHaveBeenCalled();
  });
  it.each([null, { profile: profile("b"), warnings: ["identity mismatch"] }])("disables on failure or warning", async (result) => {
    store.getState().setEnabled("claude", true);
    mocks.cli.switchTo.mockImplementation(async (_p: string, _id: string, guard: () => boolean) => {
      guard(); return result;
    });
    await store.getState().evaluate();
    expect(store.getState().enabled.claude).toBe(false);
  });
  it("stops when an exhausted source becomes active again instead of looping", async () => {
    store.getState().setEnabled("claude", true);
    store.setState({ attempts: { claude: { source: "a", target: "b", at: NOW - AUTO_SWITCH_COOLDOWN_MS } } });
    await store.getState().evaluate();
    expect(store.getState().enabled.claude).toBe(false);
    expect(mocks.cli.switchTo).not.toHaveBeenCalled();
  });
  it("renders three operable settings switches with the session limitation", async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div"); const root = createRoot(host);
    await act(async () => root.render(<AccountAutoSwitchSettings />));
    const switches = host.querySelectorAll<HTMLInputElement>('input[role="switch"]');
    expect(switches).toHaveLength(3);
    expect([...switches].every((input) => !input.checked)).toBe(true);
    await act(async () => switches[0].click());
    expect(store.getState().enabled.claude).toBe(true);
    expect(store.getState().enabled.codex).toBe(false);
    expect(host.textContent).toContain("新しく起動するセッションから反映");
    await act(async () => root.unmount());
  });
});
