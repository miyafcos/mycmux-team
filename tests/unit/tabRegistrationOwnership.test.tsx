// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), notify: new Set<() => void>(), subscribe: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: () => void) => {
    if (name === "tab-account-evidence-updated") {
      await mocks.subscribe();
      mocks.notify.add(handler);
    }
    return () => { mocks.notify.delete(handler); };
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));

import WorkspaceSetup from "../../src/components/setup/WorkspaceSetup";
import { setupStrings } from "../../src/components/setup/setupStrings";
import { launcherStrings } from "../../src/components/workspace/launcherStrings";
import { useUiStore } from "../../src/stores/uiStore";
import { canApplyLaunchAccountCheck } from "../../src/lib/tabAccounts";
import { registerAccountManagementSettings } from "../../src/lib/mainDashboardRequests";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let homes: Array<{ provider: string; profile_id: string; state: string }>;
const profiles = ["codex", "grok"].flatMap(provider => ["a", "b"].map(id => ({
  id: provider + "-" + id, provider, label: provider + " " + id,
})));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.subscribe.mockReset().mockResolvedValue(undefined);
  useUiStore.getState().clearRequestedSettingsTab();
  homes = profiles.filter(profile => profile.id.endsWith("-a"))
    .map(profile => ({ provider: profile.provider, profile_id: profile.id, state: "ready" }));
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "list_cli_accounts") return { profiles };
    if (command === "list_cli_account_homes") return [...homes];
    if (command === "get_cli_launch_tokens") return [];
    return null;
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function selectProvider(slot: number, provider: string) {
  const select = host.querySelectorAll<HTMLSelectElement>("select:not([aria-label])")[slot];
  await act(async () => {
    select.value = provider;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
function button(label: string, scope: ParentNode = host) {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === label);
  expect(found, label).toBeDefined();
  return found!;
}
async function click(label: string, scope?: ParentNode) { await act(async () => button(label, scope).click()); }
async function changed() { await act(async () => { for (const notify of mocks.notify) notify(); }); }
const accountRows = () => [...host.querySelectorAll<HTMLElement>("[data-launch-account-row]")];

describe("shared launch account check", () => {
  const started = {
    selected: [{ slot: 0, target: "grok", account: "grok-a" }],
    listRead: new AbortController().signal,
    draft: { name: "Original draft" },
  };

  it("uses the result while all three references still match", () => {
    expect(canApplyLaunchAccountCheck(started, { ...started })).toBe(true);
  });

  it.each([
    ["selected ID", { selected: [{ slot: 0, target: "grok", account: "grok-b" }] }],
    ["list read", { listRead: new AbortController().signal }],
    ["draft version", { draft: { name: "Updated draft" } }],
  ] as const)("discards the result when only the %s changes", (_field, change) => {
    expect(canApplyLaunchAccountCheck(started, { ...started, ...change })).toBe(false);
  });
});

describe("saved account choices in workspace setup", () => {
  it("rereads simultaneous saves in both slots without replacing the explicit choices", async () => {
    const stopSettings = registerAccountManagementSettings();
    try {
      const onLaunch = vi.fn();
      await act(async () => root.render(<WorkspaceSetup onLaunch={onLaunch} onCancel={() => {}} />));
      await click("2 Columns");
      await selectProvider(0, "codex");
      await selectProvider(1, "grok");
      const [codex, grok] = accountRows();
      await click("codex a", codex);
      await click("grok a", grok);
      await click(launcherStrings.accountManagement, codex);
      expect(useUiStore.getState().requestedAccountProvider).toBe("codex");
      await click(launcherStrings.accountManagement, grok);
      expect(useUiStore.getState().requestedAccountProvider).toBe("grok");
      homes = profiles.map(profile => ({ provider: profile.provider, profile_id: profile.id, state: "ready" }));
      await changed();
      expect(button("codex b", codex).getAttribute("aria-pressed")).toBe("false");
      expect(button("grok b", grok).getAttribute("aria-pressed")).toBe("false");
      await click(setupStrings.launch);
      expect(onLaunch.mock.calls[0][0].paneSpecs).toMatchObject({
        0: { account: "codex-a" }, 1: { account: "grok-a" },
      });
      expect(mocks.invoke.mock.calls.map(call => call[0])).not.toContain("begin_cli_login");
    } finally {
      stopSettings();
    }
  });

  it("ignores an older list response after a saved-list notification", async () => {
    const onLaunch = vi.fn();
    const existing = [...homes];
    let resolveOld!: (old: typeof homes) => void;
    mocks.invoke.mockImplementationOnce(async () => ({ profiles }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    await act(async () => root.render(<WorkspaceSetup onLaunch={onLaunch} onCancel={() => {}} />));
    await selectProvider(0, "grok");
    homes.push({ provider: "grok", profile_id: "grok-b", state: "ready" });
    await changed();
    const row = accountRows()[0];
    expect(button("grok b", row).getAttribute("aria-pressed")).toBe("false");
    await act(async () => resolveOld(existing));
    expect(button("grok b", row)).toBeDefined();
    expect(button(launcherStrings.specDefault, row).getAttribute("aria-pressed")).toBe("true");
  });
});

it("stops opening both slots when a selected home is removed during the other slot check", async () => {
  const onLaunch = vi.fn();
  await act(async () => root.render(<WorkspaceSetup onLaunch={onLaunch} onCancel={() => {}} />));
  await click("2 Columns");
  await selectProvider(0, "codex");
  await selectProvider(1, "grok");
  const [codex, grok] = accountRows();
  await click("codex a", codex);
  await click("grok a", grok);
  const oldHomes = [...homes];
  let resolveOtherSlot!: (value: typeof homes) => void;
  const read = mocks.invoke.getMockImplementation()!;
  const requests = vi.fn()
    .mockResolvedValueOnce(oldHomes)
    .mockImplementationOnce(() => new Promise(resolve => { resolveOtherSlot = resolve; }));
  mocks.invoke.mockImplementation((command: string) => command === "list_cli_account_homes" ? requests() : read(command));
  await click(setupStrings.launch);
  expect(requests).toHaveBeenCalled();
  homes = homes.filter(home => home.provider !== "codex");
  expect(resolveOtherSlot).toBeDefined();
  mocks.invoke.mockImplementation(read);
  await changed();
  expect(codex.textContent).not.toContain("codex a");
  await act(async () => resolveOtherSlot(oldHomes));
  expect(onLaunch).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("選び直して");
  await click(launcherStrings.specDefault, codex);
  await click(setupStrings.launch);
  expect(onLaunch.mock.calls[0][0].paneSpecs).toMatchObject({ 0: { account: "" }, 1: { account: "grok-a" } });
});

async function holdSelectedGrokHomeCheck() {
  const onLaunch = vi.fn();
  await act(async () => root.render(<WorkspaceSetup onLaunch={onLaunch} onCancel={() => {}} />));
  await selectProvider(0, "grok");
  await click("grok a");
  const oldHomes = [...homes];
  let resolveCheck!: (result: typeof homes) => void;
  const read = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command: string) => command === "list_cli_account_homes"
    ? new Promise(resolve => { resolveCheck = resolve; })
    : read(command));
  await click(setupStrings.launch);
  expect(resolveCheck).toBeDefined();
  mocks.invoke.mockImplementation(read);
  return { onLaunch, resolve: () => resolveCheck(oldHomes) };
}

it("rejects a delayed workspace check after window focus reads a removed home", async () => {
  const check = await holdSelectedGrokHomeCheck();
  homes = homes.filter(home => home.provider !== "grok");
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(accountRows()[0].textContent).not.toContain("grok a");
  await act(async () => check.resolve());
  expect(check.onLaunch).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("選び直して");
});

it("lets default launch immediately after changing a selection while its check is pending", async () => {
  const check = await holdSelectedGrokHomeCheck();
  homes = homes.filter(home => home.provider !== "grok");
  await changed();
  expect(accountRows()[0].textContent).not.toContain("grok a");
  await click(launcherStrings.specDefault);
  expect(button(launcherStrings.specDefault).getAttribute("aria-pressed")).toBe("true");
  expect(button(setupStrings.launch).disabled).toBe(false);
  await click(setupStrings.launch);
  expect(check.onLaunch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    paneSpecs: { 0: { target: "grok", account: "" } },
  }));
  await act(async () => check.resolve());
  expect(check.onLaunch).toHaveBeenCalledTimes(1);
});

