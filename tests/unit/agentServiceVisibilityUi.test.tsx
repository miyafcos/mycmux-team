// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), dirs: { view: null, load: vi.fn(async () => {}), loading: false, scanning: false, error: null } }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("../../src/stores/launcherDirsStore", () => ({ useLauncherDirsStore: (select?: (state: typeof mocks.dirs) => unknown) => select ? select(mocks.dirs) : mocks.dirs }));
import { LAUNCHABLE_AGENTS, AGENT_CATALOG } from "../../src/lib/agentCatalog";
import { agentServiceVisibilityStrings as T } from "../../src/lib/agentServiceVisibilityStrings";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useAgentServiceDetectionStore } from "../../src/stores/agentServiceDetectionStore";
import { AgentServicesTab } from "../../src/components/settings/tabs/AgentServicesTab";
import { LauncherTab } from "../../src/components/settings/tabs/LauncherTab";
import SettingsDialog from "../../src/components/settings/SettingsDialog";
import LauncherPane from "../../src/components/workspace/LauncherPane";
import AgentSelector from "../../src/components/setup/AgentSelector";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView = () => {};
let host: HTMLDivElement, root: Root;
const session = { kind: "claude", id: "kept-session", label: "kept-record", cwd: "/synthetic", preview: "recorded prompt", last_activity: "2026-10-16T00:00:00Z", source: "claude-live", source_path: "", files_modified: [], incomplete_tasks: [] };
const installed = Object.fromEntries(LAUNCHABLE_AGENTS.map(({ target }) => [target, target !== "omp"]));
beforeEach(() => {
  localStorage.clear();
  useSettingsStore.setState({ agentServiceVisibility: {}, launcherHiddenIds: [], crsmShowClaude: true, crsmShowCodex: true, crsmShowClaudeCodex: true });
  useAgentServiceDetectionStore.setState({ detection: { status: "idle" } });
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string) => command === "detect_agent_services" ? { status: "success", installed } : command === "crsm_list_sessions" ? { sessions: [session], cacheAgeMs: 0, cacheGeneratedAtMs: Date.now(), cacheTtlMs: 60000, refreshing: false } : null);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
async function render(node: ReactNode) { await act(async () => root.render(node)); }
const labels = () => [...host.querySelectorAll("label")];
const launch = () => <LauncherPane workspaceId="ws" paneId="pane" tabId="tab" sessionId="session" isActive={false} />;

describe("launcher and setup service choices", () => {
  it("T3 hides new-launch services and existing hidden ids, retaining Web and resume records", async () => {
    useSettingsStore.setState({ agentServiceVisibility: { claude: false, hermes: false }, launcherHiddenIds: ["codex", "web-grok"] });
    await render(launch());
    expect(host.querySelector('button[title="Claude Code"]')).toBeNull();
    expect(host.querySelector('button[title="Hermes"]')).toBeNull();
    expect(host.querySelector('button[title="Codex"]')).toBeNull();
    for (const item of AGENT_CATALOG.filter(item => item.kind === "web")) {
      expect(!!host.querySelector('button[title="' + item.label + '"]')).toBe(item.target !== "web-grok");
    }
    expect(host.textContent).toContain("recorded prompt");
    expect(host.querySelector('button[title="Cursor"]')).not.toBeNull();
  });
  it("T3 closes a launch-spec editor when its service becomes hidden", async () => {
    await render(launch());
    const spec = [...host.querySelectorAll<HTMLButtonElement>("button[aria-label]")].find(button => button.getAttribute("aria-label")?.includes("Hermes"))!;
    await act(async () => spec.click());
    expect(host.querySelector("[data-launcher-spec]")).not.toBeNull();
    await act(async () => useSettingsStore.getState().setAgentServiceVisible("hermes", false));
    expect(host.querySelector("[data-launcher-spec]")).toBeNull();
  });
  it("T5 filters launcher settings and keeps the existing row toggle and Web checks", async () => {
    useSettingsStore.setState({ agentServiceVisibility: { hermes: false } });
    await render(<LauncherTab />);
    expect(labels().some(label => label.textContent?.includes("Hermes"))).toBe(false);
    expect(host.textContent).toContain(T.launcherMoreNote);
    expect(labels().some(label => label.textContent?.includes("ChatGPT"))).toBe(true);
    const codex = labels().find(label => label.textContent?.includes("Codex") && !label.textContent?.includes("claude-codex"))!;
    await act(async () => codex.querySelector<HTMLInputElement>("input")!.click());
    expect(useSettingsStore.getState().launcherHiddenIds).toContain("codex");
    expect(useSettingsStore.getState().agentServiceVisibility).toEqual({ hermes: false });
  });
  it("T6 removes hidden setup options but retains the selected hidden service", async () => {
    useSettingsStore.setState({ agentServiceVisibility: { hermes: false, omp: false } });
    await render(<AgentSelector slotIndex={0} value={{ target: "claude" }} onChange={vi.fn()} />);
    expect(host.querySelector('option[value="hermes"]')).toBeNull();
    expect(host.querySelector('option[value="omp"]')).toBeNull();
    await render(<AgentSelector slotIndex={0} value={{ target: "hermes" }} onChange={vi.fn()} />);
    expect(host.querySelector('option[value="hermes"]')).not.toBeNull();
    expect(host.querySelector('option[value="omp"]')).toBeNull();
    expect((host.querySelector("select") as HTMLSelectElement).value).toBe("hermes");
  });
});

