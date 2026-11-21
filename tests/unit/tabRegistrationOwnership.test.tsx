// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(), tokens: vi.fn(), homes: vi.fn(), begin: vi.fn(), cancel: vi.fn(), home: vi.fn(), selection: vi.fn(),
  accountState: { profiles: [], loading: false, fetch: vi.fn(async () => {}), busyByProvider: { claude: null, codex: null, grok: null } },
  settings: { launcherHiddenIds: [], crsmShowClaude: true, crsmShowCodex: true, crsmShowClaudeCodex: true, hideSessionsWithoutUserMessages: true },
  dirs: { view: null, load: async () => {} },
  layout: { addTabToPaneWithOptions: vi.fn(), addWebTabToPane: vi.fn(), removeTabFromPane: vi.fn() },
  ui: { setActivePaneId: vi.fn(), requestSettingsTab: vi.fn() },
}));
vi.mock("../../src/lib/ipc", () => ({
  CLI_LOGIN_TIMEOUT_MS: 600000, crsmListSessions: async () => [], launcherRecordDirMru: async () => {},
  listCliAccounts: mocks.list, getCliLaunchTokens: mocks.tokens, listCliAccountHomes: mocks.homes,
  startClaudeSetupToken: mocks.begin, getClaudeSetupTokenState: async () => null,
  onClaudeSetupToken: async () => () => {}, cancelClaudeSetupToken: mocks.cancel, submitClaudeSetupCode: async () => {},
  setCliLaunchToken: vi.fn(), removeCliLaunchToken: vi.fn(), recheckCliLaunchToken: vi.fn(), unregisterCliAccountHome: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../../src/lib/appConfirmation", () => ({ confirm: vi.fn() }));
vi.mock("../../src/stores/settingsStore", () => ({ useSettingsStore: (select: (s: typeof mocks.settings) => unknown) => select(mocks.settings) }));
vi.mock("../../src/stores/launcherDirsStore", () => ({ useLauncherDirsStore: (select: (s: typeof mocks.dirs) => unknown) => select(mocks.dirs) }));
vi.mock("../../src/stores/workspaceLayoutStore", () => ({ useWorkspaceLayoutStore: (select: (s: typeof mocks.layout) => unknown) => select(mocks.layout) }));
vi.mock("../../src/stores/uiStore", () => ({ useUiStore: Object.assign((select: (s: typeof mocks.ui) => unknown) => select(mocks.ui), { getState: () => mocks.ui, subscribe: () => () => {} }) }));
vi.mock("../../src/stores/cliAccountStore", () => ({ useCliAccountStore: Object.assign((select: (s: typeof mocks.accountState) => unknown) => select(mocks.accountState), { getState: () => mocks.accountState }) }));
vi.mock("../../src/stores/cliLoginStore", async () => {
  const { create } = await import("zustand");
  return { useCliLoginStore: create(() => ({ byProvider: { claude: null, codex: null, grok: null }, startAccountHome: mocks.home })) };
});
vi.mock("../../src/lib/claudeCodexModels", () => ({ useLaunchModels: () => [] }));

import LauncherPane from "../../src/components/workspace/LauncherPane";
import { TabAccountSettings, TabAccountSettingsProvider } from "../../src/components/settings/TabAccountSettings";
import { OverlayShell } from "../../src/components/common/OverlayShell";
import AgentSelector from "../../src/components/setup/AgentSelector";
import WorkspaceSetup from "../../src/components/setup/WorkspaceSetup";
import { ClaudeSetupTokenFlow } from "../../src/components/settings/ClaudeSetupTokenFlow";
import { useCliLoginStore, type CliLoginEntry } from "../../src/stores/cliLoginStore";
import { useClaudeSetupTokenStore } from "../../src/stores/claudeSetupTokenStore";
import { launcherStrings as L } from "../../src/components/workspace/launcherStrings";
import { setupTokenStrings as S } from "../../src/components/layout/tabAccountStrings";
import { getCatalogEntry, type PaneLaunchSpec } from "../../src/lib/agentCatalog";
import type { CliAccountProfile, SwitchableCliProvider, ClaudeSetupTokenEvent } from "../../src/lib/ipc";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView = () => {};
let host: HTMLDivElement, root: Root;
const profile = (provider: SwitchableCliProvider): CliAccountProfile => ({
  id: provider + "-missing", provider, label: provider + " fixture", email: "fixture@example.test",
  identity_key: "fixture", plan: null, org_name: null, captured_at: "", last_switched_at: null, needs_relogin: false,
});
const snapshot = () => ({ profiles: (["claude", "codex", "grok"] as const).map(profile) });
const readyToken = { profile_id: "claude-missing", expires_at: "2099-01-01", owner_check: "verified" };
const noHomes = { claude: null, codex: null, grok: null };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue(snapshot()); mocks.tokens.mockResolvedValue([]); mocks.homes.mockResolvedValue([]);
  mocks.begin.mockResolvedValue({ login_id: "owned-login", profile_id: "claude-missing", state: "starting" });
  mocks.cancel.mockResolvedValue(undefined);
  mocks.home.mockImplementation(async (provider: "codex" | "grok", profileId: string) => {
    useCliLoginStore.setState({ byProvider: { ...noHomes, [provider]: homeEntry(profileId) } });
  });
  useCliLoginStore.setState({ byProvider: noHomes });
  useClaudeSetupTokenStore.setState({
    event: null, endedEvents: [], retiredLoginIds: [], pendingProfileId: null, failure: null, failureProfileId: null,
    registrationOrigins: { claude: null, codex: null, grok: null }, completionOrigin: null, resultFocus: null, homeStartPending: { claude: false, codex: false, grok: false }, completedLoginIds: [],
  });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
function button(label: string, scope: ParentNode = host) {
  const node = [...scope.querySelectorAll<HTMLButtonElement>("button")]
    .find(node => node.textContent === label || node.getAttribute("aria-label") === label);
  expect(node, label).toBeDefined(); return node!;
}
async function click(label: string, scope: ParentNode = host) {
  await act(async () => button(label, scope).click());
}
async function key(value: string, target: EventTarget = document.activeElement ?? document) {
  await act(async () => target.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })));
}
const search = () => host.querySelector<HTMLInputElement>("input[aria-label='" + L.searchPlaceholder + "']")!;
const launcher = () => <LauncherPane workspaceId="ws" paneId="pane" tabId="tab" sessionId="session" isActive />;
async function openProvider(provider: SwitchableCliProvider) {
  await click(L.specTooltip(getCatalogEntry(provider)!.label));
}
function homeEntry(profileId: string, stage: CliLoginEntry["stage"] = "waiting"): CliLoginEntry {
  return { stage, loginId: "home-login", mode: "reauth", startedAt: 1, sessionId: "login-session", tabId: "login-tab",
    purpose: { kind: "account_home", profile_id: profileId } };
}
async function finishHome(provider: "codex" | "grok") {
  await act(async () => {
    // handleCompleted publishes capturing and null without a render between them.
    useCliLoginStore.setState({ byProvider: { ...noHomes, [provider]: homeEntry(provider + "-missing", "capturing") } });
    useCliLoginStore.setState({ byProvider: noHomes });
  });
}
async function emit(state: ClaudeSetupTokenEvent["state"]) {
  await act(async () => useClaudeSetupTokenStore.getState().handleEvent({
    login_id: "owned-login", profile_id: "claude-missing", state,
    ...(state === "mismatch" ? { reason: "owner_mismatch" } : {}),
  }));
}
function expectAccountLaunch(id: string) {
  expect(mocks.layout.addTabToPaneWithOptions).toHaveBeenCalledWith("ws", "pane",
    expect.objectContaining({ launchEnv: expect.objectContaining({ MYCMUX_LAUNCH_ACCOUNT: id }) }));
}
function StatefulSelector() {
  const [value, setValue] = useState<PaneLaunchSpec>({ target: "codex" });
  return <AgentSelector workspaceInstanceId={1} slotIndex={0} value={value} onChange={next => { mocks.selection(next); setValue(next); }} />;
}

