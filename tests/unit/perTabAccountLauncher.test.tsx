// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(), tokens: vi.fn(), homes: vi.fn(), accountSubscription: vi.fn(async () => {}),
  accountState: { profiles: [] as Array<{ id: string; label: string }>, loading: false, fetch: vi.fn(async () => {}) },
  settings: { launcherHiddenIds: [], crsmShowClaude: true, crsmShowCodex: true, crsmShowClaudeCodex: true, hideSessionsWithoutUserMessages: true },
  dirs: { view: null, load: async () => {} },
  layout: { addTabToPaneWithOptions: vi.fn(), addWebTabToPane: vi.fn(), removeTabFromPane: vi.fn() },
  ui: { setActivePaneId: vi.fn(), requestSettingsTab: vi.fn() },
}));
vi.mock("../../src/lib/ipc", () => ({
  crsmListSessions: async () => [], launcherRecordDirMru: async () => {},
  listCliAccounts: mocks.list, getCliLaunchTokens: mocks.tokens, listCliAccountHomes: mocks.homes,
}));
vi.mock("../../src/stores/settingsStore", () => ({ useSettingsStore: (select: (s: typeof mocks.settings) => unknown) => select(mocks.settings) }));
vi.mock("../../src/stores/launcherDirsStore", () => ({ useLauncherDirsStore: (select: (s: typeof mocks.dirs) => unknown) => select(mocks.dirs) }));
vi.mock("../../src/stores/workspaceLayoutStore", () => ({ useWorkspaceLayoutStore: (select: (s: typeof mocks.layout) => unknown) => select(mocks.layout) }));
vi.mock("../../src/stores/uiStore", () => ({ useUiStore: Object.assign((select: (s: typeof mocks.ui) => unknown) => select(mocks.ui), { getState: () => mocks.ui, subscribe: () => () => {} }) }));
vi.mock("../../src/stores/cliAccountStore", () => ({ useCliAccountStore: Object.assign((select: (s: typeof mocks.accountState) => unknown) => select(mocks.accountState), { getState: () => mocks.accountState }) }));

const accountChangeListeners = new Set<() => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, listener: () => void) => {
    if (name === "tab-account-evidence-updated") {
      await mocks.accountSubscription();
      accountChangeListeners.add(listener);
    }
    return () => { accountChangeListeners.delete(listener); };
  }),
}));

import LauncherPane from "../../src/components/workspace/LauncherPane";
import AgentSelector from "../../src/components/setup/AgentSelector";
import { TabAccountBadge } from "../../src/components/layout/TabAccountBadge";
import { getCatalogEntry, type PaneLaunchSpec } from "../../src/lib/agentCatalog";
import { launcherStrings as S } from "../../src/components/workspace/launcherStrings";
import { moveSpecRow, specRowsFor } from "../../src/components/workspace/launcherModel";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const scrollIntoView = vi.fn();
Element.prototype.scrollIntoView = scrollIntoView;
let host: HTMLDivElement;
let root: Root;
const profiles = ["claude", "codex", "grok"].flatMap(provider =>
  ["ready", "missing", "expired", "created", "awaiting_login", "needs_login"].map(state => ({
    id: provider + "-" + state, provider, label: provider + " " + state,
  })));
const snapshot = { profiles, live: [], active: { claude: null, codex: null, grok: null }, orphans: [], backup_root: "", generated_at: "" };
const tokens = [
  { profile_id: "claude-ready", expires_at: "2099-01-01T00:00:00Z" },
  { profile_id: "claude-expired", expires_at: "2000-01-01T00:00:00Z" },
];
const homes = ["codex", "grok"].flatMap(provider => ["ready", "created", "awaiting_login", "needs_login"].map(state => ({
  provider, profile_id: provider + "-" + state, state, owner: state === "needs_login" ? "mismatch" : "matched", generation: 1,
})));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue(snapshot);
  mocks.tokens.mockReset().mockResolvedValue(tokens);
  mocks.accountSubscription.mockReset().mockResolvedValue(undefined);
  mocks.homes.mockResolvedValue(homes);
  mocks.accountState.profiles = profiles;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

