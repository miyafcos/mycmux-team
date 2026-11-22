// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  codexChoices: vi.fn(),
  claudeCodexChoices: vi.fn(),
  settings: { launcherHiddenIds: [], crsmShowClaude: true, crsmShowCodex: true, crsmShowClaudeCodex: true, hideSessionsWithoutUserMessages: true },
  dirs: { view: null, load: async () => {} },
  layout: { addTabToPaneWithOptions: vi.fn(), addWebTabToPane: vi.fn(), removeTabFromPane: vi.fn() },
  ui: { setActivePaneId: vi.fn(), requestSettingsTab: vi.fn() },
}));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tauri-apps/api/core")>(),
  invoke: (command: string) => {
    if (command === "codex_model_choices") return mocks.codexChoices();
    if (command === "claude_codex_model_choices") return mocks.claudeCodexChoices();
    return Promise.resolve([]);
  },
}));
vi.mock("../../src/lib/ipc", () => ({ crsmListSessions: async () => [], launcherRecordDirMru: async () => {} }));
vi.mock("../../src/stores/settingsStore", () => ({ useSettingsStore: (select: (s: typeof mocks.settings) => unknown) => select(mocks.settings) }));
vi.mock("../../src/stores/launcherDirsStore", () => ({ useLauncherDirsStore: (select: (s: typeof mocks.dirs) => unknown) => select(mocks.dirs) }));
vi.mock("../../src/stores/workspaceLayoutStore", () => ({ useWorkspaceLayoutStore: (select: (s: typeof mocks.layout) => unknown) => select(mocks.layout) }));
vi.mock("../../src/stores/uiStore", () => ({ useUiStore: Object.assign((select: (s: typeof mocks.ui) => unknown) => select(mocks.ui), { getState: () => mocks.ui, subscribe: () => () => {} }) }));

import LauncherPane from "../../src/components/workspace/LauncherPane";
import AgentSelector from "../../src/components/setup/AgentSelector";
import { launcherStrings as S } from "../../src/components/workspace/launcherStrings";
import { buildLaunchSpecEnv, getCatalogEntry, type ModelChoice, type PaneLaunchSpec } from "../../src/lib/agentCatalog";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const scrollIntoView = vi.fn();
Element.prototype.scrollIntoView = scrollIntoView;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.codexChoices.mockReset().mockResolvedValue([]);
  mocks.claudeCodexChoices.mockReset().mockResolvedValue([]);
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
async function renderLauncher() {
  await act(async () => root.render(<LauncherPane workspaceId="ws" paneId="pane" tabId="tab" sessionId="session" isActive />));
}
async function openCodex() {
  await renderLauncher();
  await click(S.specTooltip("Codex"));
}
function deferChoices(mock = mocks.codexChoices) {
  let resolve!: (choices: ModelChoice[]) => void;
  mock.mockReturnValueOnce(new Promise<ModelChoice[]>((done) => { resolve = done; }));
  return (choices: ModelChoice[]) => act(async () => resolve(choices));
}
async function pressKey(key: string, target: EventTarget = document) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  await act(async () => target.dispatchEvent(event));
  return !event.defaultPrevented;
}
async function pressFocusedKey(key: string) {
  const target = document.activeElement ?? document;
  if (await pressKey(key, target) && key.length === 1 && target instanceof HTMLInputElement) {
    // jsdom does not apply the text insertion default action of a keydown.
    await typeModel(target, target.value + key);
  }
}
function modelInput(): HTMLInputElement {
  const input = host.querySelector<HTMLInputElement>(`[data-launcher-spec] input[aria-label="${S.modelLabel}"]`);
  expect(input).not.toBeNull();
  return input!;
}
async function typeModel(input: HTMLInputElement, model: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, model);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function specButtons() {
  return [...host.querySelectorAll("[data-launcher-spec] button")].map((b) => b.textContent);
}
function launchedEnv() {
  return mocks.layout.addTabToPaneWithOptions.mock.calls.at(-1)?.[2]?.launchEnv;
}

