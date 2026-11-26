// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../../src/components/layout/socketCommands", () => ({ handleSocketCommand: vi.fn() }));
vi.mock("../../src/stores/workspaceListStore", () => ({ useWorkspaceListStore: { getState: () => ({ workspaces: [] }) } }));
import { PaneComposer } from "../../src/components/composer/PaneComposer";
import { publishCodexRestoreNoticeEpoch } from "../../src/lib/codexRestoreLifecycle";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { adoptPresendPause, pausePresendTab, presendAttemptKey, presendAttemptLedger, presendTab } from "../../src/lib/presendReading";
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
  mocks.invoke.mockImplementation(async (command: string, args?: { sessionId?: string }) => {
    if (command === "configure_presend_reading" && args?.sessionId) return true;
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
  publishCodexRestoreNoticeEpoch(session, 7);
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
    expect(host.querySelector(".cmux-presend-row .cmux-presend-value")?.textContent).toBe("new reading");
  } finally { act(() => root.unmount()); host.remove(); }
});


it("loads a paused tab when it arrives in a different window and stays paused on return", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.invoke.mockClear();
  const id = "paused-tab-arrives";
  publishCodexRestoreNoticeEpoch(id, 7);
  mocks.invoke.mockImplementation(async (name: string, args?: { sessionId?: string }) => {
    if (name === "configure_presend_reading" && args?.sessionId === id) return false;
    if (name === "get_codex_restore_epoch") return 7;
    if (name === "get_live_events") return [];
    return null;
  });
  useAiSettingsStore.setState({ aiEnabled: true });
  useSettingsStore.setState({ presendReadingEnabled: true, presendReadingProvider: "claude", paneComposerEnabled: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const mount = async () => {
    await act(async () => root.render(<PaneComposer sessionId={id} target={{ command: "claude" }} />));
  };
  try {
    await mount();
    type(host, "synthetic first edited draft");
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    act(() => root.render(null));
    await mount();
    type(host, "synthetic edit after returning");
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(host.querySelector(".cmux-presend-toggle")?.getAttribute("aria-pressed")).toBe("false");
    expect(mocks.invoke.mock.calls.filter(([name]) => name === "run_presend_reading")).toHaveLength(0);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
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
  mocks.invoke.mockImplementation(async (command: string, args?: { requireForegroundAgent?: boolean; sessionId?: string }) => {
    if (command === "configure_presend_reading" && args?.sessionId) return true;
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
    publishCodexRestoreNoticeEpoch(id, 7);
    usePaneMetadataStore.getState().setLiveAgent(id, "codex", true);
    act(() => root.render(<PaneComposer sessionId={id} target={target} />));
    type(host, draft);
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(runs()).toHaveLength(1);
    expect(runs()[0][1]).toHaveProperty("requireForegroundAgent", true);
    expect(presendTab(id)?.attempted.has(presendAttemptKey(draft, "claude"))).toBe(false);
    expect(host.textContent).not.toContain(reading.reading);

    foregroundAgent = true;
    type(host, draft + "x");
    type(host, draft);
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(runs()).toHaveLength(2);
    expect(host.querySelector(".cmux-presend-row .cmux-presend-value")?.textContent).toBe(reading.reading);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it("keeps an unacknowledged pause after the tab becomes visible again", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.invoke.mockClear();
  const id = "pause-write-failed";
  publishCodexRestoreNoticeEpoch(id, 7);
  let acceptPause = false;
  let nativeEnabled = true;
  mocks.invoke.mockImplementation(async (name: string, args?: { sessionId?: string; tabEnabled?: boolean }) => {
    if (name === "configure_presend_reading" && args?.sessionId === id) {
      if (args?.tabEnabled === false && !acceptPause) throw new Error("synthetic IPC failure");
      if (typeof args?.tabEnabled === "boolean") nativeEnabled = args.tabEnabled;
      return nativeEnabled;
    }
    if (name === "get_codex_restore_epoch") return 7;
    if (name === "get_live_events") return [];
    return null;
  });
  useAiSettingsStore.setState({ aiEnabled: true });
  useSettingsStore.setState({ presendReadingEnabled: true, presendReadingProvider: "claude", paneComposerEnabled: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const mount = (visible: boolean) => act(async () => root.render(<PaneComposer sessionId={id} target={{ command: "claude" }} presendVisible={visible} />));
  const toggle = () => host.querySelector<HTMLButtonElement>(".cmux-presend-toggle")!;
  const runs = () => mocks.invoke.mock.calls.filter(([name]) => name === "run_presend_reading");
  try {
    await mount(true);
    await act(async () => toggle().click());
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    await mount(false);
    await mount(true);
    type(host, "edit while pause is unacknowledged");
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(runs()).toHaveLength(0);
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    expect(host.querySelector('[role="status"]')?.textContent).toContain("\u505c\u6b62");
    acceptPause = true;
    await act(async () => toggle().click());
    expect(nativeEnabled).toBe(false);
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    await act(async () => toggle().click());
    type(host, "explicit new edit after resuming");
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(runs()).toHaveLength(1);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

const pauseOrders = ["before delivery", "before new reply", "after new reply"] as const;
it.each(pauseOrders.flatMap(order => [true, false].map(saved => ({ order, saved, oldSaved: true })))
  .concat([{ order: "after new reply", saved: true, oldSaved: false }]))(
  "keeps the delivered pause with the old reply $order (new=$saved, old=$oldSaved)",
  async ({ order, saved, oldSaved }) => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mocks.invoke.mockClear();
    // A second renderer has its own tab map but uses the same native preference.
    vi.resetModules();
    const sender = await import("../../src/lib/presendReading");
    const id = `delivered-pause-${order}-${saved}-${oldSaved}`;
    let shared = true;
    let writes = 0;
    let finishOld!: () => void;
    let finishNew: (() => void) | undefined;
    mocks.invoke.mockImplementation(async (cmd: string, args?: { sessionId?: string; tabEnabled?: boolean }) => {
      if (cmd === "configure_presend_reading" && args?.sessionId === id) {
        if (args.tabEnabled === false) {
          writes++;
          if (writes === 1) {
            shared = false;
            return new Promise<boolean>((resolve, reject) => {
              finishOld = () => oldSaved ? resolve(false) : reject(new Error("old save failed"));
            });
          }
          if (writes === 2) throw new Error("sender save failed");
          if (saved) shared = false;
          return new Promise<boolean>((resolve, reject) => {
            finishNew = () => saved ? resolve(false) : reject(new Error("new save failed"));
          });
        }
        if (args.tabEnabled === true) shared = true;
        return shared;
      }
      if (cmd === "get_codex_restore_epoch") return 7;
      if (cmd === "get_live_events") return [];
      return null;
    });
    useAiSettingsStore.setState({ aiEnabled: true });
    useSettingsStore.setState({ presendReadingEnabled: true, presendReadingProvider: "claude", paneComposerEnabled: true });
    publishCodexRestoreNoticeEpoch(id, 7);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => pausePresendTab(id));
      const local = presendTab(id)!;
      const ledger = presendAttemptLedger(local, 7);
      local.attempted.add("earlier edit");
      ledger.pending.set("pending edit", Promise.resolve());
      expect(await sender.sharedPresendTabEnabled(id)).toBe(false);
      sender.setPresendTabEnabled(id, await sender.sharedPresendTabEnabled(id, true));
      await act(async () => sender.pausePresendTab(id));
      expect(sender.presendTab(id)?.paused).toBe("failed");
      expect(shared).toBe(true);

      // No pause in a delivery must leave even an in-flight local write intact.
      adoptPresendPause(id, false);
      expect(presendTab(id) === local && local.paused === "saving").toBe(true);
      if (order === "before delivery") await act(async () => finishOld());
      await act(async () => adoptPresendPause(id, !!sender.presendTab(id)?.paused));
      if (order === "before new reply") {
        await act(async () => finishOld());
        expect(presendTab(id)?.paused).toBe("saving");
      }
      await act(async () => finishNew?.());
      if (order === "after new reply") await act(async () => finishOld());

      useComposerStore.getState().setDraft(id, "draft carried by the tab");
      await act(async () => root.render(<PaneComposer sessionId={id} target={{ command: "claude" }} />));
      type(host, "edit after receiving the new pause");
      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
      expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "run_presend_reading").length).toBe(0);
      expect(host.querySelector(".cmux-presend-toggle")?.getAttribute("aria-pressed")).toBe("false");
      expect(writes - 1).toBe(2); // Exclude the sender's failed OFF.
      expect(shared).toBe(!saved);
      const adopted = presendTab(id)!;
      expect(adopted.paused).toBe(saved ? undefined : "failed");
      expect(adopted.attempted === local.attempted && adopted.attempted.has("earlier edit")).toBe(true);
      expect(presendAttemptLedger(adopted, 7) === ledger && ledger.pending.has("pending edit")).toBe(true);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);

it.each([
  { reply: "before delivery", written: true },
  { reply: "after delivery", written: true },
  { reply: "while the same draft waits", written: true },
  { reply: "while the same draft waits", written: false },
])("counts requests for the same draft when the read finishes $reply (written=$written)", async ({ reply, written }) => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.invoke.mockClear();
  vi.resetModules();
  const sender = await import("../../src/lib/presendReading");
  const id = "attempt-handoff-" + reply + "-" + written;
  const draft = "first draft in the receiving tab";
  const key = presendAttemptKey(draft, "claude");
  const reads: string[] = [];
  let shared = true;
  let pauses = 0;
  let finishRead!: () => void;
  let acknowledgeFirstPause!: () => void;
  mocks.invoke.mockImplementation(async (command: string, args?: { sessionId?: string; tabEnabled?: boolean; draft?: string }) => {
    if (command === "configure_presend_reading" && args?.sessionId === id) {
      if (args.tabEnabled === false) {
        pauses++;
        if (pauses === 2) throw new Error("sender pause failed");
        shared = false;
        if (pauses === 1) return new Promise<boolean>(resolve => { acknowledgeFirstPause = () => resolve(false); });
      }
      if (args.tabEnabled === true) shared = true;
      return shared;
    }
    if (command === "get_codex_restore_epoch") return 7;
    if (command === "get_live_events") return [];
    if (command === "run_presend_reading") {
      reads.push(args!.draft!);
      if (reads.length === 1) return new Promise(resolve => {
        finishRead = () => resolve({ disposition: written ? "attempted" : "superseded" });
      });
    }
    return null;
  });
  useAiSettingsStore.setState({ aiEnabled: true });
  useSettingsStore.setState({ presendReadingEnabled: true, presendReadingProvider: "claude", paneComposerEnabled: true });
  publishCodexRestoreNoticeEpoch(id, 7);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const mount = () => act(async () => root.render(<PaneComposer sessionId={id} target={{ command: "claude" }} />));
  const toggle = () => host.querySelector<HTMLButtonElement>(".cmux-presend-toggle")!;
  const waitForEdit = () => act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  try {
    await mount();
    type(host, draft);
    await waitForEdit();
    expect(reads).toEqual([draft]);
    const original = presendTab(id)!;
    const ledger = presendAttemptLedger(original, 7);
    expect(ledger.pending.has(key)).toBe(true);

    await act(async () => toggle().click());
    expect(await sender.sharedPresendTabEnabled(id)).toBe(false);
    sender.setPresendTabEnabled(id, await sender.sharedPresendTabEnabled(id, true));
    await act(async () => sender.pausePresendTab(id));
    expect(sender.presendTab(id)?.paused).toBe("failed");
    if (reply === "before delivery") await act(async () => finishRead());
    await act(async () => adoptPresendPause(id, !!sender.presendTab(id)?.paused));
    expect(presendTab(id)).not.toBe(original);
    await act(async () => acknowledgeFirstPause());

    act(() => root.render(null));
    await mount();
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    if (reply === "after delivery") await act(async () => finishRead());
    await act(async () => toggle().click());
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    type(host, "different draft in the receiving tab");
    type(host, draft);
    await waitForEdit();
    if (reply === "while the same draft waits") {
      expect(reads).toEqual([draft]);
      expect(ledger.pending.has(key)).toBe(true);
      await act(async () => finishRead());
    }

    expect(reads.every(text => text === draft)).toBe(true);
    expect(reads.length).toBe(written ? 1 : 2);
    expect(presendTab(id)?.attempted.has(key)).toBe(written);
    expect(ledger.pending.size).toBe(0);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it("starts a delivered pause for an unregistered receiver and retries its failed save", async () => {
  const id = "receiver-without-pause";
  mocks.invoke.mockRejectedValueOnce(new Error("first save failed")).mockResolvedValueOnce(false);
  expect(presendTab(id)).toBeUndefined();
  adoptPresendPause(id, false);
  expect(presendTab(id)).toBeUndefined();
  await act(async () => adoptPresendPause(id, true));
  const local = presendTab(id)!;
  expect(local.paused).toBe("failed");
  adoptPresendPause(id, false);
  expect(presendTab(id) === local && !local.enabled).toBe(true);
  await act(async () => adoptPresendPause(id, true));
  expect(presendTab(id) === local && !local.enabled && local.paused === undefined).toBe(true);
});

it("binds a draft and its displayed reading to the conversation at edit time", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.invoke.mockClear();
  const id = "conversation-transition";
  publishCodexRestoreNoticeEpoch(id, 7);
  let activeConversation = "";
  const observe = (conversation: string) => {
    activeConversation = conversation;
    act(() => usePaneMetadataStore.getState().setLiveAgent(id, "claude", true, { agentSessionId: conversation, startedAt: 1000 }));
  };
  const reading = { reading: "synthetic exact reading", assumption: "none", missing: "none", provider: "claude", elapsedMs: 1 };
  mocks.invoke.mockImplementation(async (name: string) => {
    if (name === "configure_presend_reading") return true;
    if (name === "get_codex_restore_epoch") return 7;
    if (name === "get_agent_conversation_owner") return id;
    if (name === "get_live_events") return [{
      ptySessionId: id, telemetryHealth: "live",
      events: [{ eventId: "toy-current-event", sourceRevision: 2, sourceByteStart: 1, sourceByteEnd: 20,
        occurredAt: 2000, kind: { type: "agentMessage", text: "synthetic reply in " + activeConversation } }],
      presendReplySource: { ptyGeneration: 7, agentKind: "claude", agentSessionId: activeConversation,
        occurredAt: 2000, eventId: "toy-current-event", sourceRevision: 2, sourceByteStart: 1, sourceByteEnd: 20,
        fileGeneration: 1, contentDigest: "synthetic" },
    }];
    if (name === "run_presend_reading") return reading;
    return null;
  });
  useAiSettingsStore.setState({ aiEnabled: true });
  useSettingsStore.setState({ presendReadingEnabled: true, presendReadingProvider: "claude", paneComposerEnabled: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const runs = () => mocks.invoke.mock.calls.filter(([name]) => name === "run_presend_reading");
  const wait = () => act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  try {
    observe("toy-conversation-a");
    await act(async () => root.render(<PaneComposer sessionId={id} target={{ command: "claude" }} />));
    type(host, "draft written in conversation a");
    observe("toy-conversation-b");
    await wait();
    expect(runs()).toHaveLength(0);
    type(host, "fresh draft written in conversation b");
    await wait();
    expect(runs()).toHaveLength(1);
    expect(runs()[0][1]).toMatchObject({
      draft: "fresh draft written in conversation b", conversationExcerpt: "synthetic reply in toy-conversation-b",
    });
    expect(host.querySelector(".cmux-presend-row .cmux-presend-value")?.textContent).toBe(reading.reading);
    observe("toy-conversation-c");
    expect(host.textContent).not.toContain(reading.reading);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it("rejects a draft edited before the first generation lookup when the PTY is replaced", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.invoke.mockClear();
  const id = "initial-generation-is-deferred";
  let release: ((generation: number) => void) | undefined;
  mocks.invoke.mockImplementation(async (name: string) => {
    if (name === "configure_presend_reading") return true;
    if (name === "get_codex_restore_epoch") return new Promise(resolve => { release = resolve; });
    if (name === "get_live_events") return [];
    return null;
  });
  useAiSettingsStore.setState({ aiEnabled: true });
  useSettingsStore.setState({ presendReadingEnabled: true, presendReadingProvider: "claude", paneComposerEnabled: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<PaneComposer sessionId={id} target={{ command: "claude" }} />));
    type(host, "synthetic draft before generation is known");
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    await act(async () => release?.(8));
    expect(mocks.invoke.mock.calls.filter(([name]) => name === "run_presend_reading")).toHaveLength(0);
    publishCodexRestoreNoticeEpoch(id, 8);
    type(host, "new synthetic edit in generation eight");
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    await act(async () => release?.(8));
    expect(mocks.invoke.mock.calls.filter(([name]) => name === "run_presend_reading")).toHaveLength(1);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it.each([true, false])("retries the initial tab preference only on a new edit and respects %s", async (sharedEnabled) => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.invoke.mockClear();
  const id = `preference-retry-${sharedEnabled}`;
  publishCodexRestoreNoticeEpoch(id, 7);
  let reads = 0;
  mocks.invoke.mockImplementation(async (name: string, args?: { sessionId?: string }) => {
    if (name === "configure_presend_reading" && args?.sessionId === id) {
      if (++reads === 1) throw new Error("synthetic initial preference failure");
      return sharedEnabled;
    }
    if (name === "get_codex_restore_epoch") return 7;
    if (name === "get_live_events") return [];
    return null;
  });
  useAiSettingsStore.setState({ aiEnabled: true });
  useSettingsStore.setState({ presendReadingEnabled: true, presendReadingProvider: "claude", paneComposerEnabled: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const wait = () => act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  const runs = () => mocks.invoke.mock.calls.filter(([name]) => name === "run_presend_reading");
  try {
    await act(async () => root.render(<PaneComposer sessionId={id} target={{ command: "claude" }} />));
    await wait();
    expect(reads).toBe(1);
    expect(runs()).toHaveLength(0);
    type(host, "new synthetic text after the preference lookup failed");
    await wait();
    expect(reads).toBe(2);
    expect(runs()).toHaveLength(sharedEnabled ? 1 : 0);
    expect(host.querySelector(".cmux-presend-toggle")?.getAttribute("aria-pressed")).toBe(String(sharedEnabled));
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it("ignores a stale pre-acknowledgement preference after remount", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.invoke.mockClear();
  const id = "remounted-during-pause";
  publishCodexRestoreNoticeEpoch(id, 7);
  let pauseAcknowledged!: (enabled: boolean) => void;
  let oldRead!: (enabled: boolean) => void;
  let reads = 0;
  mocks.invoke.mockImplementation(async (name: string, args?: { sessionId?: string; tabEnabled?: boolean }) => {
    if (name === "configure_presend_reading" && args?.sessionId === id) {
      if (args?.tabEnabled === false) return new Promise(resolve => { pauseAcknowledged = resolve; });
      if (++reads === 1) return true;
      return new Promise(resolve => { oldRead = resolve; });
    }
    if (name === "get_codex_restore_epoch") return 7;
    if (name === "get_live_events") return [];
    return null;
  });
  useAiSettingsStore.setState({ aiEnabled: true });
  useSettingsStore.setState({ presendReadingEnabled: true, presendReadingProvider: "claude", paneComposerEnabled: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const mount = () => act(async () => root.render(<PaneComposer sessionId={id} target={{ command: "claude" }} />));
  const toggle = () => host.querySelector<HTMLButtonElement>(".cmux-presend-toggle")!;
  try {
    await mount();
    await act(async () => toggle().click());
    act(() => root.render(null));
    await mount();
    await act(async () => pauseAcknowledged(false));
    await act(async () => oldRead(true));
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    type(host, "new synthetic draft after remount");
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(mocks.invoke.mock.calls.filter(([name]) => name === "run_presend_reading")).toHaveLength(0);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

const laneFStructuredReadingFixtures = [
  ["escaped name first", '{"name":"SAMPLE\\u005fTOKEN","value":"fixture-label"}'],
  ["escaped value first", '{"value":"fixture-label","name":"SAMPLE\\u005fTOKEN"}'],
  ["undecodable name first", '{"name":"SAMPLE\\u00GfTOKEN","value":"fixture-label"}'],
  ["undecodable value first", '{"value":"fixture-label","name":"SAMPLE\\u00GfTOKEN"}'],
  ["block scalar alias key", "field-name: &sample-key |-\n  password\n? *sample-key\n: fixture-label"],
].map(([label, input]) => ({ label, input }));

const laneGEnvironmentReadingFixtures = [
  { label: "alias", name: "*fixture-name", prefix: "fixture-name: &fixture-name PATH\n", reads: 0 },
  { label: "tag", name: "!!str PATH", reads: 0 },
  { label: "anchor", name: "&fixture-name PATH", reads: 0 },
  { label: "literal block", name: "|-\n      PATH", reads: 0 },
  { label: "folded block", name: ">-\n      PATH", reads: 0 },
  { label: "plain name", name: "PATH", reads: 1 },
  { label: "quoted name", name: '"PATH"', reads: 1 },
].flatMap(({ label, name, prefix = "", reads }) => {
  const fields = ["name: " + name, "value: fixture-bin"];
  return [fields, [...fields].reverse()].map(([first, second], order) => ({
    label: "G " + label + (order === 0 ? ", name first" : ", value first"),
    input: prefix + "env:\n  - " + first + "\n    " + second,
    reads,
  }));
});

const laneG2EnvironmentReadingFixtures = [
  ["G2-001 alias name first", "fixture-name: &fixture-name PATH\nenv: [{ name: *fixture-name # note, ] }\n    # another, } ]\n    , # after the separator, ] }\n    value: fixture-label }]", 0],
  ["G2-001 alias value first", "fixture-name: &fixture-name PATH\nenv: [{ value: fixture-label # note, ] }\n    # another, } ]\n    , # after the separator, ] }\n    name: *fixture-name }]", 0],
  ["G2-001 tag name first", "env: [{ name: !!str PATH # note, ] }\n    # another, } ]\n    , # after the separator, ] }\n    value: fixture-label }]", 0],
  ["G2-001 tag value first", "env: [{ value: fixture-label # note, ] }\n    # another, } ]\n    , # after the separator, ] }\n    name: !!str PATH }]", 0],
  ["G2-001 plain PATH name first", "env: [{ name: PATH # note, ] }\n    # another, } ]\n    , # after the separator, ] }\n    value: fixture-label }]", 1],
  ["G2-001 plain PATH value first", "env: [{ value: fixture-label # note, ] }\n    # another, } ]\n    , # after the separator, ] }\n    name: PATH }]", 1],
  ["G2-001 quoted delimiters name first", "env: [{ name: \"PATH\" # note, ] }\n    # another, } ]\n    , # after the separator, ] }\n    value: \"fixture # still text, } ]\" }]", 1],
  ["G2-001 quoted delimiters value first", "env: [{ value: \"fixture # still text, } ]\" # note, ] }\n    # another, } ]\n    , # after the separator, ] }\n    name: \"PATH\" }]", 1],
  ["G2-001 nested value name first", "fixture-name: &fixture-name PATH\nenv: [{ name: *fixture-name # note, ] }\n    # another, } ]\n    , # after the separator, ] }\n    value: [first # brackets and comma, ] }\n    , second] }]", 0],
  ["G2-001 nested value value first", "fixture-name: &fixture-name PATH\nenv: [{ value: [first # brackets and comma, ] }\n    , second] # note, ] }\n    # another, } ]\n    , # after the separator, ] }\n    name: *fixture-name }]", 0],
  ["G2-002 empty name first at EOF", "env:\n  - name:\n    value: fixture-label", 0],
  ["G2-002 empty name first before a sibling key", "env:\n  - name:\n    value: fixture-label\n    note: hint", 0],
  ["G2-002 empty name first before a shallower key", "env:\n  - name:\n    value: fixture-label\nnote: hint", 0],
  ["G2-002 indented PATH name first", "env:\n  - name:\n      PATH\n    value: fixture-label", 1],
  ["G2-002 empty name, value first at EOF", "env:\n  - value: fixture-label\n    name:", 0],
  ["G2-002 empty name, value first before a sibling key", "env:\n  - value: fixture-label\n    name:\n    note: hint", 0],
  ["G2-002 empty name, value first before a shallower key", "env:\n  - value: fixture-label\n    name:\nnote: hint", 0],
  ["G2-002 indented PATH value first", "env:\n  - value: fixture-label\n    name:\n      PATH", 1],
] as const;

it.each([
  ...laneG2EnvironmentReadingFixtures.flatMap(([label, input, reads]) => [
    { label: label + " in the draft", draft: input, reply: "Synthetic reply", reads },
    { label: label + " in the conversation", draft: "Keep this draft in the composer", reply: input, reads },
  ]),
  ...laneGEnvironmentReadingFixtures.flatMap(({ label, input, reads }) => [
    { label: label + " in the draft", draft: input, reply: "Synthetic reply", reads },
    { label: label + " in the conversation", draft: "Keep this draft in the composer", reply: input, reads },
  ]),
  ...laneFStructuredReadingFixtures.flatMap(({ label, input }) => [
    { label: label + " in the draft", draft: input, reply: "Synthetic reply", reads: 0 },
    { label: label + " in the conversation", draft: "Keep this draft in the composer", reply: input, reads: 0 },
  ]),
  {
    label: "an undecodable quoted key in the draft",
    draft: String.raw`{"pass\u00G0word":"dummy-draft-value"}`,
    reply: "Synthetic reply",
    reads: 0,
  },
  {
    label: "an undecodable quoted key in the conversation",
    draft: "Keep this draft in the composer",
    reply: String.raw`{"pass\xG7ord":"dummy-reply-value"}`,
    reads: 0,
  },
  {
    label: "ordinary Markdown about a form label",
    draft: "**Form labels**\n\nPlease rename the password input field.",
    reply: "Synthetic reply",
    reads: 1,
  },
])("keeps the editor text when considering $label", async ({ label, draft, reply, reads }) => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.invoke.mockClear();
  const id = "lane-d-" + label;
  const occurredAt = Date.now();
  const event = { occurredAt, eventId: "toy-reply", sourceRevision: 1,
    sourceByteStart: 10, sourceByteEnd: 120, kind: { type: "agentMessage", text: reply } };
  const origin = { ptyGeneration: 7, agentKind: "claude", agentSessionId: "toy-chat", occurredAt,
    eventId: event.eventId, sourceRevision: 1, sourceByteStart: 10, sourceByteEnd: 120,
    fileGeneration: 1, contentDigest: "synthetic" };
  mocks.invoke.mockImplementation(async (name: string, args?: { sessionId?: string }) => {
    if (name === "configure_presend_reading" && args?.sessionId === id) return true;
    if (name === "get_codex_restore_epoch") return 7;
    if (name === "get_live_events") return [
      { ptySessionId: id, telemetryHealth: "live", events: [event], presendReplySource: origin },
    ];
    if (name === "run_presend_reading") return {
      reading: "sample reading", assumption: "none", missing: "none", provider: "claude", elapsedMs: 1,
    };
    return null;
  });
  useAiSettingsStore.setState({ aiEnabled: true });
  useSettingsStore.setState({ presendReadingEnabled: true, presendReadingProvider: "claude", paneComposerEnabled: true });
  publishCodexRestoreNoticeEpoch(id, 7);
  usePaneMetadataStore.getState().setLiveAgent(id, "claude", true, { agentSessionId: "toy-chat" });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<PaneComposer sessionId={id} target={{ command: "claude" }} />));
    type(host, draft);
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(host.querySelector("textarea")?.value).toBe(draft);
    expect(useComposerStore.getState().draftBySession[id]).toBe(draft);
    const calls = mocks.invoke.mock.calls.map(([name]) => name);
    if (reply !== "Synthetic reply") expect(calls.filter(name => name === "get_codex_restore_epoch")).toHaveLength(2);
    expect(calls.filter(name => name === "run_presend_reading")).toHaveLength(reads);
    if (reads === 1 && (label.startsWith("G ") || label.startsWith("G2-"))) {
      const reading = mocks.invoke.mock.calls.find(([name]) => name === "run_presend_reading");
      expect(reading?.[1]).toMatchObject({ draft, conversationExcerpt: reply });
    }
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
