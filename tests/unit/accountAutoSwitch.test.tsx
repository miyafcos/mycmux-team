// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chooseAutoSwitch, eligibleTargets, AUTO_SWITCH_COOLDOWN_MS } from "../../src/lib/accountAutoSwitch";
import type { CliAccountProfile, CliLiveLogin, CliProvider, ProfileUsage } from "../../src/lib/ipc";

const mocks = vi.hoisted(() => ({ cli: {} as any, usage: {} as any, toast: vi.fn() }));
vi.mock("../../src/stores/cliAccountStore", () => ({ useCliAccountStore: { getState: () => mocks.cli, subscribe: () => () => undefined } }));
vi.mock("../../src/stores/usageStore", () => ({ useUsageStore: { getState: () => mocks.usage, subscribe: () => () => undefined } }));
vi.mock("../../src/stores/toastStore", () => ({ useToastStore: { getState: () => ({ pushToast: mocks.toast }) } }));
import { excludedTargetsFor, useAccountAutoSwitchStore as store } from "../../src/stores/accountAutoSwitchStore";
import { AutoSwitchCandidateCheckbox, AutoSwitchToggle } from "../../src/components/settings/AccountAutoSwitchSettings";
import { useAccountAutoSwitch } from "../../src/hooks/useAccountAutoSwitch";

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
function pick(rows = [row("a", 100), row("b", 20)], profiles = [profile("a"), profile("b")], login = live(), excluded: string[] = []) {
  return chooseAutoSwitch(login.provider, rows, profiles, [login], NOW, excluded);
}
beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  mocks.toast.mockClear();
  localStorage.clear();
  store.setState({ enabled: { claude: false, codex: false, grok: false },
    excludedTargets: { claude: [], codex: [], grok: [] }, attempts: {}, status: {} });
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