function button(label: string, scope: ParentNode = host): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === label || b.getAttribute("aria-label") === label);
  expect(found, label).toBeDefined();
  return found!;
}
async function click(label: string, scope: ParentNode = host) { await act(async () => button(label, scope).click()); }
async function key(value: string) { await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true })); }); }
async function open(target: string) {
  await act(async () => root.render(<LauncherPane workspaceId="ws" paneId="pane" tabId="tab" sessionId="session" isActive />));
  await click(S.specTooltip(getCatalogEntry(target)!.label));
}
const accountRow = () => host.querySelector<HTMLElement>("[data-launch-account-row]")!;
const env = () => mocks.layout.addTabToPaneWithOptions.mock.calls.at(-1)?.[2]?.launchEnv;

describe("L12b launcher reads saved registrations", () => {
  it("shows just default and one management link when there are zero registrations", async () => {
    mocks.tokens.mockResolvedValue([]);
    await open("claude");
    expect([...accountRow().querySelectorAll("button")].map(button => button.textContent)).toEqual([
      S.specDefault, "タブ用の登録はアカウント管理で",
    ]);
    expect(accountRow().querySelector("[data-claude-setup-token]")).toBeNull();
  });

  it("rereads a save before the start response without selecting the registered account", async () => {
    mocks.tokens.mockResolvedValue([]);
    await open("claude");
    mocks.tokens.mockResolvedValue(tokens);
    await act(async () => { for (const notify of accountChangeListeners) notify(); });
    expect(button("claude ready", accountRow()).disabled).toBe(false);
    expect(button("claude ready", accountRow()).getAttribute("aria-pressed")).toBe("false");
    expect(button(S.specDefault, accountRow()).getAttribute("aria-pressed")).toBe("true");
    await click("claude ready", accountRow());
    await click(S.launchButton);
    expect(env()?.MYCMUX_LAUNCH_ACCOUNT).toBe("claude-ready");
  });

  it("stops a previously selected home removed in another window even before notification", async () => {
    await open("grok");
    await click("grok ready", accountRow());
    mocks.homes.mockResolvedValue([]);
    await click(S.launchButton);
    await key("Enter");
    expect(mocks.layout.addTabToPaneWithOptions).not.toHaveBeenCalled();
    expect(accountRow().querySelector('[role="alert"]')?.textContent).toContain("選び直して");
    await click(S.specDefault, accountRow());
    await click(S.launchButton);
    expect(env()).toEqual({ MYCMUX_LAUNCH_TARGET: "grok" });
  });

  it("rereads on window focus and preserves the manually selected ID", async () => {
    await open("claude");
    await click("claude ready", accountRow());
    mocks.tokens.mockResolvedValue([{ ...tokens[0], owner_check: "mismatch" }]);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    const selected = button("claude ready", accountRow());
    expect(selected.disabled).toBe(true);
    expect(selected.getAttribute("aria-pressed")).toBe("true");
    expect(accountRow().textContent).toContain("不一致");
  });
});

