// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(), tokens: vi.fn(), homes: vi.fn(),
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

import LauncherPane from "../../src/components/workspace/LauncherPane";
import AgentSelector from "../../src/components/setup/AgentSelector";
import { TabAccountBadge } from "../../src/components/layout/TabAccountBadge";
import { getCatalogEntry, type PaneLaunchSpec } from "../../src/lib/agentCatalog";
import { launcherStrings as S } from "../../src/components/workspace/launcherStrings";
import { moveSpecRow, specRowsFor } from "../../src/components/workspace/launcherModel";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView = () => {};
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
  provider, profile_id: provider + "-" + state, state, owner: "matched", generation: 1,
})));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue(snapshot);
  mocks.tokens.mockResolvedValue(tokens);
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

describe("per-tab account launcher", () => {
  it.each(["claude", "codex", "grok"])("L-1 loads only on opening %s and orders account, model, effort", async target => {
    await act(async () => root.render(<LauncherPane workspaceId="ws" paneId="pane" tabId="tab" sessionId="session" isActive />));
    expect(mocks.list).not.toHaveBeenCalled();
    await click(S.specTooltip(getCatalogEntry(target)!.label));
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.tokens).toHaveBeenCalledTimes(1);
    expect(mocks.homes).toHaveBeenCalledTimes(1);
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
    for (const state of ["missing", "expired", "created", "awaiting_login", "needs_login"]) {
      expect(button(target + " " + state, accountRow()).disabled).toBe(true);
    }
    expect(accountRow().textContent).toContain(target === "claude" ? S.accountTokenMissing : S.accountLoginMissing);
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
  it.each(["claude", "codex", "grok"])("L-4 selects %s by keyboard, skipping unavailable chips, then launches with Enter", async target => {
    await open(target);
    await key("ArrowRight");
    expect(button(target + " ready", accountRow()).getAttribute("aria-pressed")).toBe("true");
    await key("ArrowRight");
    expect(button(S.specDefault, accountRow()).getAttribute("aria-pressed")).toBe("true");
    await key("ArrowLeft");
    await key("ArrowDown");
    await key("ArrowDown");
    await key("ArrowDown");
    await key("Enter");
    expect(env()?.MYCMUX_LAUNCH_ACCOUNT).toBe(target + "-ready");
    expect(specRowsFor(getCatalogEntry(target)!, true)).toEqual(["account", "model", "effort", "launch"]);
    expect(moveSpecRow(["account", "model", "effort", "launch"], "model", -1)).toBe("account");
  });
  it.each(["list", "tokens", "homes"] as const)("L-5 handles %s read failure with only default and still launches", async failed => {
    mocks[failed].mockRejectedValue(new Error("private internal details"));
    await open("codex");
    expect(accountRow().textContent).toContain(S.accountReadFailed);
    expect(accountRow().querySelectorAll("button")).toHaveLength(1);
    expect(button(S.specDefault, accountRow()).disabled).toBe(false);
    expect(host.textContent).not.toContain("private internal details");
    await click(S.launchButton);
    expect(env()).toEqual({ MYCMUX_LAUNCH_TARGET: "codex" });
  });
  it("shows only the setup instruction when no accounts are registered", async () => {
    mocks.list.mockResolvedValue({ ...snapshot, profiles: [] });
    await open("claude");
    expect(accountRow().textContent).toBe(S.accountLabel + S.accountEmpty);
    expect(accountRow().querySelectorAll("button")).toHaveLength(0);
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
    const missing = button("claude missing", row);
    expect(missing.nextElementSibling?.textContent).toBe(S.accountTokenMissing);
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