describe("Codex launch choices", () => {
  it.each([
    ["Sol (6.2)", "gpt-6.2-sol"],
    ["Astra (6.2)", "gpt-6.2-astra"],
    ["Sol (6)", "gpt-6-sol"],
    ["Luna (6 light)", "gpt-6-luna"],
  ])("launches %s with its actual model id", async (label, model) => {
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

describe("Codex cache in the launchers", () => {
  it("renders a cached label as text and launches with its supported effort", async () => {
    const label = '<img src="model-probe" alt="Future model">';
    mocks.codexChoices.mockResolvedValueOnce([{ value: "gpt-future-test", label, efforts: ["low", "xhigh"] }]);
    await openCodex();
    expect(specButtons()).toContain(label);
    expect(host.querySelector('[data-launcher-spec] img[src="model-probe"]')).toBeNull();
    await click(label);
    expect(specButtons()).toContain("xhigh");
    expect(specButtons()).not.toContain("ultra");
    expect(specButtons()).not.toContain("max");
    await click("xhigh");
    await click(S.launchButton);
    expect(launchedEnv()).toEqual({
      MYCMUX_LAUNCH_TARGET: "codex", MYCMUX_LAUNCH_MODEL: "gpt-future-test", MYCMUX_LAUNCH_EFFORT: "xhigh",
    });
  });

  it("shows all ten fixed Codex models when the cache has no valid rows", async () => {
    // The Rust reader returns [] when every malformed row is discarded.
    mocks.codexChoices.mockResolvedValueOnce([]);
    await openCodex();
    const choices = [...host.querySelectorAll<HTMLButtonElement>("[data-launcher-spec] button[title]")];
    expect(choices.map((choice) => choice.title)).toEqual(getCatalogEntry("codex")!.models.map(({ value }) => value));
    expect(choices).toHaveLength(10);
  });

  it("starts each Codex opening with fixed models and requires reselecting a removed model", async () => {
    mocks.codexChoices.mockResolvedValueOnce([{ value: "gpt-prior", label: "Prior", efforts: ["low"] }]);
    await openCodex();
    expect(specButtons()).toContain("Prior");
    await click(S.cancel);
    const finish = deferChoices();
    await click(S.specTooltip("Codex"));
    expect(mocks.codexChoices).toHaveBeenCalledTimes(2);
    expect(specButtons()).not.toContain("Prior");
    await click("Sol (6.2)");

    await finish([{ value: "gpt-next", label: "Next", efforts: ["low"] }]);
    expect(specButtons()).not.toContain("gpt-6.2-sol");
    expect(host.querySelector("[data-launcher-spec] [role=status]")?.textContent).toContain("gpt-6.2-sol");
    expect(button(S.launchButton).disabled).toBe(true);
    await pressKey("Enter");
    expect(launchedEnv()).toBeUndefined();

    await click("Next");
    await click(S.launchButton);
    expect(launchedEnv()).toEqual({ MYCMUX_LAUNCH_TARGET: "codex", MYCMUX_LAUNCH_MODEL: "gpt-next" });
  });

  it("lets the user reset a fallback effort removed by the Codex cache", async () => {
    const finish = deferChoices();
    await openCodex();
    await click("Sol (6.2)");
    await click("high");
    await finish([{ value: "gpt-6.2-sol", label: "Sol", efforts: [] }]);

    expect(specButtons()).not.toContain("high");
    expect(host.querySelector("[data-launcher-spec] [role=status]")?.textContent).toContain("high");
    expect(button(S.launchButton).disabled).toBe(true);
    await pressKey("ArrowDown");
    scrollIntoView.mockClear();
    await pressKey("ArrowUp");
    expect(scrollIntoView.mock.contexts.at(-1)?.textContent).toBe(S.effortLabel);
    await pressKey("ArrowRight");
    await click(S.launchButton);
    expect(launchedEnv()).toEqual({ MYCMUX_LAUNCH_TARGET: "codex", MYCMUX_LAUNCH_MODEL: "gpt-6.2-sol" });
  });

  it("keeps a saved pick visible while loading available models in workspace setup", async () => {
    mocks.codexChoices.mockResolvedValueOnce([{ value: "gpt-future-test", label: "Test", efforts: ["low"] }]);
    const value = { target: "codex", model: "gpt-future-test", effort: "max" };
    const onChange = vi.fn();
    await act(async () => root.render(
      <AgentSelector workspaceInstanceId={1} slotIndex={0} value={value} onChange={onChange} />,
    ));
    expect(host.querySelector("datalist option")?.getAttribute("value")).toBe("gpt-future-test");
    expect(host.querySelector("input")?.value).toBe(value.model);
    const efforts = host.querySelector<HTMLSelectElement>("select:last-child");
    expect(efforts?.value).toBe("max");
    expect([...efforts!.options].map((option) => option.value)).toEqual(["", "max", "low"]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each(["pending", "replacement"] as const)("launches an installed claude-codex pick on a %s reopen", async (response) => {
    const installed = { value: "fugu-ultra", label: "Fugu Ultra" };
    mocks.claudeCodexChoices.mockResolvedValueOnce([installed]);
    await renderLauncher();
    await click(S.specTooltip("claude-codex"));
    expect(specButtons()).toContain(installed.label);
    await click(S.cancel);

    if (response === "replacement") {
      mocks.codexChoices.mockResolvedValueOnce([{ value: "gpt-other", label: "Other catalog" }]);
      await click(S.specTooltip("Codex"));
      expect(specButtons()).toContain("Other catalog");
      await click(S.cancel);
    }

    const finish = deferChoices(mocks.claudeCodexChoices);
    await click(S.specTooltip("claude-codex"));
    expect(mocks.claudeCodexChoices).toHaveBeenCalledTimes(2);
    expect(specButtons()).not.toContain("Sol (6.2)");
    await click(installed.label);

    if (response === "replacement") {
      await finish([{ value: "next-installed", label: "Next installed" }]);
      expect(specButtons()).toContain("Next installed");
      expect(specButtons()).not.toContain(installed.label);
      expect(specButtons()).not.toContain(installed.value);
    }
    await click(S.launchButton);
    expect(launchedEnv()).toEqual({ MYCMUX_LAUNCH_TARGET: "claude-codex", MYCMUX_LAUNCH_MODEL: installed.value });
  });

  it("scrolls to a newly visible notice once, then follows the selected effort", async () => {
    const finish = deferChoices();
    await openCodex();
    await click("Sol (6.2)");
    await finish([{ value: "other-model", label: "Other model", efforts: ["low", "high"] }]);
    const notice = host.querySelector("[data-launcher-spec] [role=status]");
    expect(notice?.textContent).toContain("gpt-6.2-sol");
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(notice);
    scrollIntoView.mockClear();
    await pressKey("ArrowDown");
    await pressKey("ArrowRight");
    expect(scrollIntoView.mock.contexts).not.toContain(notice);
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(button("low"));
    scrollIntoView.mockClear();
    await pressKey("ArrowUp");
    expect(scrollIntoView.mock.contexts.at(-1)?.textContent).toBe(S.modelLabel);
  });

  it("wraps left from Cursor default and launches the last fixed model", async () => {
    await renderLauncher();
    await click(S.specTooltip("Cursor"));
    await pressKey("ArrowLeft", document.activeElement ?? document);
    await pressKey("Enter", document.activeElement ?? document);
    expect(launchedEnv()).toEqual({ MYCMUX_LAUNCH_TARGET: "cursor", MYCMUX_LAUNCH_MODEL: "gemini-3.1-pro" });
  });

  it.each(["codex", "claude-codex", "cursor", "claude", "grok", "agy", "omp"])(
    "opens manual input with F2 and launches an unlisted model for %s", async (target) => {
      await renderLauncher();
      await click(S.specTooltip(getCatalogEntry(target)!.label));
      const search = host.querySelector<HTMLInputElement>(`input[aria-label="${S.searchPlaceholder}"]`);
      expect(document.activeElement).toBe(search);

      await pressFocusedKey("F2");
      expect(document.activeElement).toBe(modelInput());
      await pressFocusedKey("Escape");
      expect(document.activeElement).toBe(search);
      expect(button(S.modelManual).getAttribute("aria-pressed")).toBe("false");

      await pressFocusedKey("F2");
      const input = modelInput();
      expect(document.activeElement).toBe(input);
      const id = "bespoke/model-id";
      for (const key of id) await pressFocusedKey(key);
      expect(input.value).toBe(id);
      await pressFocusedKey("Enter");
      expect(launchedEnv()).toEqual({ MYCMUX_LAUNCH_TARGET: target, MYCMUX_LAUNCH_MODEL: id });
    },
  );

  it("leaves Hermes model input and search unchanged on F2", async () => {
    await renderLauncher();
    await click(S.specTooltip("Hermes"));
    const input = modelInput();
    expect(document.activeElement).toBe(input);
    await pressFocusedKey("h");
    await pressFocusedKey("F2");
    expect(document.activeElement).toBe(input);

    await pressFocusedKey("Tab");
    const search = host.querySelector<HTMLInputElement>(`input[aria-label="${S.searchPlaceholder}"]`);
    expect(document.activeElement).toBe(search);
    await pressFocusedKey("F2");
    expect(document.activeElement).toBe(search);
    expect(input.value).toBe("h");
    expect(specButtons()).not.toContain(S.modelManual);
    expect(launchedEnv()).toBeUndefined();
  });

  it.each(["click", "Enter", "Space"] as const)("opens manual Cursor input by %s and launches its ID", async (action) => {
    await renderLauncher();
    await click(S.specTooltip("Cursor"));
    const manual = button(S.modelManual);
    expect(manual.previousElementSibling?.getAttribute("title")).toBe("gemini-3.1-pro");
    if (action === "click") {
      await click(S.modelManual);
    } else {
      await act(async () => manual.focus());
      await pressKey(action === "Space" ? " " : action, manual);
    }
    expect(mocks.layout.addTabToPaneWithOptions).not.toHaveBeenCalled();
    const input = modelInput();
    expect(document.activeElement).toBe(input);
    await typeModel(input, "bespoke/model-id");
    await pressKey("Enter", input);
    expect(launchedEnv()).toEqual({ MYCMUX_LAUNCH_TARGET: "cursor", MYCMUX_LAUNCH_MODEL: "bespoke/model-id" });
  });

  it("scrolls the model and effort choices separately from the launch controls", async () => {
    const efforts = Array.from({ length: 40 }, (_, i) => `effort-${i + 1}`);
    mocks.codexChoices.mockResolvedValueOnce([{ value: "gpt-many-efforts", label: "Many efforts", efforts }]);
    await openCodex();
    await click("Many efforts");
    const lastEffort = button("effort-40");
    const options = lastEffort.closest<HTMLElement>("[data-launcher-spec-options]");
    const launch = button(S.launchButton);
    expect(options?.contains(button("Many efforts"))).toBe(true);
    expect(options?.style.overflowY).toBe("auto");
    expect(Number.parseFloat(options?.style.minHeight ?? "")).toBe(0);
    expect(options?.contains(launch)).toBe(false);
    expect(launch.closest("[data-launcher-spec]")).toBe(options?.parentElement);
    expect(launch.parentElement?.style.flexShrink).toBe("0");
    await click("effort-40");
    await click(S.launchButton);
    expect(launchedEnv()?.MYCMUX_LAUNCH_EFFORT).toBe("effort-40");
  });

  it("keeps the launch control reachable with the curated Cursor catalog", async () => {
    await act(async () => root.render(<LauncherPane workspaceId="ws" paneId="pane" tabId="tab" sessionId="session" isActive />));
    await click(S.specTooltip("Cursor"));
    const lastId = "gemini-3.1-pro";
    const last = host.querySelector<HTMLButtonElement>(`[data-launcher-spec] button[title="${lastId}"]`);
    expect(last?.parentElement?.querySelectorAll("button[title]")).toHaveLength(25);
    expect(last?.parentElement?.style.overflowY).toBe("auto");
    await act(async () => last!.click());
    await click(S.launchButton);
    expect(launchedEnv()).toEqual({ MYCMUX_LAUNCH_TARGET: "cursor", MYCMUX_LAUNCH_MODEL: lastId });
  });
});

describe.each(["Enter", "launch button"] as const)("manual Cursor launch via %s", (submit) => {
  it.each([
    ["empty", "", ""],
    ["whitespace only", " \t ", ""],
    ["valid 128 characters", "a".repeat(128), "a".repeat(128)],
    ["invalid 129 characters", "a".repeat(129), null],
    ["interior whitespace", "not model", null],
    ["leading hyphen", "-not-model", null],
  ] as const)("checks a model ID with %s", async (_name, value, expected) => {
    await renderLauncher();
    await click(S.specTooltip("Cursor"));
    await click(S.modelManual);
    const input = modelInput();
    await typeModel(input, value);
    expect(input.getAttribute("aria-invalid")).toBe(expected === null ? "true" : null);
    if (submit === "Enter") await pressKey("Enter", input);
    else await click(S.launchButton);

    if (expected === null) {
      expect(mocks.layout.addTabToPaneWithOptions).not.toHaveBeenCalled();
    } else {
      expect(launchedEnv()).toEqual({
        MYCMUX_LAUNCH_TARGET: "cursor",
        ...(expected ? { MYCMUX_LAUNCH_MODEL: expected } : {}),
      });
    }
  });
});

describe("workspace setup Codex choices", () => {
  it("offers current models and clears an unsupported effort on typed model change", async () => {
    let current: PaneLaunchSpec = {};
    function Setup() {
      const [spec, setSpec] = useState<PaneLaunchSpec>({ target: "codex", model: "gpt-6-sol", effort: "ultra" });
      current = spec;
      return <AgentSelector workspaceInstanceId={1} slotIndex={0} value={spec} onChange={setSpec} />;
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

describe("saved Antigravity launch choices", () => {
  it.each([
    "claude-opus-5-5-high",
    "claude-opus-5-5-medium",
    "claude-opus-5-5-low",
    "claude-sonnet-5-5-high",
    "claude-sonnet-5-5-medium",
    "claude-sonnet-5-5-low",
  ])("retains the saved %s ID and effort as a typed choice", async (model) => {
    const value = { target: "agy", model, effort: "high" };
    const onChange = vi.fn();
    await act(async () => root.render(
      <AgentSelector workspaceInstanceId={1} slotIndex={0} value={value} onChange={onChange} />,
    ));
    const ids = [...host.querySelectorAll("datalist option")].map((option) => option.getAttribute("value"));
    expect(ids).not.toContain(model);
    expect(host.querySelector("input")?.value).toBe(model);
    expect(onChange).not.toHaveBeenCalled();
    expect(buildLaunchSpecEnv(value)).toEqual({
      MYCMUX_LAUNCH_TARGET: "agy",
      MYCMUX_LAUNCH_MODEL: model,
      MYCMUX_LAUNCH_EFFORT: "high",
    });
  });
});
