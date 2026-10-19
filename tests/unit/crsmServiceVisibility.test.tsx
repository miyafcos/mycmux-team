// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CrsmSessionEntry } from "../../src/lib/ipc";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
import CrsmPalette from "../../src/components/CommandPalette/CrsmPalette";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useAgentServiceDetectionStore } from "../../src/stores/agentServiceDetectionStore";
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView = () => {};
const sessions: CrsmSessionEntry[] = (["claude", "codex", "claude-codex"] as const).map(kind => ({ kind, id: kind + "-record", cwd: "/synthetic", label: kind + "-record", preview: "recorded-" + kind, last_activity: "2026-10-16T00:00:00Z", source: kind === "claude" ? "claude-live" : "codex-jsonl", source_path: "", files_modified: [], incomplete_tasks: [], has_user_messages: true }));
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  useSettingsStore.setState({ agentServiceVisibility: {}, crsmShowClaude: true, crsmShowCodex: true, crsmShowClaudeCodex: true });
  useAgentServiceDetectionStore.setState({ detection: { status: "idle" } });
  mocks.invoke.mockImplementation(async (command: string) => command === "crsm_list_sessions" ? { sessions, cacheAgeMs: 0, cacheGeneratedAtMs: Date.now(), cacheTtlMs: 60000, refreshing: false } : command.startsWith("plugin:path|") ? "/synthetic" : null);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
describe("Ctrl+P service choices (T9)", () => {
  it("removes target/filter choices, moves a hidden target, and keeps all recorded sessions", async () => {
    await act(async () => root.render(<CrsmPalette open onClose={vi.fn()} />));
    await vi.waitFor(() => expect(host.querySelectorAll(".cmux-crsm-item")).toHaveLength(3), { timeout: 5000 });
    const radios = () => [...host.querySelectorAll<HTMLButtonElement>(".cmux-crsm-target-button")];
    await act(async () => radios().find(button => button.textContent?.startsWith("Codex"))!.click());
    expect(radios().find(button => button.getAttribute("aria-checked") === "true")!.textContent).toContain("Codex");
    await act(async () => useSettingsStore.getState().setAgentServiceVisible("codex", false));
    expect(radios()).toHaveLength(2);
    expect(radios().find(button => button.getAttribute("aria-checked") === "true")!.textContent).toContain("Claude Code");
    const filters = [...host.querySelectorAll<HTMLButtonElement>(".cmux-crsm-filter-button")];
    expect(filters).toHaveLength(3);
    expect(filters.some(button => button.textContent === "Codex")).toBe(false);
    expect(host.querySelectorAll(".cmux-crsm-item")).toHaveLength(3);
    expect(host.textContent).toContain("codex-record");
    expect(useSettingsStore.getState().crsmShowCodex).toBe(true);
    await act(async () => { useSettingsStore.getState().setAgentServiceVisible("claude", false); useSettingsStore.getState().setAgentServiceVisible("claude-codex", false); });
    expect(radios()).toHaveLength(0);
    expect(host.querySelectorAll(".cmux-crsm-filter-button")).toHaveLength(1);
    expect(host.querySelectorAll(".cmux-crsm-item")).toHaveLength(3);
    const count = mocks.invoke.mock.calls.length;
    await act(async () => host.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(mocks.invoke.mock.calls.slice(count).some(([command]) => command === "crsm_create_handoff")).toBe(false);
  });
});