it("keeps the newer explicit selection checking when a superseded home read returns", async () => {
  const older = await holdSelectedGrokHomeCheck();
  homes = [...homes.filter(home => home.provider !== "grok"), { provider: "grok", profile_id: "grok-b", state: "ready" }];
  await changed();
  await click("grok b");
  const read = mocks.invoke.getMockImplementation()!;
  let finishNewer!: (result: typeof homes) => void;
  mocks.invoke.mockImplementation((command: string) => command === "list_cli_account_homes"
    ? new Promise(resolve => { finishNewer = resolve; })
    : read(command));
  await click(setupStrings.launch);
  expect(finishNewer).toBeDefined();
  await act(async () => older.resolve());
  expect(button(setupStrings.launch).disabled).toBe(true);
  expect(older.onLaunch).not.toHaveBeenCalled();
  await act(async () => finishNewer(homes));
  expect(older.onLaunch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    paneSpecs: { 0: { target: "grok", account: "grok-b" } },
  }));
});

const providers = ["claude", "codex", "grok"] as const;
const sharedProviderCases = providers.flatMap(provider =>
  (provider === "claude" ? [true] : [false, true]).flatMap(ready =>
    [false, true].map(reverse => ({ provider, ready, reverse }))));

function installSameProviderFixture(provider: typeof providers[number]) {
  const initialId = `${provider}-initial`;
  const savedId = `${provider}-saved`;
  const entries = [{ id: initialId, provider, label: "Initial account" }, { id: savedId, provider, label: "Saved account" }];
  const responses: Array<() => void> = [];
  let settingsSaved = false;
  let delayProfileReads = false;
  mocks.invoke.mockImplementation((command: string) => {
    if (command === "list_cli_accounts") {
      if (!delayProfileReads) return Promise.resolve({ profiles: entries });
      return new Promise(resolve => responses.push(() => resolve({ profiles: entries })));
    }
    const ids = settingsSaved ? [initialId, savedId] : [initialId];
    if (command === "get_cli_launch_tokens") {
      return Promise.resolve(ids.map(profile_id => ({ profile_id, expires_at: "2099-01-01T00:00:00Z" })));
    }
    if (command === "list_cli_account_homes") {
      return Promise.resolve(ids.map(profile_id => ({ profile_id, provider, state: "ready" })));
    }
    return Promise.resolve(null);
  });
  return {
    initialId,
    responses,
    save: (ready = true) => { settingsSaved = ready; },
    delayReads: (delay: boolean) => { delayProfileReads = delay; },
  };
}