describe("services settings tab (T4)", () => {
  it("lists every catalog service, toggles the real store, and shows successful probe states", async () => {
    await render(<AgentServicesTab />);
    expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(LAUNCHABLE_AGENTS.length);
    for (const agent of LAUNCHABLE_AGENTS) expect(labels().some(label => label.textContent?.startsWith(agent.label))).toBe(true);
    expect(host.textContent).toContain(T.detected);
    expect(host.textContent).toContain(T.notDetected);
    const hermes = labels().find(label => label.textContent?.startsWith("Hermes"))!;
    await act(async () => hermes.querySelector<HTMLInputElement>("input")!.click());
    expect(useSettingsStore.getState().agentServiceVisibility.hermes).toBe(false);
    expect(host.textContent).toContain(T.note);
    expect(host.textContent).toContain(T.firstRunNote);
    expect(host.textContent).toContain(T.webNote);
  });
  it("shows detecting and failure states without writing defaults after a failed probe", async () => {
    let reject!: (error: Error) => void;
    mocks.invoke.mockReturnValue(new Promise((_, fail) => { reject = fail; }));
    await render(<AgentServicesTab />);
    expect([...host.querySelectorAll('[role="status"]')].every(row => row.textContent === T.detecting)).toBe(true);
    await act(async () => { reject(new Error("unavailable")); await useAgentServiceDetectionStore.getState().refresh(); });
    expect([...host.querySelectorAll('[role="status"]')].every(row => row.textContent === T.detectFailed)).toBe(true);
    expect(useSettingsStore.getState().agentServiceVisibility).toEqual({});
  });
  it("shows not-yet-checked readiness without a failure or persisted defaults", async () => {
    mocks.invoke.mockResolvedValue({ status: "waiting-for-path" });
    await render(<AgentServicesTab />);
    expect([...host.querySelectorAll('[role="status"]')].every(row => row.textContent === T.notChecked)).toBe(true);
    expect(host.textContent).not.toContain(T.detectFailed);
    expect([...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every(input => input.checked)).toBe(true);
    expect(useSettingsStore.getState().agentServiceVisibility).toEqual({});
  });
  it("appears immediately before Launcher in the Work section", async () => {
    await render(<SettingsDialog initialTab="agentServices" onClose={vi.fn()} onOpenOnlinePanel={vi.fn()} />);
    const navigation = [...document.querySelectorAll(".cmux-settings-nav-item")].map(node => node.textContent);
    const index = navigation.indexOf(T.tabLabel);
    expect(index).toBeGreaterThan(0);
    expect(navigation[index + 1]).toBe("ランチャー");
    expect(host.textContent || document.body.textContent).toContain(T.firstRunNote);
  });
});