describe("per-tab account launcher", () => {
  it("scrolls to the selected chip in the active account, model or effort row", async () => {
    await open("codex");
    await key("ArrowRight");
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(button("codex ready", accountRow()));
    await key("ArrowDown");
    await key("ArrowRight");
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(button("Sol (6.2)"));
    await key("ArrowDown");
    await key("ArrowRight");
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(button("low"));
    await key("ArrowUp");
    await key("ArrowUp");
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(button("codex ready", accountRow()));
    await key("ArrowRight");
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(button("codex needs_login", accountRow()));
  });

  it.each(["claude", "codex", "grok"])("L-1 loads only on opening %s and orders account, model, effort", async target => {
    await act(async () => root.render(<LauncherPane workspaceId="ws" paneId="pane" tabId="tab" sessionId="session" isActive />));
    expect(mocks.list).not.toHaveBeenCalled();
    await click(S.specTooltip(getCatalogEntry(target)!.label));
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.tokens).toHaveBeenCalledTimes(target === "claude" ? 1 : 0);
    expect(mocks.homes).toHaveBeenCalledTimes(target === "claude" ? 0 : 1);
    const text = host.querySelector("[data-launcher-spec]")!.textContent!;
    expect(text.indexOf(S.accountLabel)).toBeLessThan(text.indexOf(S.modelLabel));
    expect(text.indexOf(S.modelLabel)).toBeLessThan(text.indexOf(S.effortLabel));
    expect(button(S.specDefault, accountRow()).getAttribute("aria-pressed")).toBe("true");
    expect(accountRow().textContent).not.toContain(target === "claude" ? "codex ready" : "claude ready");
  });
  it.each(["claude-codex", "agy", "hermes", "omp", "cursor"])("L-1 does not offer accounts for %s", async target => {
    await act(async () => root.render(<AgentSelector slotIndex={0} value={{ target }} onChange={vi.fn()} />));
    expect(accountRow()).toBeNull();
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it("L-1 never puts accounts on Web choices", async () => {
    await act(async () => root.render(<AgentSelector slotIndex={0} value={{ target: "web-chatgpt" }} onChange={vi.fn()} />));
    expect(accountRow()).toBeNull();
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it.each(["claude", "codex", "grok"])("L-2 enables only usable %s registrations, with reasons", async target => {
    await open(target);
    expect(button(target + " ready", accountRow()).disabled).toBe(false);
    const invalid = target === "claude" ? "expired" : "needs_login";
    expect(button(target + " " + invalid, accountRow()).disabled).toBe(true);
    expect(accountRow().textContent).toContain(target === "claude" ? "期限切れ" : "不一致");
    expect([...accountRow().querySelectorAll("button")].map(node => node.textContent)).toEqual([
      S.specDefault, target + " ready", target + " " + invalid, S.accountManagement,
    ]);
  });
  it.each(["claude", "codex", "grok"])("L-3 passes only the selected %s account ID and leaves default env intact", async target => {
    await open(target);
    await click(S.launchButton);
    expect(env()).toEqual({ MYCMUX_LAUNCH_TARGET: target });
    await click(target + " ready", accountRow());
    await click(S.launchButton);
    expect(env()?.MYCMUX_LAUNCH_ACCOUNT).toBe(target + "-ready");
    expect(env()).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    await click(S.specDefault, accountRow());
    await click(S.launchButton);
    expect(env()).toEqual({ MYCMUX_LAUNCH_TARGET: target });
  });
  it("L-3 resets selection when another provider's editor opens", async () => {
    await open("claude");
    await click("claude ready", accountRow());
    await click(S.cancel);
    await click(S.specTooltip("Codex"));
    expect(button(S.specDefault, accountRow()).getAttribute("aria-pressed")).toBe("true");
    await click(S.launchButton);
    expect(env()).toEqual({ MYCMUX_LAUNCH_TARGET: "codex" });
  });
  it.each(["claude", "codex", "grok"])("L-4 visits unavailable %s chips without selecting them, then launches the selected account with Enter", async target => {
    await open(target);
    await key("ArrowRight");
    expect(button(target + " ready", accountRow()).getAttribute("aria-pressed")).toBe("true");
    await key("ArrowRight");
    expect(button(target + (target === "claude" ? " expired" : " needs_login"), accountRow()).getAttribute("aria-current")).toBe("true");
    expect(button(target + " ready", accountRow()).getAttribute("aria-pressed")).toBe("true");
    await key("ArrowLeft");
    await key("ArrowDown");
    await key("ArrowDown");
    await key("ArrowDown");
    await key("Enter");
    expect(env()?.MYCMUX_LAUNCH_ACCOUNT).toBe(target + "-ready");
    expect(specRowsFor(getCatalogEntry(target)!, true)).toEqual(["account", "model", "effort", "launch"]);
    expect(moveSpecRow(["account", "model", "effort", "launch"], "model", -1)).toBe("account");
  });
  it.each(["list", "tokens", "homes"] as const)("L-5 handles %s read failure with default and the management link", async failed => {
    const target = failed === "tokens" ? "claude" : "codex";
    mocks[failed].mockRejectedValue(new Error("private internal details"));
    await open(target);
    expect(accountRow().textContent).toContain(S.accountReadFailed);
    expect(accountRow().querySelectorAll("button")).toHaveLength(2);
    expect(button(S.specDefault, accountRow()).disabled).toBe(false);
    expect(host.textContent).not.toContain("private internal details");
    await click(S.launchButton);
    expect(env()).toEqual({ MYCMUX_LAUNCH_TARGET: target });
  });
  it("shows default and one management link when no accounts are registered", async () => {
    mocks.list.mockResolvedValue({ ...snapshot, profiles: [] });
    await open("claude");
    expect(accountRow().textContent).toBe(S.accountLabel + S.specDefault + S.accountManagement);
    expect(accountRow().querySelectorAll("button")).toHaveLength(2);
    await key("ArrowDown");
    scrollIntoView.mockClear();
    await key("ArrowUp");
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(button(S.specDefault, accountRow()));
    await click(S.launchButton);
    expect(env()).toEqual({ MYCMUX_LAUNCH_TARGET: "claude" });
  });
  it.each(["claude", "codex", "grok"])("L-6 limits the feature note to explicitly selected Claude accounts (%s)", async target => {
    await open(target);
    expect(host.textContent).not.toContain(S.accountClaudeLimitations);
    await click(target + " ready", accountRow());
    expect(host.textContent!.includes(S.accountClaudeLimitations)).toBe(target === "claude");
  });
  it("wraps chips and gives a full title to a long label", async () => {
    const label = "長いアカウント名".repeat(12);
    mocks.list.mockResolvedValue({ ...snapshot, profiles: [{ id: "codex-ready", provider: "codex", label }] });
    await open("codex");
    const choice = button(label, accountRow());
    expect(choice.title).toBe(label);
    expect(choice.style.textOverflow).toBe("ellipsis");
    expect(choice.parentElement!.parentElement!.style.flexWrap).toBe("wrap");
  });
  it("keeps the account chips the size of the model chips when a reason line sits under a chip", async () => {
    await open("claude");
    const row = accountRow()!;
    const defaultChip = button(S.specDefault, row);
    const missing = button("claude expired", row);
    expect(missing.nextElementSibling?.textContent).toBe("期限切れ");
    expect(defaultChip.parentElement!.style.alignItems).toBe("flex-start");
    expect(missing.parentElement!.style.justifyItems).toBe("start");
    for (const chip of [defaultChip, missing]) {
      expect(chip.style.font).toBe("");
      expect(chip.style.fontFamily).toBe("inherit");
      expect(chip.style.padding).toBe("3px 8px");
      expect(chip.style.fontSize).toBe("var(--cmux-font-size-xs)");
    }
  });
});

describe("setup shares the account row", () => {
  it.each(["claude", "codex", "grok"])("carries %s account in the existing launch spec and resets on provider switch", async target => {
    let current: PaneLaunchSpec = {};
    function Setup() {
      const [spec, setSpec] = useState<PaneLaunchSpec>({ target });
      current = spec;
      return <AgentSelector slotIndex={0} value={spec} onChange={setSpec} />;
    }
    await act(async () => root.render(<Setup />));
    await click(target + " ready", accountRow());
    expect(current).toEqual({ target, account: target + "-ready" });
    const select = host.querySelector("select")!;
    await act(async () => { select.value = "hermes"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(current).toEqual({ target: "hermes" });
    expect(accountRow()).toBeNull();
  });
});

describe("T-1 tab account badges", () => {
  it("loads labels for an explicit account in a standalone window with an empty account store", async () => {
    mocks.accountState.profiles = [];
    await act(async () => root.render(<TabAccountBadge accountId="codex-ready" />));
    expect(mocks.accountState.fetch).toHaveBeenCalledTimes(1);
    mocks.accountState.profiles = profiles;
    await act(async () => root.render(<TabAccountBadge accountId="codex-ready" />));
    expect(host.textContent).toBe("codex ready");
  });
  it("shows only explicit accounts, uses the registration label, and covers removed registrations", async () => {
    await act(async () => root.render(<TabAccountBadge />));
    expect(host.textContent).toBe("");
    await act(async () => root.render(<TabAccountBadge accountId="codex-ready" />));
    expect(host.textContent).toBe("codex ready");
    expect(host.querySelector("span")!.title).toBe("アカウント: codex ready (このタブだけ)");
    await act(async () => root.render(<TabAccountBadge accountId="removed-internal-id" />));
    expect(host.textContent).toBe("登録なし");
    expect(host.querySelector("span")!.title).toBe("アカウント: 登録なし (このタブだけ)");
    expect(host.innerHTML).not.toContain("removed-internal-id");
    expect(mocks.accountState.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("L12b round 2 launcher account checks", () => {
  it.each(["claude", "codex", "grok"])("passes the saved %s import ID unchanged to the launch environment", async provider => {
    const id = `unregistered-${provider}-2026-11-24T11-05-06.789+00-00-aabbccdd`;
    mocks.list.mockResolvedValue({ ...snapshot, profiles: [{ id, provider, label: "Imported account" }] });
    mocks.tokens.mockResolvedValue([{ ...tokens[0], profile_id: id }]);
    mocks.homes.mockResolvedValue([{ provider, profile_id: id, state: "ready", owner: "matched", generation: 1 }]);
    await open(provider);
    await click("Imported account", accountRow());
    await click(S.launchButton);
    expect(env()).toEqual({ MYCMUX_LAUNCH_TARGET: provider, MYCMUX_LAUNCH_ACCOUNT: id });
  });

  it.each(["grok-foreign", "codex-a/path", "codex-untrimmed "])("refuses an invalid explicit ID (%s) instead of launching default", async id => {
    mocks.list.mockResolvedValue({ ...snapshot, profiles: [{ id, provider: "codex", label: "Invalid account" }] });
    mocks.homes.mockResolvedValue([{ provider: "codex", profile_id: id, state: "ready", owner: "matched", generation: 1 }]);
    await open("codex");
    await click("Invalid account", accountRow());
    await click(S.launchButton);
    expect(mocks.layout.addTabToPaneWithOptions).not.toHaveBeenCalled();
    expect(accountRow().textContent).toContain("選び直して");
  });

  it("rejects a delayed successful launch check after a saved mismatch is displayed", async () => {
    await open("claude");
    await click("claude ready", accountRow());
    let resolveCheck!: (result: typeof tokens) => void;
    mocks.tokens.mockImplementationOnce(() => new Promise(resolve => { resolveCheck = resolve; }));
    await click(S.launchButton);
    expect(resolveCheck).toBeDefined();
    mocks.tokens.mockResolvedValue([{ ...tokens[0], owner_check: "mismatch" }]);
    await act(async () => { for (const notify of accountChangeListeners) notify(); });
    expect(button("claude ready", accountRow()).disabled).toBe(true);
    await act(async () => resolveCheck(tokens));
    expect(mocks.layout.addTabToPaneWithOptions).not.toHaveBeenCalled();
    expect(accountRow().querySelector('[role="alert"]')?.textContent).toContain("不一致");
  });

  it.each(["window focus", "focus returning to the launcher"])("rejects a delayed launch check after a mismatch is read on %s", async focus => {
    const outside = document.createElement("button");
    outside.textContent = "Outside fixture";
    host.before(outside);
    try {
      await open("claude");
      await click("claude ready", accountRow());
      let resolveCheck!: (result: typeof tokens) => void;
      mocks.tokens.mockImplementationOnce(() => new Promise(resolve => { resolveCheck = resolve; }));
      await click(S.launchButton);
      expect(resolveCheck).toBeDefined();

      mocks.tokens.mockResolvedValue([{ ...tokens[0], owner_check: "mismatch" }]);
      await act(async () => {
        if (focus === "window focus") window.dispatchEvent(new Event("focus"));
        else {
          outside.focus();
          button(S.specDefault, accountRow()).focus();
        }
      });
      expect(button("claude ready", accountRow()).disabled).toBe(true);
      await act(async () => resolveCheck(tokens));
      expect(mocks.layout.addTabToPaneWithOptions).not.toHaveBeenCalled();
      expect(accountRow().querySelector('[role="alert"]')?.textContent).toContain("不一致");
    } finally {
      outside.remove();
    }
  });

  it.each(["window focus", "saved-list notification"])("drops a launch check started during the display read from %s", async trigger => {
    await open("claude");
    await click("claude ready", accountRow());
    let resolveList!: (result: typeof tokens) => void;
    let resolveCheck!: (result: typeof tokens) => void;
    mocks.tokens.mockImplementationOnce(() => new Promise(resolve => { resolveList = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveCheck = resolve; }));

    await act(async () => {
      if (trigger === "window focus") window.dispatchEvent(new Event("focus"));
      else for (const notify of accountChangeListeners) notify();
    });
    expect(resolveList).toBeDefined();
    expect(button("claude ready", accountRow()).disabled).toBe(false);
    await click(S.launchButton);
    expect(resolveCheck).toBeDefined();
    const mismatch = [{ ...tokens[0], owner_check: "mismatch" }];
    mocks.tokens.mockResolvedValue(mismatch);
    await act(async () => resolveList(mismatch));
    expect(button("claude ready", accountRow()).disabled).toBe(true);
    await act(async () => resolveCheck(tokens));
    expect(mocks.layout.addTabToPaneWithOptions).not.toHaveBeenCalled();

    await click(S.launchButton);
    expect(mocks.layout.addTabToPaneWithOptions).not.toHaveBeenCalled();
    expect(accountRow().querySelector('[role="alert"]')?.textContent).toContain("不一致");
    mocks.tokens.mockResolvedValue(tokens);
    await act(async () => window.dispatchEvent(new Event("focus")));
    await click(S.launchButton);
    expect(mocks.layout.addTabToPaneWithOptions).toHaveBeenCalledTimes(1);
    expect(env()?.MYCMUX_LAUNCH_ACCOUNT).toBe("claude-ready");
  });

  it("releases a held Grok launch as soon as the user picks default", async () => {
    await open("grok");
    await click("grok ready", accountRow());
    let resolveOld!: (result: typeof homes) => void;
    mocks.homes.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    await click(S.launchButton);
    expect(resolveOld).toBeDefined();
    await click(S.specDefault, accountRow());
    expect(button(S.specDefault, accountRow()).getAttribute("aria-pressed")).toBe("true");
    expect(button(S.launchButton).disabled).toBe(false);
    await click(S.launchButton);
    expect(mocks.layout.addTabToPaneWithOptions).toHaveBeenCalledTimes(1);
    expect(env()).toEqual({ MYCMUX_LAUNCH_TARGET: "grok" });
    await act(async () => resolveOld(homes));
    expect(mocks.layout.addTabToPaneWithOptions).toHaveBeenCalledTimes(1);
  });

  it.each(["clicks", "arrow keys"])("drops the old Grok launch after default and back by %s", async input => {
    await open("grok");
    if (input === "clicks") await click("grok ready", accountRow());
    else await key("ArrowRight");
    expect(button("grok ready", accountRow()).getAttribute("aria-pressed")).toBe("true");
    let resolveOld!: (result: typeof homes) => void;
    mocks.homes.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    await click(S.launchButton);
    expect(resolveOld).toBeDefined();

    if (input === "clicks") {
      await click(S.specDefault, accountRow());
      await click("grok ready", accountRow());
    } else {
      await key("ArrowLeft");
      expect(button(S.specDefault, accountRow()).getAttribute("aria-pressed")).toBe("true");
      await key("ArrowRight");
    }
    expect(button("grok ready", accountRow()).getAttribute("aria-pressed")).toBe("true");
    await act(async () => resolveOld(homes));
    expect(mocks.layout.addTabToPaneWithOptions).not.toHaveBeenCalled();
    await click(S.launchButton);
    expect(mocks.layout.addTabToPaneWithOptions).toHaveBeenCalledTimes(1);
    expect(env()?.MYCMUX_LAUNCH_ACCOUNT).toBe("grok-ready");
  });

  it("requires another launch press after a saved-list refresh even when the selection remains available", async () => {
    await open("claude");
    await click("claude ready", accountRow());
    let resolveCheck!: (result: typeof tokens) => void;
    mocks.tokens.mockImplementationOnce(() => new Promise(resolve => { resolveCheck = resolve; }));
    await click(S.launchButton);
    await act(async () => { for (const notify of accountChangeListeners) notify(); });
    await act(async () => resolveCheck([]));
    expect(mocks.layout.addTabToPaneWithOptions).not.toHaveBeenCalled();
    expect(button("claude ready", accountRow()).getAttribute("aria-pressed")).toBe("true");
    await click(S.launchButton);
    expect(mocks.layout.addTabToPaneWithOptions).toHaveBeenCalledTimes(1);
    expect(env()).toEqual({ MYCMUX_LAUNCH_TARGET: "claude", MYCMUX_LAUNCH_ACCOUNT: "claude-ready" });
  });
});

it("wraps right from a ready account through the unavailable choice and management link to default", async () => {
  await open("codex");
  await key("ArrowRight");
  expect(button("codex ready", accountRow()).getAttribute("aria-pressed")).toBe("true");
  await key("ArrowRight");
  expect(button("codex needs_login", accountRow()).getAttribute("aria-current")).toBe("true");
  await key("ArrowRight");
  expect(button(S.accountManagement, accountRow()).getAttribute("aria-current")).toBe("true");
  await key("ArrowRight");
  expect(button(S.specDefault, accountRow()).getAttribute("aria-pressed")).toBe("true");
  await key("Enter");
  expect(env()).toEqual({ MYCMUX_LAUNCH_TARGET: "codex" });
});

describe("L12b FIX5 launcher subscription", () => {
  it.each(["rejected", "still pending"] as const)(
    "refuses an explicit Claude launch with a %s list subscription", async subscription => {
      let finishSubscription = () => {};
      if (subscription === "rejected") {
        mocks.accountSubscription.mockRejectedValueOnce(new Error("fixture subscription failed"));
      } else {
        mocks.accountSubscription.mockImplementationOnce(() => new Promise<void>(resolve => { finishSubscription = resolve; }));
      }
      await open("claude");
      // A window focus can supply the list while the listener handshake is pending.
      await act(async () => window.dispatchEvent(new Event("focus")));
      await click("claude ready", accountRow());
      let finishCheck = (_result: typeof tokens) => {};
      mocks.tokens.mockImplementationOnce(() => new Promise(resolve => { finishCheck = resolve; }));
      await click(S.launchButton);
      expect(accountChangeListeners.size).toBe(0);
      mocks.tokens.mockReset().mockResolvedValue([{ ...tokens[0], owner_check: "mismatch" }]);
      await act(async () => {
        for (const notify of accountChangeListeners) notify();
        finishCheck(tokens);
      });
      expect(mocks.layout.addTabToPaneWithOptions).not.toHaveBeenCalled();
      expect(accountRow().querySelector('[role="alert"]')?.textContent).toContain("アカウントの一覧を読めませんでした");

      if (subscription === "still pending") {
        mocks.tokens.mockResolvedValue(tokens);
        await act(async () => finishSubscription());
        expect(accountChangeListeners.size).toBe(1);
        await click(S.launchButton);
        expect(mocks.layout.addTabToPaneWithOptions).toHaveBeenCalledTimes(1);
        expect(env()?.MYCMUX_LAUNCH_ACCOUNT).toBe("claude-ready");
      } else {
        await click(S.specDefault, accountRow());
        await click(S.launchButton);
        expect(mocks.layout.addTabToPaneWithOptions).toHaveBeenCalledTimes(1);
        expect(env()?.MYCMUX_LAUNCH_ACCOUNT).toBeUndefined();
      }
    },
  );


  it("discards a successful check across replacing the display subscription for the same account", async () => {
    const render = (isActive: boolean) => act(async () => root.render(
      <LauncherPane workspaceId="ws" paneId="pane" tabId="tab" sessionId="session" isActive={isActive} />,
    ));
    await open("claude");
    await click("claude ready", accountRow());
    let finishOld!: (result: typeof tokens) => void;
    mocks.tokens.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
    await click(S.launchButton);
    expect(button(S.launchButton).disabled).toBe(true);
    await render(false);
    await render(true);
    expect(accountChangeListeners.size).toBe(1);
    expect(button("claude ready", accountRow()).getAttribute("aria-pressed")).toBe("true");
    let finishCurrent!: (result: typeof tokens) => void;
    mocks.tokens.mockImplementationOnce(() => new Promise(resolve => { finishCurrent = resolve; }));
    await click(S.launchButton);
    await act(async () => finishOld(tokens));
    expect(button(S.launchButton).disabled).toBe(true);
    expect(mocks.layout.addTabToPaneWithOptions).not.toHaveBeenCalled();
    await act(async () => finishCurrent(tokens));
    expect(mocks.layout.addTabToPaneWithOptions).toHaveBeenCalledTimes(1);
    expect(env()?.MYCMUX_LAUNCH_ACCOUNT).toBe("claude-ready");
  });

  it("waits for the reopened list subscription instead of a disposed success", async () => {
    let finishDisposed!: () => void;
    let finishCurrent!: () => void;
    mocks.accountSubscription
      .mockImplementationOnce(() => new Promise<void>(resolve => { finishDisposed = resolve; }))
      .mockImplementationOnce(() => new Promise<void>(resolve => { finishCurrent = resolve; }));
    await open("claude");
    await key("Escape");
    await click(S.specTooltip(getCatalogEntry("claude")!.label));
    await act(async () => window.dispatchEvent(new Event("focus")));
    await click("claude ready", accountRow());
    await act(async () => finishDisposed());
    expect(accountChangeListeners.size).toBe(0);
    await click(S.launchButton);
    expect(mocks.layout.addTabToPaneWithOptions).not.toHaveBeenCalled();

    await act(async () => finishCurrent());
    expect(accountChangeListeners.size).toBe(1);
    await click(S.launchButton);
    expect(mocks.layout.addTabToPaneWithOptions).toHaveBeenCalledTimes(1);
    expect(env()?.MYCMUX_LAUNCH_ACCOUNT).toBe("claude-ready");
  });
});

describe("L12b FIX6 current subscribed launch list", () => {
  it.each(["check before notice", "notice before check", "failed initial list", "notice replaces initial list"] as const)(
    "keeps a reopened Claude launch blocked until the subscribed list is displayed (%s)", async order => {
      let finishDisposed!: () => void;
      let finishSubscription!: () => void;
      mocks.accountSubscription
        .mockImplementationOnce(() => new Promise<void>(resolve => { finishDisposed = resolve; }))
        .mockImplementationOnce(() => new Promise<void>(resolve => { finishSubscription = resolve; }));
      await open("claude");
      await key("Escape");
      await click(S.specTooltip(getCatalogEntry("claude")!.label));
      await act(async () => window.dispatchEvent(new Event("focus")));
      await click("claude ready", accountRow());
      await act(async () => finishDisposed());
      expect(accountChangeListeners.size).toBe(0);

      let finishInitial!: (value: typeof tokens) => void;
      let failInitial!: (reason: Error) => void;
      mocks.tokens.mockImplementationOnce(() => new Promise((resolve, reject) => {
        finishInitial = resolve;
        failInitial = reject;
      }));
      await act(async () => finishSubscription());
      expect(accountChangeListeners.size).toBe(1);
      expect(finishInitial).toBeTypeOf("function");

      const mismatch = [{ ...tokens[0], owner_check: "mismatch" }];
      let finishOldCheck: ((value: typeof tokens) => void) | undefined;
      mocks.tokens.mockImplementationOnce(() => new Promise(resolve => { finishOldCheck = resolve; }));
      await click(S.launchButton);
      mocks.tokens.mockReset().mockResolvedValue(mismatch);
      const notify = () => act(async () => { for (const listener of accountChangeListeners) listener(); });
      if (order === "check before notice") {
        await act(async () => finishOldCheck?.(tokens));
        expect(mocks.layout.addTabToPaneWithOptions).not.toHaveBeenCalled();
        await act(async () => finishInitial(mismatch));
        await notify();
      } else if (order === "failed initial list") {
        await act(async () => failInitial(new Error("fixture: first list failed")));
        await act(async () => finishOldCheck?.(tokens));
        mocks.tokens.mockRejectedValueOnce(new Error("fixture: list still unavailable"));
        await notify();
        mocks.tokens.mockResolvedValue(tokens);
        mocks.tokens.mockClear();
        await click(S.launchButton);
        expect(mocks.tokens).not.toHaveBeenCalled();
        expect(accountRow().querySelector('[role="alert"]')?.textContent).toContain("アカウントの一覧を読めませんでした");
      } else {
        await notify();
        await act(async () => finishOldCheck?.(tokens));
        await act(async () => finishInitial(order === "notice replaces initial list" ? tokens : mismatch));
        expect(button("claude ready", accountRow()).disabled).toBe(true);
      }
      expect(finishOldCheck).toBeUndefined();
      expect(mocks.layout.addTabToPaneWithOptions).not.toHaveBeenCalled();
      mocks.tokens.mockResolvedValue(tokens);
      await notify();
      expect(button("claude ready", accountRow()).getAttribute("aria-pressed")).toBe("true");
      expect(mocks.layout.addTabToPaneWithOptions).not.toHaveBeenCalled();
      await click(S.launchButton);
      expect(mocks.layout.addTabToPaneWithOptions).toHaveBeenCalledTimes(1);
      expect(env()?.MYCMUX_LAUNCH_ACCOUNT).toBe("claude-ready");
    },
  );
});
