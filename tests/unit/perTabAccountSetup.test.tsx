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
