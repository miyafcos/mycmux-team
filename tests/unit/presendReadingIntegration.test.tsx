// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../../src/components/layout/socketCommands", () => ({ handleSocketCommand: vi.fn() }));
vi.mock("../../src/stores/workspaceListStore", () => ({ useWorkspaceListStore: { getState: () => ({ workspaces: [] }) } }));
import { PaneComposer } from "../../src/components/composer/PaneComposer";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { presendDraftFingerprint, presendTab } from "../../src/lib/presendReading";
import { useComposerStore } from "../../src/stores/composerStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useAiSettingsStore } from "../../src/stores/aiSettingsStore";

const session = "real-client-context-invalidation";
function type(host: HTMLDivElement, text: string) {
  const field = host.querySelector("textarea")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
afterEach(() => { useSettingsStore.setState({ presendReadingEnabled: false }); vi.useRealTimers(); vi.unstubAllGlobals(); });
it("threads the hook's isCurrent into the real client's deferred context retrieval", async () => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let release!: (value: unknown[]) => void;
  let batches = 0;
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "get_codex_restore_epoch") return 7;
    if (command === "get_live_events") {
      if (++batches === 1) return new Promise(resolve => { release = resolve; });
      return [];
    }
    if (command === "run_presend_reading") return { reading: "new reading", assumption: "none", missing: "none", provider: "claude", elapsedMs: 1 };
    return null;
  });
  useAiSettingsStore.setState({ aiEnabled: true });
  useSettingsStore.setState({ presendReadingEnabled: true, presendReadingProvider: "claude", paneComposerEnabled: true });
  useComposerStore.getState().clearDraft(session);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(<PaneComposer sessionId={session} target={{ command: "claude" }} />); });
    type(host, "original request text");
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(batches).toBe(1);
    type(host, "different request text");
    await act(async () => release([]));
    expect(mocks.invoke.mock.calls.filter(([name]) => name === "run_presend_reading")).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    const runs = mocks.invoke.mock.calls.filter(([name]) => name === "run_presend_reading");
    expect(runs).toHaveLength(1);
    expect(runs[0][1]).toMatchObject({ draft: "different request text", conversationExcerpt: "" });
    expect(host.querySelector(".cmux-presend-row")?.textContent).toContain("new reading");
  } finally { act(() => root.unmount()); host.remove(); }
});

it.each([
  { label: "Codex", target: { command: "powershell.exe", agentId: "codex" } },
  { label: "Cursor Agent", target: { command: "powershell.exe", launchEnv: { MYCMUX_LAUNCH_TARGET: "cursor" } } },
  {
    label: "shell argument ending in cursor-agent",
    target: { command: "powershell.exe", args: ["-NoExit", "-Command", "cd C:/work/cursor-agent"] },
  },
  { label: "cursor-agent.cmd executable", target: { command: "cursor-agent.cmd" } },
  { label: "saved Cursor Agent kind", target: { command: "powershell.exe", agentKind: "cursor" } },
  { label: "unknown", target: { command: "toy-wrapper", agentKind: "toy-unknown", processTitle: "codex" } },
])("requires a foreground check for every launch ($label)", async ({ label, target }) => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.invoke.mockClear();
  const id = `foreground-check-${label}`;
  const draft = "synthetic draft for the same PTY";
  const reading = { reading: "sample reading", assumption: "none", missing: "none", provider: "claude", elapsedMs: 1 };
  let foregroundAgent = false;
  mocks.invoke.mockImplementation(async (command: string, args?: { requireForegroundAgent?: boolean }) => {
    if (command === "get_codex_restore_epoch") return 7;
    if (command === "get_live_events") return [];
    if (command === "run_presend_reading") return args?.requireForegroundAgent && !foregroundAgent ? null : reading;
    return null;
  });
  useAiSettingsStore.setState({ aiEnabled: true });
  useSettingsStore.setState({ presendReadingEnabled: true, presendReadingProvider: "claude", paneComposerEnabled: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const runs = () => mocks.invoke.mock.calls.filter(([command]) => command === "run_presend_reading");
  try {
    usePaneMetadataStore.getState().setLiveAgent(id, "codex", true);
    act(() => root.render(<PaneComposer sessionId={id} target={target} />));
    type(host, draft);
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(runs()).toHaveLength(1);
    expect(runs()[0][1]).toHaveProperty("requireForegroundAgent", true);
    expect(presendTab(id)?.attempted.has(presendDraftFingerprint(draft))).toBe(false);
    expect(host.textContent).not.toContain(reading.reading);

    foregroundAgent = true;
    type(host, draft + "x");
    type(host, draft);
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(runs()).toHaveLength(2);
    expect(host.querySelector(".cmux-presend-row")?.textContent).toContain(reading.reading);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