describe("home registration completion uses refreshed choices", () => {
  it.each(["codex", "grok"] as const)("selects the refreshed %s account after batched completion and uses it for Enter and Launch", async provider => {
    await act(async () => root.render(launcher())); await openProvider(provider);
    await key("ArrowRight", search()); await click(S.useInTab);
    let resolve!: (homes: unknown[]) => void;
    mocks.homes.mockImplementation(() => new Promise<unknown[]>(done => { resolve = done; }));
    await finishHome(provider);
    await click(L.launchButton);
    expect(mocks.layout.addTabToPaneWithOptions).not.toHaveBeenCalled();
    await act(async () => resolve([{ provider, profile_id: provider + "-missing", state: "ready" }]));
    expect(button(provider + " fixture").getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(search());
    await key("Enter"); expectAccountLaunch(provider + "-missing");
    mocks.layout.addTabToPaneWithOptions.mockClear();
    await click(L.launchButton); expectAccountLaunch(provider + "-missing");
    expect(useClaudeSetupTokenStore.getState().registrationOrigins).toEqual({ claude: null, codex: null, grok: null });
  });
  it("selects the refreshed account in the new-workspace AgentSelector", async () => {
    await act(async () => root.render(<StatefulSelector />)); await click(S.useInTab);
    mocks.homes.mockResolvedValue([{ provider: "codex", profile_id: "codex-missing", state: "ready" }]);
    await finishHome("codex");
    expect(mocks.selection).toHaveBeenCalledWith(expect.objectContaining({ target: "codex", account: "codex-missing" }));
    expect(button("codex fixture").getAttribute("aria-pressed")).toBe("true");
  });
  it("restores the same registration action when the refreshed home is still unavailable", async () => {
    await act(async () => root.render(launcher())); await openProvider("codex"); await click(S.useInTab);
    await finishHome("codex");
    expect(document.activeElement).toBe(button(S.useInTab));
    expect(button("codex fixture").getAttribute("aria-pressed")).toBe("false");
    expect(useClaudeSetupTokenStore.getState().registrationOrigins).toEqual({ claude: null, codex: null, grok: null });
  });
});

describe("completion notification survives flow remounting", () => {
  it("refreshes only once for a launcher mismatch even when loading remounts the flow", async () => {
    await act(async () => root.render(launcher())); await openProvider("claude");
    await click(S.useInTab); await click(S.begin);
    mocks.list.mockClear();
    mocks.list.mockImplementation(() => mocks.list.mock.calls.length === 1
      ? Promise.resolve(snapshot()) : new Promise(() => {}));
    await emit("mismatch");
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(useClaudeSetupTokenStore.getState().completedLoginIds).toContain("owned-login");
    expect(host.querySelector("[data-claude-setup-token] [role='alert']")).not.toBeNull();
    expect(useClaudeSetupTokenStore.getState().registrationOrigins).toEqual({ claude: null, codex: null, grok: null });
  });
});

describe("registration keyboard dismissal", () => {
  it.each(["confirmation", "failed", "cancelled", "timeout"] as const)("routes arrows and Escape from the restored button after %s dismissal", async outcome => {
    await act(async () => root.render(launcher())); await openProvider("claude");
    await key("ArrowRight", search()); await click(S.useInTab);
    if (outcome !== "confirmation") { await click(S.begin); await emit(outcome); }
    await click(S.dismiss);
    const action = button(S.useInTab);
    expect(document.activeElement).toBe(action);
    await key("ArrowLeft");
    expect(button("claude fixture").getAttribute("aria-current")).not.toBe("true");
    await key("ArrowRight");
    expect(button("claude fixture").getAttribute("aria-current")).toBe("true");
    expect(document.activeElement).toBe(action);
    await key("Escape");
    expect(host.querySelector("[data-launcher-spec]")).toBeNull();
  });
  it.each(["starting", "code_available"] as const)("closes and reopens launcher details with Escape during %s without cancelling", async state => {
    await act(async () => root.render(launcher())); await openProvider("claude");
    await click(S.useInTab); await click(S.begin);
    if (state === "code_available") await emit(state);
    const before = useClaudeSetupTokenStore.getState().event;
    await key("Escape");
    expect(host.querySelector("[data-launcher-spec]")).toBeNull();
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(useClaudeSetupTokenStore.getState().event).toEqual(before);
    await openProvider("claude");
    expect(host.querySelector("[data-claude-setup-token] [role='status']")).not.toBeNull();
    expect(useClaudeSetupTokenStore.getState().event).toEqual(before);
    await click(L.launchButton);
    expect(mocks.layout.addTabToPaneWithOptions).not.toHaveBeenCalled();
  });
  it("closes and reopens the settings OverlayShell with Escape while the code field is focused", async () => {
    function SettingsOverlay() {
      const [open, setOpen] = useState(true);
      return <><button onClick={() => setOpen(true)}>Open settings</button>
        {open && <OverlayShell open={open} onClose={() => setOpen(false)} ariaLabel="Account settings">
          <div data-registration-settings><TabAccountSettingsProvider><TabAccountSettings profile={profile("claude")} /></TabAccountSettingsProvider></div>
        </OverlayShell>}</>;
    }
    await act(async () => root.render(<SettingsOverlay />));
    const settings = () => document.querySelector<HTMLElement>("[data-registration-settings]")!;
    await click(S.useInTab, settings()); await click(S.begin, settings()); await emit("code_available");
    expect(document.activeElement).toBe(settings().querySelector("input[aria-label='" + S.codeLabel + "']"));
    const before = useClaudeSetupTokenStore.getState().event;
    await key("Escape");
    expect(document.querySelector("[role='dialog']")).toBeNull();
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(useClaudeSetupTokenStore.getState().event).toEqual(before);
    await click("Open settings");
    expect(settings().querySelector("input[aria-label='" + S.codeLabel + "']")).not.toBeNull();
    expect(useClaudeSetupTokenStore.getState().event).toEqual(before);
  });
});

describe("the originating surface owns registration effects", () => {
  it("allows Claude after switching from Codex, and still blocks the running Codex login after switching back", async () => {
    await act(async () => root.render(launcher())); await openProvider("codex"); await click(S.useInTab);
    await openProvider("claude"); await click(L.launchButton);
    expect(mocks.layout.addTabToPaneWithOptions).toHaveBeenCalledTimes(1);
    mocks.layout.addTabToPaneWithOptions.mockClear();
    await openProvider("grok"); await openProvider("codex"); await click(L.launchButton);
    expect(mocks.layout.addTabToPaneWithOptions).not.toHaveBeenCalled();
    expect(mocks.home).toHaveBeenCalledTimes(1);
  });
  async function renderBoth() {
    await act(async () => root.render(<>{launcher()}<aside data-registration-settings>
      <TabAccountSettingsProvider><TabAccountSettings profile={profile("claude")} /></TabAccountSettingsProvider>
    </aside></>));
    await openProvider("claude");
    return host.querySelector<HTMLElement>("[data-registration-settings]")!;
  }
  it("keeps launcher focus, selection, and launching independent of a settings registration", async () => {
    const settings = await renderBoth();
    await click(S.useInTab, settings); await click(S.begin, settings);
    await emit("code_available");
    const code = settings.querySelector<HTMLInputElement>("input[aria-label='" + S.codeLabel + "']")!;
    expect(document.activeElement).toBe(code);
    expect(host.querySelector("[data-launch-account-row] input[aria-label='" + S.codeLabel + "']")).toBeNull();
    await click(L.launchButton);
    expect(mocks.layout.addTabToPaneWithOptions).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(code);
    mocks.tokens.mockResolvedValue([readyToken]); await emit("saved");
    expect(button("claude fixture").getAttribute("aria-pressed")).toBe("false");
    expect(document.activeElement).not.toBe(search());
    expect(useClaudeSetupTokenStore.getState().registrationOrigins).toEqual({ claude: null, codex: null, grok: null });
  });
  it("lets only the launcher flow move focus when settings displays the same registration", async () => {
    const settings = await renderBoth();
    const row = host.querySelector<HTMLElement>("[data-launch-account-row]")!;
    await click(S.useInTab, row); await click(S.begin, row);
    await emit("code_available");
    const launcherCode = row.querySelector<HTMLInputElement>("input[aria-label='" + S.codeLabel + "']")!;
    expect(settings.querySelector("input[aria-label='" + S.codeLabel + "']")).toBeNull();
    expect(button(S.cancel, settings)).toBeDefined();
    expect(document.activeElement).toBe(launcherCode);
    mocks.tokens.mockResolvedValue([readyToken]); await emit("saved");
    expect(button("claude fixture").getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(search());
    expect(useClaudeSetupTokenStore.getState().registrationOrigins).toEqual({ claude: null, codex: null, grok: null });
  });
  it.each(["failed", "cancelled", "timeout"] as const)("clears the origin after %s without moving another surface's focus", async outcome => {
    const settings = await renderBoth();
    await click(S.useInTab, settings); await click(S.begin, settings);
    await emit(outcome);
    expect(useClaudeSetupTokenStore.getState().registrationOrigins).toEqual({ claude: null, codex: null, grok: null });
    expect(document.activeElement).not.toBe(search());
    await click(L.launchButton);
    expect(mocks.layout.addTabToPaneWithOptions).toHaveBeenCalledTimes(1);
  });
});

describe("registration origin ends independently of component lifetime", () => {
  it.each(["saved", "failed", "cancelled", "timeout"] as const)("clears the Claude origin after %s while launcher details are closed", async outcome => {
    await act(async () => root.render(launcher())); await openProvider("claude");
    await click(S.useInTab); await click(S.begin); await key("Escape");
    expect(host.querySelector("[data-launcher-spec]")).toBeNull();
    if (outcome === "saved") mocks.tokens.mockResolvedValue([readyToken]);
    await emit(outcome);
    expect(useClaudeSetupTokenStore.getState().registrationOrigins).toEqual({ claude: null, codex: null, grok: null });
    await openProvider("claude"); await click(L.launchButton);
    expect(mocks.layout.addTabToPaneWithOptions).toHaveBeenCalledTimes(1);
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it("does not let an earlier launcher confirmation own a later settings registration", async () => {
    await act(async () => root.render(<>{launcher()}<aside data-registration-settings>
      <TabAccountSettingsProvider><TabAccountSettings profile={profile("claude")} /></TabAccountSettingsProvider>
    </aside></>));
    await openProvider("claude");
    const row = host.querySelector<HTMLElement>("[data-launch-account-row]")!;
    const settings = host.querySelector<HTMLElement>("[data-registration-settings]")!;
    await click(S.useInTab, row); await click(S.useInTab, settings); await click(S.begin, settings);
    await emit("code_available");
    expect(document.activeElement).toBe(settings.querySelector("input[aria-label='" + S.codeLabel + "']"));
    await click(L.launchButton);
    expect(mocks.layout.addTabToPaneWithOptions).toHaveBeenCalledTimes(1);
    mocks.tokens.mockResolvedValue([readyToken]); await emit("saved");
    expect(button("claude fixture").getAttribute("aria-pressed")).toBe("false");
    expect(document.activeElement).not.toBe(search());
  });
});

function SelectorPair({ provider }: { provider: SwitchableCliProvider }) {
  const [values, setValues] = useState<PaneLaunchSpec[]>([{ target: provider }, { target: provider }]);
  return <>{values.map((value, index) => <section key={index} data-registration-slot={index}>
    <AgentSelector workspaceInstanceId={1} slotIndex={index} value={value} onChange={next => {
      mocks.selection(index, next);
      setValues(current => current.map((item, at) => at === index ? next : item));
    }} />
  </section>)}</>;
}
const slots = () => [...host.querySelectorAll<HTMLElement>("[data-registration-slot]")];
async function resolveReads(pending: (() => void)[], reverse: boolean) {
  for (let turn = 0; pending.length > 0 && turn < 10; turn++) {
    const batch = pending.splice(0);
    await act(async () => { for (const resolve of reverse ? batch.reverse() : batch) resolve(); });
  }
  expect(pending).toHaveLength(0);
}

describe("concurrent provider registration ownership", () => {
  it("selects Codex after starting Grok too and passes its account to Enter and Launch", async () => {
    mocks.home.mockImplementation(async (provider: "codex" | "grok", profileId: string) => {
      useCliLoginStore.setState({ byProvider: { ...useCliLoginStore.getState().byProvider, [provider]: homeEntry(profileId) } });
    });
    await act(async () => root.render(launcher()));
    await openProvider("codex"); await click(S.useInTab);
    await openProvider("grok"); await click(S.useInTab);
    await openProvider("codex"); await click(L.launchButton);
    expect(mocks.layout.addTabToPaneWithOptions).not.toHaveBeenCalled();
    mocks.homes.mockResolvedValue([{ provider: "codex", profile_id: "codex-missing", state: "ready" }]);
    await act(async () => {
      const entries = useCliLoginStore.getState().byProvider;
      useCliLoginStore.setState({ byProvider: { ...entries, codex: homeEntry("codex-missing", "capturing") } });
      useCliLoginStore.setState({ byProvider: { ...entries, codex: null } });
    });
    expect(button("codex fixture").getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(search());
    await key("Enter"); expectAccountLaunch("codex-missing");
    mocks.layout.addTabToPaneWithOptions.mockClear();
    await click(L.launchButton); expectAccountLaunch("codex-missing");
    expect(useCliLoginStore.getState().byProvider.grok).not.toBeNull();
  });

  it("keeps the Claude code field and delivers its saved callback while Codex registers", async () => {
    const onSaved = vi.fn();
    await act(async () => root.render(<>{launcher()}<aside data-provider-owner>
      <ClaudeSetupTokenFlow profile={profile("claude")} onSaved={onSaved} />
    </aside></>));
    const owner = host.querySelector<HTMLElement>("[data-provider-owner]")!;
    await click(S.useInTab, owner); await click(S.begin, owner);
    const url = "https://example.test/oauth/authorize?state=parallel";
    await act(async () => useClaudeSetupTokenStore.getState().handleEvent({
      login_id: "owned-login", profile_id: "claude-missing", state: "code_available", url,
    }));
    const input = owner.querySelector("input");
    expect(input).not.toBeNull();
    await openProvider("codex"); await click(S.useInTab, host.querySelector("[data-launch-account-row]")!);
    expect(owner.querySelector("input")).toBe(input);
    expect(owner.textContent).toContain(url);
    await emit("saved"); await emit("saved");
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});

describe("stable component registration ownership", () => {
  it.each((["codex", "grok"] as const).flatMap(provider =>
    [false, true].flatMap(reverse => [false, true].map(ready => ({ provider, reverse, ready }))),
  ))("routes $provider completion only to slot two (reverse=$reverse, ready=$ready)", async ({ provider, reverse, ready }) => {
    await act(async () => root.render(<SelectorPair provider={provider} />));
    const [first, second] = slots();
    await click(S.useInTab, second);
    const outside = second.querySelector<HTMLInputElement>("input")!;
    await act(async () => outside.focus());
    const pending: (() => void)[] = [];
    mocks.homes.mockImplementation(() => new Promise(resolve => pending.push(() => resolve(
      ready ? [{ provider, profile_id: provider + "-missing", state: "ready" }] : [],
    ))));
    await finishHome(provider);
    expect(pending.length).toBeGreaterThanOrEqual(2);
    await resolveReads(pending, reverse);
    expect(mocks.selection.mock.calls.filter(call => call[0] === 0)).toHaveLength(0);
    expect(button(provider + " fixture", first).getAttribute("aria-pressed")).toBe("false");
    if (ready) {
      expect(mocks.selection).toHaveBeenCalledExactlyOnceWith(1, expect.objectContaining({ account: provider + "-missing" }));
      expect(button(provider + " fixture", second).getAttribute("aria-pressed")).toBe("true");
      expect(document.activeElement).toBe(outside);
    } else {
      expect(mocks.selection).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(button(S.useInTab, second));
    }
  });

  it.each([false, true])("routes Claude code, focus, and saved completion only to slot two (reverse=%s)", async reverse => {
    await act(async () => root.render(<SelectorPair provider="claude" />));
    const [first, second] = slots();
    await click(S.useInTab, second); await click(S.begin, second); await emit("code_available");
    expect(first.querySelector("input[aria-label='" + S.codeLabel + "']")).toBeNull();
    const code = second.querySelector("input[aria-label='" + S.codeLabel + "']");
    expect(code).not.toBeNull(); expect(document.activeElement).toBe(code);
    const pending: (() => void)[] = [];
    mocks.list.mockImplementation(() => new Promise(resolve => pending.push(() => resolve(snapshot()))));
    mocks.tokens.mockResolvedValue([readyToken]);
    await emit("saved");
    expect(pending.length).toBeGreaterThanOrEqual(2);
    await resolveReads(pending, reverse);
    expect(mocks.selection).toHaveBeenCalledExactlyOnceWith(1, expect.objectContaining({ account: "claude-missing" }));
    expect(button("claude fixture", first).getAttribute("aria-pressed")).toBe("false");
    expect(button("claude fixture", second).getAttribute("aria-pressed")).toBe("true");
    expect(useClaudeSetupTokenStore.getState().completedLoginIds.filter(id => id === "owned-login")).toHaveLength(1);
  });

  it("routes Claude registration only to its launcher tab in the same window", async () => {
    await act(async () => root.render(<>
      <section data-launcher-owner="first"><LauncherPane workspaceId="ws" paneId="first" tabId="first-tab" sessionId="first-session" isActive={false} /></section>
      <section data-launcher-owner="second"><LauncherPane workspaceId="ws" paneId="second" tabId="second-tab" sessionId="second-session" isActive /></section>
    </>));
    const first = host.querySelector<HTMLElement>("[data-launcher-owner='first']")!;
    const second = host.querySelector<HTMLElement>("[data-launcher-owner='second']")!;
    await click(L.specTooltip(getCatalogEntry("claude")!.label), first);
    await click(L.specTooltip(getCatalogEntry("claude")!.label), second);
    await click(S.useInTab, second); await click(S.begin, second); await emit("code_available");
    expect(first.querySelector("input[aria-label='" + S.codeLabel + "']")).toBeNull();
    expect(document.activeElement).toBe(second.querySelector("input[aria-label='" + S.codeLabel + "']"));
    mocks.tokens.mockResolvedValue([readyToken]); await emit("saved");
    expect(button("claude fixture", first).getAttribute("aria-pressed")).toBe("false");
    expect(button("claude fixture", second).getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(second.querySelector("input[aria-label='" + L.searchPlaceholder + "']"));
    await click(L.launchButton, second);
    expect(mocks.layout.addTabToPaneWithOptions).toHaveBeenCalledExactlyOnceWith("ws", "second",
      expect.objectContaining({ launchEnv: expect.objectContaining({ MYCMUX_LAUNCH_ACCOUNT: "claude-missing" }) }));
  });
});

describe("launcher result focus survives account refresh", () => {
  it.each([false, true])("restores mismatch dismissal after refresh without moving passive settings focus (outside=%s)", async outsideFocus => {
    await act(async () => root.render(<>{launcher()}<aside data-focus-peer>
      <TabAccountSettingsProvider><TabAccountSettings profile={profile("claude")} /></TabAccountSettingsProvider>
    </aside><button data-focus-outside>Outside fixture</button></>));
    await openProvider("claude");
    const row = host.querySelector<HTMLElement>("[data-launch-account-row]")!;
    const peer = host.querySelector<HTMLElement>("[data-focus-peer]")!;
    await click(S.useInTab, row); await click(S.begin, row); await emit("code_available");
    expect(document.activeElement).toBe(row.querySelector("input[aria-label='" + S.codeLabel + "']"));
    let resolveRefresh!: (value: ReturnType<typeof snapshot>) => void;
    mocks.list.mockImplementationOnce(() => new Promise(resolve => { resolveRefresh = resolve; }));
    await emit("mismatch");
    expect(row.querySelector("[data-claude-setup-token]")).toBeNull();
    expect(document.activeElement).not.toBe(button(S.dismiss, peer));
    const outside = host.querySelector<HTMLButtonElement>("[data-focus-outside]")!;
    if (outsideFocus) await act(async () => outside.focus());
    await act(async () => resolveRefresh(snapshot()));
    const dismiss = button(S.dismiss, row);
    expect(document.activeElement).toBe(outsideFocus ? outside : dismiss);
    expect(document.activeElement).not.toBe(button(S.dismiss, peer));
    await click(S.dismiss, row);
    expect(useClaudeSetupTokenStore.getState().resultFocus).toBeNull();
    expect(button(S.useInTab, row)).toBe(document.activeElement);
  });

  it.each(["dismiss", "begin"] as const)("clears a pending result focus when its owner chooses %s", async action => {
    const ownerKey = "launcher:focus-fixture";
    await act(async () => root.render(<>
      <ClaudeSetupTokenFlow profile={profile("claude")} surface="launcher" ownerKey={ownerKey} />
      <button data-focus-outside>Outside fixture</button>
    </>));
    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-focus-outside]")!.focus();
      useClaudeSetupTokenStore.setState({
        event: { login_id: "focus-login", profile_id: "claude-missing", state: "timeout" },
        resultFocus: { ownerKey, loginId: "focus-login" },
      });
    });
    if (action === "dismiss") await click(S.dismiss);
    else { await click(S.useInTab); await click(S.begin); }
    expect(useClaudeSetupTokenStore.getState().resultFocus).toBeNull();
  });
});


describe("new workspace registration lifetime", () => {
  const workspace = () => <WorkspaceSetup defaultCwd="fixture-work" onCancel={vi.fn()} onLaunch={vi.fn()} />;
  async function chooseProvider(provider: SwitchableCliProvider) {
    const select = host.querySelector<HTMLSelectElement>("select")!;
    await act(async () => {
      select.value = provider;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  it.each(["codex", "grok"] as const)("does not inherit a closed workspace's %s completion", async provider => {
    await act(async () => root.render(workspace()));
    await chooseProvider(provider); await click(S.useInTab);
    const oldOrigin = useClaudeSetupTokenStore.getState().registrationOrigins[provider];
    await act(async () => root.render(null));
    mocks.homes.mockResolvedValue([{ provider, profile_id: provider + "-missing", state: "ready" }]);
    await finishHome(provider);
    await act(async () => root.render(workspace()));
    const outside = host.querySelector<HTMLInputElement>("input")!;
    await act(async () => outside.focus());
    await chooseProvider(provider);
    expect(button(L.specDefault).getAttribute("aria-pressed")).toBe("true");
    expect(button(provider + " fixture").getAttribute("aria-pressed")).toBe("false");
    expect(document.activeElement).toBe(outside);
    expect(host.querySelector("input[aria-label='" + S.codeLabel + "']")).toBeNull();
    expect(host.textContent).not.toContain(S.saved);
    expect(useClaudeSetupTokenStore.getState().registrationOrigins[provider]).toEqual(oldOrigin);
  });
  it("does not inherit Claude code focus or completion after reopening the workspace", async () => {
    await act(async () => root.render(workspace()));
    await chooseProvider("claude"); await click(S.useInTab); await click(S.begin);
    const oldOrigin = useClaudeSetupTokenStore.getState().registrationOrigins.claude;
    await act(async () => root.render(null));
    await act(async () => root.render(workspace())); await chooseProvider("claude");
    const outside = host.querySelector<HTMLInputElement>("input")!;
    await act(async () => outside.focus());
    const url = "https://example.test/oauth/authorize?state=closed-workspace";
    await act(async () => useClaudeSetupTokenStore.getState().handleEvent({
      login_id: "owned-login", profile_id: "claude-missing", state: "code_available", url,
    }));
    expect(host.querySelector("input[aria-label='" + S.codeLabel + "']")).toBeNull();
    expect(host.textContent).not.toContain(url);
    expect(document.activeElement).toBe(outside);
    mocks.tokens.mockResolvedValue([readyToken]); await emit("saved");
    expect(button(L.specDefault).getAttribute("aria-pressed")).toBe("true");
    expect(button("claude fixture").getAttribute("aria-pressed")).toBe("false");
    expect(document.activeElement).toBe(outside);
    expect(host.textContent).not.toContain(S.saved);
    expect(useClaudeSetupTokenStore.getState().completedLoginIds).toEqual([]);
    expect(useClaudeSetupTokenStore.getState().completionOrigin?.origin).toEqual(oldOrigin);
  });
});


describe("launcher early completion survives another login", () => {
  it.each(["saved", "failed"] as const)("unblocks launching after early %s B is followed by C", async outcome => {
    let resolveStart!: (value: ClaudeSetupTokenEvent) => void;
    mocks.begin.mockImplementationOnce(() => new Promise(resolve => { resolveStart = resolve; }));
    await act(async () => root.render(launcher())); await openProvider("claude");
    await click(S.useInTab); await click(S.begin);
    await click(L.launchButton); expect(mocks.layout.addTabToPaneWithOptions).not.toHaveBeenCalled();
    await emit(outcome);
    const other: ClaudeSetupTokenEvent = { login_id: "foreign-C", profile_id: "claude-other", state: "starting" };
    await act(async () => useClaudeSetupTokenStore.getState().handleEvent(other));
    if (outcome === "saved") mocks.tokens.mockResolvedValue([readyToken]);
    await act(async () => resolveStart({ login_id: "owned-login", profile_id: "claude-missing", state: "starting" }));
    expect.soft(useClaudeSetupTokenStore.getState().pendingProfileId).toBeNull();
    expect.soft(useClaudeSetupTokenStore.getState().registrationOrigins.claude).toBeNull();
    expect.soft(useClaudeSetupTokenStore.getState().event).toEqual(other);
    expect.soft(button("claude fixture").getAttribute("aria-pressed")).toBe(outcome === "saved" ? "true" : "false");
    await click(L.launchButton);
    expect.soft(mocks.layout.addTabToPaneWithOptions).toHaveBeenCalledTimes(1);
    if (outcome === "saved") {
      expect.soft(mocks.layout.addTabToPaneWithOptions).toHaveBeenCalledWith("ws", "pane",
        expect.objectContaining({ launchEnv: expect.objectContaining({ MYCMUX_LAUNCH_ACCOUNT: "claude-missing" }) }));
      expect.soft(useClaudeSetupTokenStore.getState().completedLoginIds.filter(id => id === "owned-login")).toHaveLength(1);
    }
  });
});


describe("result focus expires after one opportunity", () => {
  it.each(["refresh", "details"] as const)("does not revive skipped result focus after another %s", async nextAction => {
    await act(async () => root.render(<>{launcher()}<aside data-focus-peer>
      <TabAccountSettingsProvider><TabAccountSettings profile={profile("claude")} /></TabAccountSettingsProvider>
    </aside><button data-focus-outside>Outside fixture</button></>));
    await openProvider("claude");
    let row = host.querySelector<HTMLElement>("[data-launch-account-row]")!;
    await click(S.useInTab, row); await click(S.begin, row); await emit("code_available");
    let resolveRefresh!: (value: ReturnType<typeof snapshot>) => void;
    mocks.list.mockImplementationOnce(() => new Promise(resolve => { resolveRefresh = resolve; }));
    await emit("mismatch");
    expect(row.querySelector("[data-claude-setup-token]")).toBeNull();
    const outside = host.querySelector<HTMLButtonElement>("[data-focus-outside]")!;
    await act(async () => outside.focus());
    await act(async () => resolveRefresh(snapshot()));
    expect(document.activeElement).toBe(outside);
    expect.soft(useClaudeSetupTokenStore.getState().resultFocus).toBeNull();
    if (nextAction === "details") {
      await key("Escape", search());
      expect(host.querySelector("[data-launch-account-row]")).toBeNull();
      let resolveReopen!: (value: ReturnType<typeof snapshot>) => void;
      mocks.list.mockImplementationOnce(() => new Promise(resolve => { resolveReopen = resolve; }));
      await openProvider("claude");
      await act(async () => search().blur());
      await act(async () => resolveReopen(snapshot()));
      row = host.querySelector<HTMLElement>("[data-launch-account-row]")!;
    } else {
      await act(async () => outside.blur());
      await act(async () => useCliLoginStore.setState({ byProvider: { ...noHomes } }));
    }
    expect(button(S.dismiss, row)).toBeDefined();
    expect.soft(document.activeElement).toBe(document.body);
    expect.soft(useClaudeSetupTokenStore.getState().resultFocus).toBeNull();
  });
  it("clears owned result focus when details close during the first refresh", async () => {
    await act(async () => root.render(launcher())); await openProvider("claude");
    await click(S.useInTab); await click(S.begin); await emit("code_available");
    let resolveRefresh!: (value: ReturnType<typeof snapshot>) => void;
    mocks.list.mockImplementationOnce(() => new Promise(resolve => { resolveRefresh = resolve; }));
    await emit("mismatch");
    expect(useClaudeSetupTokenStore.getState().resultFocus).toEqual({ ownerKey: "launcher:tab", loginId: "owned-login" });
    await key("Escape", search());
    expect(host.querySelector("[data-launch-account-row]")).toBeNull();
    expect.soft(useClaudeSetupTokenStore.getState().resultFocus).toBeNull();
    await act(async () => resolveRefresh(snapshot()));
    let resolveReopen!: (value: ReturnType<typeof snapshot>) => void;
    mocks.list.mockImplementationOnce(() => new Promise(resolve => { resolveReopen = resolve; }));
    await openProvider("claude");
    await act(async () => search().blur());
    await act(async () => resolveReopen(snapshot()));
    expect(button(S.dismiss)).toBeDefined();
    expect.soft(document.activeElement).toBe(document.body);
    expect.soft(useClaudeSetupTokenStore.getState().resultFocus).toBeNull();
  });
  it("focuses the settings result without writing a remount focus marker", async () => {
    await act(async () => root.render(<ClaudeSetupTokenFlow profile={profile("claude")} onSaved={vi.fn()} />));
    await click(S.useInTab); await click(S.begin); await emit("code_available");
    await emit("timeout");
    expect(document.activeElement).toBe(button(S.dismiss));
    expect(useClaudeSetupTokenStore.getState().resultFocus).toBeNull();
  });
  it("preserves another owner's result focus when its details close", async () => {
    await act(async () => root.render(launcher())); await openProvider("claude");
    const otherFocus = { ownerKey: "launcher:another-tab", loginId: "another-login" };
    await act(async () => useClaudeSetupTokenStore.setState({ resultFocus: otherFocus }));
    await key("Escape", search());
    expect(host.querySelector("[data-launch-account-row]")).toBeNull();
    expect(useClaudeSetupTokenStore.getState().resultFocus).toEqual(otherFocus);
  });
});
