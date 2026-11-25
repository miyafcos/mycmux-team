// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(async () => {}), listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));

import WorkspaceSetup, { type WorkspaceSetupResult } from "../../src/components/setup/WorkspaceSetup";
import { setupStrings } from "../../src/components/setup/setupStrings";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import { launcherStrings } from "../../src/components/workspace/launcherStrings";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "list_cli_accounts") return { profiles: ["claude", "codex", "grok"].map(provider => ({ id: provider + "-work", provider, label: provider + " work" })) };
    if (command === "get_cli_launch_tokens") return [{ profile_id: "claude-work", expires_at: "2099-01-01T00:00:00Z" }];
    if (command === "list_cli_account_homes") return ["codex", "grok"].map(provider => ({ provider, profile_id: provider + "-work", state: "ready" }));
    return undefined;
  });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
async function click(label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === label)!;
  expect(button, label).toBeDefined();
  await act(async () => button.click());
}

describe("L12b workspace setup reads saved choices", () => {
  it("rejects a deleted selection before notification for both Open and Enter", async () => {
    const launch = vi.fn();
    await act(async () => root.render(<WorkspaceSetup onCancel={() => {}} onLaunch={launch} />));
    const select = host.querySelector<HTMLSelectElement>("select")!;
    await act(async () => { select.value = "codex"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await click("codex work");
    mocks.invoke.mockImplementation(async (command: string) => command === "list_cli_accounts" ? { profiles: [] } : []);
    await click(setupStrings.launch);
    await act(async () => host.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(launch).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("選び直して");
    await click(launcherStrings.specDefault);
    await click(setupStrings.launch);
    expect(launch.mock.calls[0][0].paneSpecs[0].account).toBe("");
  });
});

it("preserves the draft name and explicit account when the setup fields are hidden", async () => {
  const onLaunch = vi.fn();
  const view = (visible: boolean) => <WorkspaceSetup visible={visible} defaultCwd="fixture-work" onLaunch={onLaunch} onCancel={() => {}} />;
  await act(async () => root.render(view(true)));
  const input = host.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "draft-fixture");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const select = host.querySelector("select")!;
  await act(async () => { select.value = "grok"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await click("grok work");
  await act(async () => root.render(view(false)));
  await act(async () => root.render(view(true)));
  await click(setupStrings.launch);
  expect(onLaunch.mock.calls[0][0]).toMatchObject({ name: "draft-fixture", paneSpecs: { 0: { account: "grok-work" } } });
});

describe("L-3 full new-workspace account path", () => {
  it.each(["claude", "codex", "grok"])("carries the explicit %s account through the setup result into the real tab options", async provider => {
    let result: WorkspaceSetupResult | undefined;
    await act(async () => root.render(<WorkspaceSetup defaultCwd="fixture-work" onCancel={() => {}} onLaunch={value => { result = value; }} />));
    const select = host.querySelector<HTMLSelectElement>("select")!;
    await act(async () => { select.value = provider; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await click(setupStrings.launch);
    const defaults = useWorkspaceLayoutStore.getState().buildInitialPanes("fixture-default", "1x1", result!.paneSpecs).panes[0].tabs[0];
    expect(defaults.launchEnv).toEqual({ MYCMUX_LAUNCH_TARGET: provider });
    expect(defaults.agentAccountId).toBeUndefined();
    await click(provider + " work");
    await click(setupStrings.launch);
    const tab = useWorkspaceLayoutStore.getState().buildInitialPanes("fixture-explicit", "1x1", result!.paneSpecs).panes[0].tabs[0];
    expect(tab.launchEnv).toEqual({ MYCMUX_LAUNCH_TARGET: provider, MYCMUX_LAUNCH_ACCOUNT: provider + "-work" });
    expect(tab.agentAccountId).toBe(provider + "-work");
    expect(tab.agentKind).toBe(provider);
    const defaultChip = [...host.querySelectorAll<HTMLButtonElement>("[data-launch-account-row] button")].find(button => button.textContent === launcherStrings.specDefault)!;
    await act(async () => defaultChip.click());
    await click(setupStrings.launch);
    expect(useWorkspaceLayoutStore.getState().buildInitialPanes("fixture-reset", "1x1", result!.paneSpecs).panes[0].tabs[0].agentAccountId).toBeUndefined();
  });
});

it.each(["claude", "codex", "grok"])("L12b round 2 keeps the real %s import ID in a new workspace tab", async provider => {
  const id = `unregistered-${provider}-2026-11-24T11-05-06.789+00-00-aabbccdd`;
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "list_cli_accounts") return { profiles: [{ id, provider, label: "Imported account" }] };
    if (command === "get_cli_launch_tokens") return [{ profile_id: id, expires_at: "2099-01-01T00:00:00Z" }];
    if (command === "list_cli_account_homes") return [{ provider, profile_id: id, state: "ready" }];
    return undefined;
  });
  const onLaunch = vi.fn();
  await act(async () => root.render(<WorkspaceSetup onCancel={() => {}} onLaunch={onLaunch} />));
  const select = host.querySelector("select")!;
  await act(async () => { select.value = provider; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await click("Imported account");
  await click(setupStrings.launch);
  const result: WorkspaceSetupResult = onLaunch.mock.calls[0][0];
  const tab = useWorkspaceLayoutStore.getState().buildInitialPanes("fixture-imported", "1x1", result.paneSpecs).panes[0].tabs[0];
  expect(tab.launchEnv).toEqual({ MYCMUX_LAUNCH_TARGET: provider, MYCMUX_LAUNCH_ACCOUNT: id });
  expect(tab.agentAccountId).toBe(id);
});
