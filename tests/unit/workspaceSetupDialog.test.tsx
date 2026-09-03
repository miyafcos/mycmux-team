/** @vitest-environment jsdom */

/**
 * The New Workspace dialog, walked the way a person walks it: pick an agent,
 * type a model, press Launch — then feed what came out into buildInitialPanes,
 * which is what actually starts the pane. Checking the dialog alone would not
 * prove the choice survives the trip to launchEnv.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WorkspaceSetup, { type WorkspaceSetupResult } from "../../src/components/setup/WorkspaceSetup";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderDialog(props: {
  defaultCwd?: string;
  onLaunch?: (result: WorkspaceSetupResult) => void;
}) {
  const onLaunch = props.onLaunch ?? (() => {});
  act(() => {
    root.render(
      <WorkspaceSetup
        defaultCwd={props.defaultCwd}
        onLaunch={onLaunch}
        onCancel={() => {}}
      />,
    );
  });
}

/** React tracks its own value, so a plain assignment is ignored. */
function setControlValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLSelectElement
    ? HTMLSelectElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  act(() => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function agentSelect(index = 0): HTMLSelectElement {
  const selects = Array.from(container.querySelectorAll("select")).filter((select) =>
    Array.from(select.options).some((option) => option.textContent?.includes("Launch Menu")),
  );
  const select = selects[index];
  if (!select) throw new Error(`no agent select at slot ${index}`);
  return select;
}

function modelInput(index = 0): HTMLInputElement {
  const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('input[list]'));
  const input = inputs[index];
  if (!input) throw new Error(`no model input at slot ${index}`);
  return input;
}

function effortSelect(index = 0): HTMLSelectElement {
  const selects = Array.from(container.querySelectorAll("select")).filter((select) =>
    Array.from(select.options).some((option) => option.value === "" && option.textContent === "effort (default)"),
  );
  const select = selects[index];
  if (!select) throw new Error(`no effort select at slot ${index}`);
  return select;
}

function clickLaunch() {
  const launch = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Launch",
  );
  if (!launch) throw new Error("Launch button is missing");
  act(() => {
    launch.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("WorkspaceSetup", () => {
  it("offers the launcher menu, a shell, and every launchable agent", () => {
    renderDialog({});
    const labels = Array.from(agentSelect().options).map((option) => option.textContent);
    expect(labels).toEqual([
      "> Launch Menu",
      "$ Shell",
      "Claude Code",
      "Codex",
      "claude-codex (Codex Models)",
      "Grok Build",
      "claude-codex (Open Models)",
      "Antigravity (agy)",
    ]);
    // Web rows need a webview, not a PTY, so the dialog must not offer them.
    expect(labels.some((label) => label?.includes("(Web)"))).toBe(false);
  });

  it("seeds the folder and names the workspace after it", () => {
    renderDialog({ defaultCwd: "C:/Users/miyaz/cmux-for-linux-dev-master" });
    const folder = Array.from(container.querySelectorAll<HTMLInputElement>("input")).find(
      (input) => input.value.includes("cmux-for-linux-dev-master"),
    );
    expect(folder).toBeDefined();
    const nameField = container.querySelector<HTMLInputElement>("input");
    expect(nameField?.placeholder).toBe("cmux-for-linux-dev-master");
  });

  it("hides model and effort until an agent is picked", () => {
    renderDialog({});
    expect(container.querySelectorAll("input[list]")).toHaveLength(0);

    setControlValue(agentSelect(), "codex");
    expect(container.querySelectorAll("input[list]")).toHaveLength(1);

    // A plain shell takes no flags either.
    setControlValue(agentSelect(), "shell");
    expect(container.querySelectorAll("input[list]")).toHaveLength(0);
  });

  it("offers the tiers each CLI actually accepts", () => {
    renderDialog({});
    setControlValue(agentSelect(), "codex");
    const datalist = container.querySelector("datalist");
    expect(Array.from(datalist?.querySelectorAll("option") ?? []).map((o) => o.value)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
    // Codex has a "none" step the Claude CLIs do not.
    expect(Array.from(effortSelect().options).map((o) => o.value)).toEqual([
      "",
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);

    setControlValue(agentSelect(), "claude");
    expect(Array.from(effortSelect().options).map((o) => o.value)).toEqual([
      "",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("drops a model that would be read as a flag, but keeps the agent", () => {
    let result: WorkspaceSetupResult | undefined;
    renderDialog({ onLaunch: (value) => { result = value; } });
    setControlValue(agentSelect(), "claude");
    setControlValue(modelInput(), "--dangerous");
    clickLaunch();

    // The dialog carries the raw text; the launch path is what refuses it.
    expect(result?.paneSpecs[0]?.target).toBe("claude");
    const { panes } = useWorkspaceLayoutStore
      .getState()
      .buildInitialPanes("ws-test", "1x1", result!.paneSpecs);
    expect(panes[0].tabs[0].launchEnv).toEqual({ MYCMUX_LAUNCH_TARGET: "claude" });
  });

  it("carries the picked agent, model and effort into the pane's launch env", () => {
    let result: WorkspaceSetupResult | undefined;
    renderDialog({
      defaultCwd: "C:/work/repo",
      onLaunch: (value) => { result = value; },
    });
    setControlValue(agentSelect(), "codex");
    setControlValue(modelInput(), "gpt-5.6-terra");
    setControlValue(effortSelect(), "high");
    clickLaunch();

    expect(result).toMatchObject({
      name: "repo",
      gridTemplateId: "1x1",
      cwd: "C:/work/repo",
      paneSpecs: { 0: { target: "codex", model: "gpt-5.6-terra", effort: "high" } },
    });

    const { panes } = useWorkspaceLayoutStore
      .getState()
      .buildInitialPanes("ws-test", "1x1", result!.paneSpecs);
    expect(panes[0].tabs[0].launchEnv).toEqual({
      MYCMUX_LAUNCH_TARGET: "codex",
      MYCMUX_LAUNCH_MODEL: "gpt-5.6-terra",
      MYCMUX_LAUNCH_EFFORT: "high",
    });
    // The tab identifies as codex before it starts, so the tab bar colours it.
    expect(panes[0].tabs[0].agentKind).toBe("codex");
  });

  it("leaves a pane on the launcher menu when nothing is picked", () => {
    let result: WorkspaceSetupResult | undefined;
    renderDialog({ onLaunch: (value) => { result = value; } });
    clickLaunch();

    const { panes } = useWorkspaceLayoutStore
      .getState()
      .buildInitialPanes("ws-test", "1x1", result!.paneSpecs);
    expect(panes[0].tabs[0].launchEnv).toBeUndefined();
    expect(panes[0].agentId).toBe("shell-starter");
  });
});