it.each(sharedProviderCases)("keeps separate $provider choices after ready=$ready with reversed reads=$reverse", async ({ provider, ready, reverse }) => {
  const fixture = installSameProviderFixture(provider);
  const onLaunch = vi.fn();
  await act(async () => root.render(<WorkspaceSetup onLaunch={onLaunch} onCancel={() => {}} />));
  await click("2 Columns");
  await selectProvider(0, provider);
  await selectProvider(1, provider);
  const [first, second] = accountRows();
  await click("Initial account", first);
  const focused = button(launcherStrings.specDefault, second);
  await act(async () => focused.focus());

  fixture.save(ready);
  fixture.delayReads(true);
  await changed();
  expect(fixture.responses).toHaveLength(2);
  fixture.delayReads(false);
  const order = reverse ? [...fixture.responses].reverse() : fixture.responses;
  for (const read of order) await act(async () => read());

  for (const row of [first, second]) expect(row.textContent?.includes("Saved account")).toBe(ready);
  expect(button("Initial account", first).getAttribute("aria-pressed")).toBe("true");
  expect(focused.getAttribute("aria-pressed")).toBe("true");
  expect(document.activeElement).toBe(focused);
  await click(setupStrings.launch);
  expect(onLaunch.mock.calls[0][0].paneSpecs).toMatchObject({
    0: { target: provider, account: fixture.initialId }, 1: { target: provider },
  });
  expect(onLaunch.mock.calls[0][0].paneSpecs[1].account).toBeUndefined();
});