describe("switch target candidates", () => {
  it("never picks an account the user took out, even the least loaded one", () => {
    const rows = [row("a", 100), row("b", 5), row("c", 40)];
    const profiles = [profile("a"), profile("b"), profile("c")];
    expect(pick(rows, profiles)?.target?.id).toBe("b");
    expect(pick(rows, profiles, live(), ["b"])?.target?.id).toBe("c");
    // Everything taken out: the limit is still reported, with nowhere to go.
    const none = pick(rows, profiles, live(), ["b", "c"]);
    expect(none?.source.profile_id).toBe("a");
    expect(none?.target).toBeNull();
  });
  it("lists what a switch could land on before usage is known", () => {
    const profiles = [profile("a"), profile("b"), { ...profile("c"), needs_relogin: true },
      profile("d"), profile("x", "codex"), { ...profile("e"), identity_key: "a" }];
    const ids = (excluded: string[]) => eligibleTargets("claude", profiles, live(), excluded).map((p) => p.id);
    expect(ids([])).toEqual(["b", "d"]);
    expect(ids(["d"])).toEqual(["b"]);
    // Without a live login nothing is "the current account", so all picks count.
    expect(eligibleTargets("claude", profiles, undefined, []).map((p) => p.id)).toEqual(["a", "b", "d", "e"]);
  });
  it("persists the picks per provider and treats an old saved state as all candidates", () => {
    store.getState().setTargetIncluded("claude", "b", false);
    store.getState().setTargetIncluded("claude", "b", false);
    store.getState().setTargetIncluded("codex", "x", false);
    expect(store.getState().excludedTargets).toEqual({ claude: ["b"], codex: ["x"], grok: [] });
    const saved = JSON.parse(localStorage.getItem("mycmux-account-auto-switch")!);
    expect(saved.state.excludedTargets.claude).toEqual(["b"]);
    store.getState().setTargetIncluded("claude", "b", true);
    expect(store.getState().excludedTargets.claude).toEqual([]);
    // Written before the choice existed, or hand-edited into something else.
    expect(excludedTargetsFor({ excludedTargets: undefined as never }, "claude")).toEqual([]);
    expect(excludedTargetsFor({ excludedTargets: { claude: "b" } as never }, "claude")).toEqual([]);
  });
  it("switches to the next candidate when the best one is taken out", async () => {
    store.getState().setEnabled("claude", true);
    mocks.usage.accounts = [row("a", 100), row("b", 5), row("c", 40)];
    mocks.cli.profiles = [profile("a"), profile("b"), profile("c")];
    store.getState().setTargetIncluded("claude", "b", false);
    await store.getState().evaluate();
    expect(mocks.cli.switchTo).toHaveBeenCalledWith("claude", "c", expect.any(Function));
  });
  it("waits and says why when every other account is taken out", async () => {
    store.getState().setEnabled("claude", true);
    store.getState().setTargetIncluded("claude", "b", false);
    await store.getState().evaluate();
    expect(mocks.cli.switchTo).not.toHaveBeenCalled();
    expect(store.getState().enabled.claude).toBe(true);
    expect(store.getState().status.claude).toContain("切り替え先の候補");
  });
  it("cancels a queued switch when its target is taken out meanwhile", async () => {
    store.getState().setEnabled("claude", true);
    mocks.cli.switchTo.mockImplementation(async (_p: string, _id: string, guard: () => boolean) => {
      store.getState().setTargetIncluded("claude", "b", false);
      expect(guard()).toBe(false);
      return null;
    });
    await store.getState().evaluate();
    expect(store.getState().attempts.claude).toBeUndefined();
    // A cancellation is not a failure: the switch stays on.
    expect(store.getState().enabled.claude).toBe(true);
  });
  // The hook's evaluate() for a tick change lands while the switch it cancels
  // is still running. It must be replayed when that run ends, not wait for the
  // next poll (a minute away).
  it("moves on to the next candidate right after a queued switch is cancelled", async () => {
    store.getState().setEnabled("claude", true);
    mocks.usage.accounts = [row("a", 100), row("b", 5), row("c", 40)];
    mocks.cli.profiles = [profile("a"), profile("b"), profile("c")];
    const asked: string[] = [];
    mocks.cli.switchTo.mockImplementation(async (_p: string, id: string, guard: () => boolean) => {
      asked.push(id);
      if (id === "b") {
        store.getState().setTargetIncluded("claude", "b", false);
        await store.getState().evaluate();
      }
      return guard() ? { profile: profile(id), warnings: [] } : null;
    });
    await store.getState().evaluate();
    await flushTasks();
    expect(asked).toEqual(["b", "c"]);
    expect(store.getState().attempts.claude?.target).toBe("c");
  });
  it("says there is nowhere to go right after the last candidate is unticked mid-queue", async () => {
    store.getState().setEnabled("claude", true);
    mocks.cli.switchTo.mockImplementation(async (_p: string, _id: string, guard: () => boolean) => {
      store.getState().setTargetIncluded("claude", "b", false);
      await store.getState().evaluate();
      return guard() ? { profile: profile("b"), warnings: [] } : null;
    });
    await store.getState().evaluate();
    await flushTasks();
    expect(mocks.cli.switchTo).toHaveBeenCalledTimes(1);
    expect(store.getState().enabled.claude).toBe(true);
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("切り替え先の候補"), "warning");
  });
  // Six minutes pass either queued behind another provider's operation, or in
  // a switch (and its refresh) that is slow once started. Either way the five
  // minutes of rest must follow the finished switch.
  it.each(["queued", "slow"] as const)("keeps the cooldown after a switch that was %s for six minutes", async (where) => {
    let clock = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const refreshed = (rows: ProfileUsage[]) => rows.map((entry) => ({ ...entry, fetched_at: new Date(clock).toISOString() }));
    store.getState().setEnabled("claude", true);
    mocks.usage.accounts = [row("a", 100), row("b", 5), row("c", 40)];
    mocks.cli.profiles = [profile("a"), profile("b"), profile("c")];
    mocks.cli.switchTo.mockImplementation(async (_p: string, id: string, guard: () => boolean) => {
      if (where === "queued") {
        clock += 6 * 60_000;
        mocks.usage.accounts = refreshed(mocks.usage.accounts);
      }
      if (!guard()) return null;
      if (where === "slow") clock += 6 * 60_000;
      // Once switched, b is live and turns out to be at its limit as well. The
      // refresh that says so lands while this evaluation is still running.
      mocks.cli.live = [{ ...live(), identity_key: "b", matched_profile_id: "b" }];
      mocks.usage.accounts = refreshed([row("a", 100), row("b", 100), row("c", 10)]
        .map((entry) => ({ ...entry, is_active: entry.profile_id === "b" })));
      await store.getState().evaluate();
      return { profile: profile(id), warnings: [] };
    });
    await store.getState().evaluate();
    await flushTasks();
    expect(mocks.cli.switchTo).toHaveBeenCalledTimes(1);
    expect(store.getState().attempts.claude).toEqual({ source: "a", target: "b", at: NOW + 6 * 60_000 });
  });
  it("loads a state saved before candidates existed, or a damaged one, as all candidates", async () => {
    localStorage.setItem("mycmux-account-auto-switch", JSON.stringify({
      state: { enabled: { claude: true, codex: false, grok: false }, attempts: {} }, version: 0 }));
    await store.persist.rehydrate();
    expect(store.getState().enabled.claude).toBe(true);
    expect(store.getState().excludedTargets).toEqual({ claude: [], codex: [], grok: [] });
    localStorage.setItem("mycmux-account-auto-switch", JSON.stringify({
      state: { enabled: { claude: true }, excludedTargets: { claude: "b", codex: ["x", 3, null] } }, version: 0 }));
    await store.persist.rehydrate();
    expect(store.getState().excludedTargets).toEqual({ claude: [], codex: ["x"], grok: [] });
    store.getState().setTargetIncluded("claude", "b", false);
    expect(store.getState().excludedTargets).toEqual({ claude: ["b"], codex: ["x"], grok: [] });
  });
});

