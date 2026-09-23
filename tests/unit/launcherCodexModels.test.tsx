// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: { launcherHiddenIds: [], crsmShowClaude: true, crsmShowCodex: true, crsmShowClaudeCodex: true, hideSessionsWithoutUserMessages: true },
  dirs: { view: null, load: async () => {} },
  layout: { addTabToPaneWithOptions: vi.fn(), addWebTabToPane: vi.fn(), removeTabFromPane: vi.fn() },
  ui: { setActivePaneId: vi.fn(), requestSettingsTab: vi.fn() },
}));
vi.mock("../../src/lib/ipc", () => ({ crsmListSessions: async () => [], launcherRecordDirMru: async () => {} }));
vi.mock("../../src/stores/settingsStore", () => ({ useSettingsStore: (select: (s: typeof mocks.settings) => unknown) => select(mocks.settings) }));
vi.mock("../../src/stores/launcherDirsStore", () => ({ useLauncherDirsStore: (select: (s: typeof mocks.dirs) => unknown) => select(mocks.dirs) }));
vi.mock("../../src/stores/workspaceLayoutStore", () => ({ useWorkspaceLayoutStore: (select: (s: typeof mocks.layout) => unknown) => select(mocks.layout) }));
vi.mock("../../src/stores/uiStore", () => ({ useUiStore: Object.assign((select: (s: typeof mocks.ui) => unknown) => select(mocks.ui), { getState: () => mocks.ui }) }));

import LauncherPane from "../../src/components/workspace/LauncherPane";
import AgentSelector from "../../src/components/setup/AgentSelector";
import { launcherStrings as S } from "../../src/components/workspace/launcherStrings";
import type { PaneLaunchSpec } from "../../src/lib/agentCatalog";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView = () => {};
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((b) => b.textContent === label || b.getAttribute("aria-label") === label);
  expect(found, label).toBeDefined();
  return found!;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function openCodex() {
  await act(async () => root.render(<LauncherPane workspaceId="ws" paneId="pane" tabId="tab" sessionId="session" isActive />));
  await click(S.specTooltip("Codex"));
}
function specButtons() {
  return [...host.querySelectorAll("[data-launcher-spec] button")].map((b) => b.textContent);
}
function launchedEnv() {
  return mocks.layout.addTabToPaneWithOptions.mock.calls.at(-1)?.[2]?.launchEnv;
}

describe("Codex launch choices", () => {
  it.each([["Sol (6)", "gpt-6-sol"], ["Luna (6 light)", "gpt-6-luna"]])("launches the current %s with its actual model id", async (label, model) => {
    await openCodex();
    expect(specButtons()).not.toContain("none");
    await click(label);
    await click("high");
    await click(S.launchButton);
    expect(launchedEnv()).toEqual({ MYCMUX_LAUNCH_TARGET: "codex", MYCMUX_LAUNCH_MODEL: model, MYCMUX_LAUNCH_EFFORT: "high" });
  });

  it.each(["Luna (6 light)", "Luna (5.6)"])("clears ultra when switching from Sol to %s", async (label) => {
    await openCodex();
    await click("Sol (6)");
    await click("ultra");
    await click(label);
    expect(specButtons()).not.toContain("ultra");
    expect(specButtons()).toContain("max");
    await click(S.launchButton);
    expect(launchedEnv()).not.toHaveProperty("MYCMUX_LAUNCH_EFFORT");
  });

  it("caps keyboard effort cycling at max for Luna", async () => {
    await openCodex();
    await click("Luna (6 light)");
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    await click(S.launchButton);
    expect(launchedEnv()?.MYCMUX_LAUNCH_EFFORT).toBe("max");
  });

  it("keeps compatible effort on a model switch and leaves default launch unset", async () => {
    await openCodex();
    await click(S.launchButton);
    expect(launchedEnv()).toEqual({ MYCMUX_LAUNCH_TARGET: "codex" });
    await click("Sol (6)");
    await click("max");
    await click("Luna (6 light)");
    await click(S.launchButton);
    expect(launchedEnv()?.MYCMUX_LAUNCH_EFFORT).toBe("max");
  });
});

describe("workspace setup Codex choices", () => {
  it("offers current models and clears an unsupported effort on typed model change", async () => {
    let current: PaneLaunchSpec = {};
    function Setup() {
      const [spec, setSpec] = useState<PaneLaunchSpec>({ target: "codex", model: "gpt-6-sol", effort: "ultra" });
      current = spec;
      return <AgentSelector slotIndex={0} value={spec} onChange={setSpec} />;
    }
    await act(async () => root.render(<Setup />));
    const ids = [...host.querySelectorAll("datalist option")].map((option) => option.getAttribute("value"));
    expect(ids).toContain("gpt-6-sol");
    expect(ids).toContain("gpt-6-luna");
    const input = host.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "gpt-6-luna");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(current).toEqual({ target: "codex", model: "gpt-6-luna", effort: "" });
    const efforts = [...host.querySelectorAll("select:last-child option")].map((option) => option.getAttribute("value"));
    expect(efforts).not.toContain("ultra");
    expect(efforts).not.toContain("none");
    expect(efforts).toContain("max");
  });
});