it.each(providers)("reads the saved %s choice after fully closing and reopening workspace creation", async provider => {
  const fixture = installSameProviderFixture(provider);
  const onLaunch = vi.fn();
  const render = (open: boolean) => <>
    <button type="button">Outside field</button>
    {open && <WorkspaceSetup onLaunch={onLaunch} onCancel={() => {}} />}
  </>;
  await act(async () => root.render(render(true)));
  await selectProvider(0, provider);
  await click("Initial account");
  await act(async () => root.render(render(false)));
  expect(accountRows()).toHaveLength(0);
  const focused = button("Outside field");
  await act(async () => focused.focus());
  fixture.save();
  await changed();
  await act(async () => root.render(render(true)));
  await selectProvider(0, provider);
  const row = accountRows()[0];
  expect(button("Saved account", row).getAttribute("aria-pressed")).toBe("false");
  expect(button(launcherStrings.specDefault, row).getAttribute("aria-pressed")).toBe("true");
  expect(document.activeElement).toBe(focused);
  expect(row.querySelector("[data-claude-setup-token]")).toBeNull();
  await click(setupStrings.launch);
  expect(onLaunch.mock.calls[0][0].paneSpecs[0]).toEqual({ target: provider });
});

describe("L12b FIX5 workspace account checks", () => {
  it.each(["only slot fails", "second slot fails"] as const)(
    "refuses explicit Grok creation when the %s to subscribe", async scenario => {
      const onLaunch = vi.fn();
      await act(async () => root.render(<WorkspaceSetup onLaunch={onLaunch} onCancel={() => {}} />));
      if (scenario === "second slot fails") {
        await click("2 Columns");
        await selectProvider(0, "grok");
        await click("grok a", accountRows()[0]);
      }
      mocks.subscribe.mockRejectedValueOnce(new Error("fixture subscription failed"));
      const slot = scenario === "second slot fails" ? 1 : 0;
      await selectProvider(slot, "grok");
      await click("grok a", accountRows()[slot]);
      expect(mocks.notify.size).toBe(slot);
      const oldHomes = [...homes];
      const read = mocks.invoke.getMockImplementation()!;
      const completions: Array<(result: typeof homes) => void> = [];
      mocks.invoke.mockImplementation((command: string) => command === "list_cli_account_homes"
        ? new Promise(resolve => completions.push(resolve))
        : read(command));
      await click(setupStrings.launch);
      homes = [];
      mocks.invoke.mockImplementation(read);
      if (slot === 0) await changed();
      await act(async () => completions.forEach(resolve => resolve(oldHomes)));
      expect(onLaunch).not.toHaveBeenCalled();
      expect(host.querySelector('[role="alert"]')?.textContent).toContain("アカウントの一覧を読めませんでした");

      for (const row of accountRows()) await click(launcherStrings.specDefault, row);
      await click(setupStrings.launch);
      expect(onLaunch).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["available slot first", "removed slot first", "old check first", "both slots available"] as const)(
    "keeps the correct refusal after a list read with %s", async order => {
      const onLaunch = vi.fn();
      const single = order === "old check first";
      const available = order === "both slots available";
      await act(async () => root.render(<WorkspaceSetup onLaunch={onLaunch} onCancel={() => {}} />));
      if (!single) {
        await click("2 Columns");
        await selectProvider(0, "codex");
        await click("codex a", accountRows()[0]);
      }
      await selectProvider(single ? 0 : 1, "grok");
      await click("grok a", accountRows().at(-1)!);
      const oldHomes = [...homes];
      const read = mocks.invoke.getMockImplementation()!;
      const completions: Array<(result: typeof homes) => void> = [];
      mocks.invoke.mockImplementation((command: string) => command === "list_cli_account_homes"
        ? new Promise(resolve => completions.push(resolve))
        : read(command));

      await click(setupStrings.launch);
      await changed();
      const count = single ? 1 : 2;
      expect(completions).toHaveLength(count * 2);
      const finishCheck = () => act(async () => completions.slice(0, count).forEach(resolve => resolve(oldHomes)));
      if (!available) homes = homes.filter(home => home.provider !== "grok");
      if (single) await finishCheck();
      const display = completions.slice(count);
      if (order === "removed slot first") display.reverse();
      for (const resolve of display) await act(async () => resolve(homes));
      if (!single) await finishCheck();
      expect(onLaunch).not.toHaveBeenCalled();
      if (available) {
        expect(host.querySelector('[role="alert"]')).toBeNull();
        mocks.invoke.mockImplementation(read);
        await click(setupStrings.launch);
        expect(onLaunch).toHaveBeenCalledTimes(1);
      } else {
        expect(accountRows().at(-1)!.textContent).not.toContain("grok a");
        expect(host.querySelector('[role="alert"]')?.textContent).toBe("選んだアカウントを使えません。選び直してください。");
      }
    },
  );
});

describe("L12b FIX6 setup list results", () => {
  it.each(["notice first", "notice last"] as const)(
    "opens only after the covered setup's current subscribed list is displayed (%s)", async order => {
      const onLaunch = vi.fn();
      const render = (covered: boolean) => act(async () => root.render(
        <WorkspaceSetup covered={covered} onLaunch={onLaunch} onCancel={() => {}} />,
      ));
      await render(false);
      await selectProvider(0, "grok");
      await click("grok a", accountRows()[0]);
      const oldHomes = [...homes];
      await render(true);
      expect(mocks.notify.size).toBe(0);

      let finishInitial!: (value: typeof homes) => void;
      const read = mocks.invoke.getMockImplementation()!;
      const heldReads = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishInitial = resolve; }));
      mocks.invoke.mockImplementation((command: string) => command === "list_cli_account_homes" ? heldReads() : read(command));
      await render(false);
      expect(finishInitial).toBeTypeOf("function");
      expect(button("grok a", accountRows()[0]).getAttribute("aria-pressed")).toBe("true");

      let finishOldCheck: ((value: typeof homes) => void) | undefined;
      heldReads.mockImplementationOnce(() => new Promise(resolve => { finishOldCheck = resolve; }));
      await click(setupStrings.launch);
      const blockReason = host.querySelector('[role="alert"]')?.textContent;
      homes = [];
      mocks.invoke.mockImplementation(read);
      if (order === "notice first") await changed();
      await act(async () => finishOldCheck?.(oldHomes));
      expect(onLaunch).not.toHaveBeenCalled();
      await act(async () => finishInitial(homes));
      if (order === "notice last") await changed();
      expect(finishOldCheck).toBeUndefined();
      expect(blockReason).toContain("アカウントの一覧を読めませんでした");
      expect(onLaunch).not.toHaveBeenCalled();
      homes = oldHomes;
      await changed();
      await click(setupStrings.launch);
      expect(onLaunch).toHaveBeenCalledTimes(1);
      expect(onLaunch.mock.calls[0][0].paneSpecs[0].account).toBe("grok-a");
    },
  );

  it.each(["single slot", "Codex recovers first", "Grok recovers first"] as const)(
    "clears each recovered selection and keeps the other slot's refusal (%s)", async order => {
      const onLaunch = vi.fn();
      const rowCount = order === "single slot" ? 1 : 2;
      await act(async () => root.render(<WorkspaceSetup onLaunch={onLaunch} onCancel={() => {}} />));
      if (rowCount === 2) {
        await click("2 Columns");
        await selectProvider(1, "codex");
        await click("codex a", accountRows()[1]);
      }
      await selectProvider(0, "grok");
      await click("grok a", accountRows()[0]);
      const registered = [...homes];
      const recovered = order === "Codex recovers first" ? "codex" : "grok";
      const refusal = () => host.textContent?.includes("選び直してください。");
      homes = homes.map(home => ({ ...home, state: "needs_login", owner: "mismatch" }));
      await changed();
      expect(refusal()).toBe(true);

      const read = mocks.invoke.getMockImplementation()!;
      mocks.invoke.mockImplementation((command: string) => command === "list_cli_account_homes"
        ? Promise.reject(new Error("fixture: recovery read failed")) : read(command));
      await changed();
      mocks.invoke.mockImplementation(read);
      // Redisplay the persisted failures, then recover one slot at a time.
      await changed();
      homes = homes.map(home => home.provider === recovered ? registered.find(item => item.provider === recovered)! : home);
      await changed();
      expect(refusal()).toBe(rowCount === 2);
      homes = registered;
      await changed();
      expect(refusal()).toBe(false);
      expect(onLaunch).not.toHaveBeenCalled();
      await click(setupStrings.launch);
      const accounts = Object.values(onLaunch.mock.calls[0][0].paneSpecs).map(spec => (spec as { account: string }).account);
      expect(accounts).toEqual(rowCount === 2 ? ["grok-a", "codex-a"] : ["grok-a"]);
    },
  );
});