describe("re-evaluation triggers", () => {
  it("evaluates again when a switch or a candidate changes", async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const original = store.getState().evaluate;
    const evaluate = vi.fn(async () => {});
    store.setState({ evaluate });
    function Probe() {
      useAccountAutoSwitch(true);
      return null;
    }
    const host = document.createElement("div"); const root = createRoot(host);
    try {
      await act(async () => root.render(<Probe />));
      evaluate.mockClear();
      await act(async () => store.getState().setTargetIncluded("claude", "b", false));
      expect(evaluate).toHaveBeenCalledTimes(1);
      await act(async () => store.getState().setEnabled("codex", true));
      expect(evaluate).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => root.unmount());
      store.setState({ evaluate: original });
    }
  });
});

function flushTasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

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
  it("renders a switch per provider and a candidate tick per account", async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div"); const root = createRoot(host);
    const claude = [profile("a"), profile("b")];
    await act(async () => root.render(<>
      <AutoSwitchToggle provider="claude" profiles={claude} live={live()} />
      <AutoSwitchToggle provider="codex" profiles={[profile("x", "codex"), profile("y", "codex")]} live={live("codex")} />
      <AutoSwitchToggle provider="grok" profiles={[profile("g", "grok")]} live={undefined} />
      {claude.map((entry) => <AutoSwitchCandidateCheckbox key={entry.id} profile={entry} />)}
    </>));
    const switches = host.querySelectorAll<HTMLInputElement>('input[role="switch"]');
    expect(switches).toHaveLength(3);
    expect([...switches].every((input) => !input.checked)).toBe(true);
    expect(switches[0].getAttribute("aria-label")).toBe("Claude Code のアカウントを自動で切り替える");
    // One registered account has nowhere to switch to.
    expect(switches[2].disabled).toBe(true);
    expect(host.textContent).toContain("アカウントを 2 つ以上登録すると使えます。");
    await act(async () => switches[0].click());
    expect(store.getState().enabled.claude).toBe(true);
    expect(store.getState().enabled.codex).toBe(false);

    const ticks = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:not([role="switch"])');
    expect(ticks).toHaveLength(2);
    // Registered accounts start out as candidates.
    expect([...ticks].every((input) => input.checked)).toBe(true);
    expect(ticks[1].getAttribute("aria-label")).toBe("「b」を自動切り替えの候補にする");
    await act(async () => ticks[1].click());
    expect(store.getState().excludedTargets.claude).toEqual(["b"]);
    expect(ticks[1].checked).toBe(false);
    expect(host.textContent).toContain("切り替え先の候補がありません。");
    await act(async () => ticks[1].click());
    expect(store.getState().excludedTargets.claude).toEqual([]);
    expect(host.textContent).not.toContain("切り替え先の候補がありません。");
    await act(async () => root.unmount());
  });
});

it("does not auto-switch from a live token owner mismatch", () => {
  const source = row("a", 100);
  source.state = "error";
  source.error_code = "usage.error.live_token_foreign";
  source.token_owner_email = "x@example.test";
  expect(pick([source, row("b", 1)])).toBeNull();
});
