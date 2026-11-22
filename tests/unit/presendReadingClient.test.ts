import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveSessionBrief, LiveSessionEvents } from "../../src/lib/livebrief";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  subscribers: new Set<(state: any, previous: any) => void>(),
  settings: { presendReadingEnabled: true, presendReadingProvider: "claude", paneComposerEnabled: true },
  metadata: { "tab-a": { cwd: "C:\\work\\example-repo" } },
  workspaces: [{ panes: [{ cwd: "/work/pane-folder", tabs: [{ sessionId: "tab-a", cwd: "/work/saved-folder" }] }] }],
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../../src/stores/settingsStore", () => ({ useSettingsStore: { getState: () => mocks.settings, subscribe: (listener: (state: any, previous: any) => void) => { mocks.subscribers.add(listener); return () => mocks.subscribers.delete(listener); } } }));
vi.mock("../../src/stores/paneMetadataStore", () => ({ usePaneMetadataStore: { getState: () => ({ metadata: mocks.metadata }) } }));
vi.mock("../../src/stores/workspaceListStore", () => ({ useWorkspaceListStore: { getState: () => ({ workspaces: mocks.workspaces }) } }));
let requestPresendReading: typeof import("../../src/lib/presendReadingClient").requestPresendReading;

const credentialFixture = JSON.parse(readFileSync(resolve(import.meta.dirname, "../fixtures/presend_credentials.json"), "utf8")) as {
  cases: Array<{ name: string; inputParts: string[]; expectedParts: string[] }>;
};
const readingFixture = JSON.parse(readFileSync(resolve(import.meta.dirname, "../fixtures/presend_reading_request.json"), "utf8")) as {
  generation: number;
  cwd: string;
  batch: LiveSessionEvents;
  brief: LiveSessionBrief;
  request: { requestId: string; sessionId: string; provider: "claude"; draft: string; conversationExcerpt: string };
  workdirCases: Array<{ cwd: string; workdirName: string }>;
};

const contextSteps = [
  "get_codex_restore_epoch", "get_live_events", "get_live_briefs",
  "get_agent_conversation_owner", "get_codex_restore_epoch",
];

function mockContextSteps(onLookup: (step: number, value: unknown) => unknown) {
  const { generation, batch, brief, request } = readingFixture;
  const results = [generation, [batch], [brief], request.sessionId, generation];
  let step = 0;
  mocks.invoke.mockImplementation(async (name: string) => {
    if (name === contextSteps[step]) {
      const next = step++;
      return onLookup(next, results[next]);
    }
    return null;
  });
}

function contextCalls() {
  return mocks.invoke.mock.calls.map(([name]) => name).filter(name => contextSteps.includes(name));
}

const replyBatch = {
  ptySessionId: "tab-a",
  briefRevision: 31,
  telemetryHealth: "live",
  events: [
    { occurredAt: 8_000, kind: { type: "agentMessage", text: "old reply" } },
    { occurredAt: 9_000, kind: { type: "userMessage", text: "ignored user text" } },
    { occurredAt: 10_000, kind: { type: "agentMessage", text: `token=reply-secret ${"x".repeat(1600)} ${["sk-ant-", "final-secret"].join("")}` } },
  ],
};
const replyBrief = {
  ptySessionId: "tab-a",
  ptyGeneration: 7,
  briefRevision: 31,
  telemetryHealth: "live",
  operationalState: "running",
  agentKind: "claude",
  agentSessionId: "agent-a",
};

function mockReplyContext({
  epochs = [7, 7], batch = replyBatch, brief = replyBrief, owner = "tab-a",
}: {
  epochs?: readonly (number | null)[];
  batch?: typeof replyBatch;
  brief?: typeof replyBrief;
  owner?: string | null;
} = {}) {
  let observation = 0;
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "get_codex_restore_epoch") return epochs[observation++] ?? null;
    if (command === "get_live_events") return [batch];
    if (command === "get_live_briefs") return [brief];
    if (command === "get_agent_conversation_owner") return owner;
    return null;
  });
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.subscribers.clear();
  Object.assign(mocks.settings, { presendReadingEnabled: true, paneComposerEnabled: true, presendReadingProvider: "claude" });
  mocks.metadata["tab-a"].cwd = "C:\\work\\example-repo";
  mockReplyContext();
  requestPresendReading = (await import("../../src/lib/presendReadingClient")).requestPresendReading;
});
describe("presend provider input", () => {
  it("does not automatically retry failed configuration but permits a new draft", async () => {
    let attempts = 0;
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "configure_presend_reading" && ++attempts === 1) throw new Error("dummy configuration failure");
      return command === "get_live_events" ? [] : null;
    });
    await expect(requestPresendReading("failed", "tab-a", "first draft", "claude", () => true)).rejects.toThrow("dummy");
    expect(attempts).toBe(1);
    await requestPresendReading("next", "tab-a", "different draft", "claude", () => true);
    expect(attempts).toBe(2);
  });
  it.each([
    "nested-assignment-parent-and-child", "url-userinfo-password-and-port",
    "nested-assignment-padded-base64", "nested-assignment-no-space-after-colon",
  ])(
    "passes the shared scrubbed payload to Rust: %s",
    async name => {
      const row = credentialFixture.cases.find(example => example.name === name)!;
      const draft = row.inputParts.join("");
      mockReplyContext({
        batch: { ...replyBatch, events: [{ occurredAt: 10_000, kind: { type: "agentMessage", text: draft } }] },
      });
      await requestPresendReading("toy", "tab-a", draft, "claude", () => true);
      expect(mocks.invoke).toHaveBeenCalledWith("run_presend_reading", expect.objectContaining({
        draft: row.expectedParts.join(""), conversationExcerpt: row.expectedParts.join(""),
      }));
    },
  );

  it("passes only a scrubbed draft, the latest reply tail, and the folder name", async () => {
    await requestPresendReading("one", "tab-a", "password=draft-secret", "claude", () => true);
    const call = mocks.invoke.mock.calls.find(([command]) => command === "run_presend_reading")!;
    const payload = call[1];
    expect(payload.sessionId).toBe("tab-a");
    expect(payload.draft).toBe("password=[credential omitted]");
    expect(Array.from(payload.conversationExcerpt)).toHaveLength(1500);
    expect(payload.conversationExcerpt).toContain("[credential omitted]");
    expect(payload.conversationExcerpt).not.toMatch(/reply-secret|final-secret|old reply|ignored user/);
    expect(payload.workdirName).toBe("example-repo");
    expect(JSON.stringify(payload)).not.toContain("draft-secret");
  });
  it.each([
    ["ended telemetry", { batch: { ...replyBatch, telemetryHealth: "ended" } }],
    ["ended operational state", { brief: { ...replyBrief, operationalState: "ended" } }],
    ["the previous generation still cached as live", { epochs: [8, 8] }],
    ["an unavailable generation", { epochs: [null] }],
    ["the generation changing during acquisition", { epochs: [7, 8] }],
    ["a brief from a different event batch", { brief: { ...replyBrief, briefRevision: 32, agentSessionId: "agent-b" } }],
    ["an unconfirmed conversation owner", { owner: null }],
  ] as const)("continues with the draft alone for %s", async (_case, context) => {
    mockReplyContext(context);
    await requestPresendReading("unbound", "tab-a", "draft waiting to be read", "claude", () => true);
    const generation = "epochs" in context ? context.epochs[0] : 7;
    expect(mocks.invoke).toHaveBeenCalledWith("run_presend_reading", expect.objectContaining({
      sessionId: "tab-a", ptyGeneration: generation,
      draft: "draft waiting to be read",
      conversationExcerpt: "",
    }));
  });

  it("does not start a provider after the draft is invalidated during context retrieval", async () => {
    let current = true;
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "get_codex_restore_epoch") return 7;
      if (command === "get_live_events") { current = false; return []; }
      return null;
    });
    expect(await requestPresendReading("two", "tab-a", "draft", "claude", () => current)).toBeNull();
    expect(mocks.invoke.mock.calls.some(([command]) => command === "run_presend_reading")).toBe(false);
  });

  it("creates the wire payload that Rust uses to admit a current reply", async () => {
    const { cwd, request } = readingFixture;
    mocks.metadata["tab-a"].cwd = cwd;
    mockContextSteps((_step, value) => value);
    await requestPresendReading(request.requestId, request.sessionId, request.draft, request.provider, () => true);
    expect(mocks.invoke).toHaveBeenCalledWith("run_presend_reading", request);
    expect(contextCalls()).toEqual(contextSteps);
  });

  it.each(readingFixture.workdirCases)("creates the wire workdirName for $cwd", async ({ cwd, workdirName }) => {
    const { request } = readingFixture;
    mocks.metadata["tab-a"].cwd = cwd;
    mockContextSteps((_step, value) => value);
    await requestPresendReading(request.requestId, request.sessionId, request.draft, request.provider, () => true);
    expect(mocks.invoke).toHaveBeenCalledWith("run_presend_reading", { ...request, workdirName });
  });

  it("scrubs a token-shaped folder name before IPC", async () => {
    const example = credentialFixture.cases.find(row => row.name === "prefix-glpat-20")!;
    mocks.metadata["tab-a"].cwd = `/sample/${example.inputParts.join("")}`;
    await requestPresendReading("toy-folder", "tab-a", "synthetic draft", "claude", () => true);
    expect(mocks.invoke).toHaveBeenCalledWith("run_presend_reading", expect.objectContaining({
      workdirName: example.expectedParts.join(""),
    }));
  });

  it("observes the request generation while configuration is still pending", async () => {
    let generation = 7;
    let release!: () => void;
    const configuration = new Promise<void>(resolve => { release = resolve; });
    mocks.invoke.mockImplementation(async (name: string) => {
      if (name === "configure_presend_reading") return configuration;
      if (name === "get_codex_restore_epoch") return generation;
      if (name === "get_live_events") return [];
      return null;
    });
    const pending = requestPresendReading("toy-pre-config", "tab-a", "Synthetic draft", "claude", () => true);
    await flushConfiguration();
    const observed = contextCalls().includes("get_codex_restore_epoch");
    const submittedBeforeConfig = mocks.invoke.mock.calls.some(([name]) => name === "run_presend_reading");
    generation = 8;
    release();
    await pending;
    expect(observed).toBe(true);
    expect(submittedBeforeConfig).toBe(false);
    expect(mocks.invoke).toHaveBeenCalledWith("run_presend_reading", expect.objectContaining({
      ptyGeneration: 7, conversationExcerpt: "",
    }));
  });

  it.each([0, 1, 2, 3])("stops subsequent context IPCs after cancellation at step %s", async stop => {
    let current = true;
    mockContextSteps((step, value) => {
      if (step === stop) current = false;
      return value;
    });
    expect(await requestPresendReading("toy-canceled", "tab-a", "Test draft", "claude", () => current)).toBeNull();
    expect(contextCalls()).toEqual(contextSteps.slice(0, stop + 1));
    expect(mocks.invoke.mock.calls.some(([name]) => name === "run_presend_reading")).toBe(false);
  });

  it.each([0, 1, 2, 3, 4])("uses one context deadline and ignores late results from step %s", async stalled => {
    vi.useFakeTimers();
    let release: () => void = () => undefined;
    try {
      mockContextSteps((step, value) => {
        if (step === stalled) return new Promise(resolve => { release = () => resolve(value); });
        if (step === 0) return new Promise(resolve => setTimeout(() => resolve(value), 500));
        return value;
      });
      const pending = requestPresendReading("toy-timeout", "tab-a", "Test draft", "claude", () => true);
      await vi.advanceTimersByTimeAsync(2_999);
      expect(contextCalls()).toEqual(contextSteps.slice(0, stalled + 1));
      expect(mocks.invoke.mock.calls.some(([name]) => name === "run_presend_reading")).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.invoke).toHaveBeenCalledWith("run_presend_reading", expect.objectContaining({
        requestId: "toy-timeout", ptyGeneration: stalled === 0 ? null : readingFixture.generation,
        conversationExcerpt: "", replySource: undefined,
      }));
      await pending;
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(contextCalls()).toEqual(contextSteps.slice(0, stalled + 1));
      expect(mocks.invoke.mock.calls.filter(([name]) => name === "run_presend_reading")).toHaveLength(1);

      mockContextSteps((step, value) => step === 1
        ? [{ ...readingFixture.batch, events: [{ ...readingFixture.batch.events[1], kind: { type: "agentMessage", text: "Fresh synthetic reply" } }] }]
        : value);
      await requestPresendReading("toy-next", "tab-a", "Next draft", "claude", () => true);
      expect(mocks.invoke).toHaveBeenCalledWith("run_presend_reading", expect.objectContaining({
        requestId: "toy-next", ptyGeneration: readingFixture.generation, conversationExcerpt: "Fresh synthetic reply",
      }));
    } finally {
      release();
      vi.useRealTimers();
    }
  });

  it("does not submit a draft when its context times out after cancellation", async () => {
    vi.useFakeTimers();
    try {
      let current = true;
      mockContextSteps((step, value) => step === 1 ? new Promise(() => undefined) : value);
      const complete = vi.fn();
      void requestPresendReading("toy-retired", "tab-a", "Test draft", "claude", () => current).then(complete);
      await vi.advanceTimersByTimeAsync(1);
      current = false;
      await vi.advanceTimersByTimeAsync(3_000);
      expect(complete).toHaveBeenCalledWith(null);
      expect(mocks.invoke.mock.calls.some(([name]) => name === "run_presend_reading")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the saved tab folder until live cwd metadata is available", async () => {
    mocks.metadata["tab-a"].cwd = "";
    await requestPresendReading("folder", "tab-a", "draft", "claude", () => true);
    const call = mocks.invoke.mock.calls.find(([command]) => command === "run_presend_reading")!;
    expect(call[1].workdirName).toBe("saved-folder");
  });
});

async function flushConfiguration() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function changeSettings(change: Partial<typeof mocks.settings>) {
  const previous = { ...mocks.settings };
  Object.assign(mocks.settings, change);
  for (const listener of mocks.subscribers) listener(mocks.settings, previous);
}
describe("configuration subscriptions", () => {
  it("forwards provider changes and feature OFF through the real client subscription", async () => {
    await requestPresendReading("initial", "tab-a", "draft", "claude", () => true);
    mocks.invoke.mockClear();
    changeSettings({ presendReadingProvider: "codex" });
    await flushConfiguration();
    expect(mocks.invoke).toHaveBeenCalledWith("configure_presend_reading", { enabled: true, provider: "codex" });
    changeSettings({ presendReadingEnabled: false });
    await flushConfiguration();
    expect(mocks.invoke).toHaveBeenCalledWith("configure_presend_reading", { enabled: false, provider: "codex" });
  });
  it("forwards the global AI switch and never fetches context while it is OFF", async () => {
    const { useAiSettingsStore } = await import("../../src/stores/aiSettingsStore");
    await requestPresendReading("initial", "tab-a", "draft", "claude", () => true);
    mocks.invoke.mockClear();
    useAiSettingsStore.getState().setAiEnabled(false);
    await flushConfiguration();
    expect(mocks.invoke).toHaveBeenCalledWith("configure_presend_reading", { enabled: false, provider: "claude" });
    mocks.invoke.mockClear();
    expect(await requestPresendReading("off", "tab-a", "draft", "claude", () => true)).toBeNull();
    expect(mocks.invoke.mock.calls.some(([name]) => name === "get_live_events" || name === "run_presend_reading")).toBe(false);
  });
});

it("refreshes configuration before a request after a delayed global-setting save", async () => {
  let persistedGlobalEnabled = false;
  let backendEnabled = false;
  let configurations = 0;
  const result = { reading: "ready", assumption: "none", missing: "none", provider: "claude", elapsedMs: 1 };
  mocks.invoke.mockImplementation(async (name: string, args: any) => {
    if (name === "configure_presend_reading") { configurations++; backendEnabled = args.enabled && persistedGlobalEnabled; return null; }
    if (name === "get_live_events") return [];
    if (name === "run_presend_reading") return backendEnabled ? result : null;
    return null;
  });
  changeSettings({ presendReadingEnabled: false }); await flushConfiguration();
  changeSettings({ presendReadingEnabled: true }); await flushConfiguration();
  expect(backendEnabled).toBe(false);
  const before = configurations;
  persistedGlobalEnabled = true;
  expect(await requestPresendReading("after-save", "tab-a", "draft", "claude", () => true)).toEqual(result);
  expect(configurations).toBe(before + 1);
  expect(backendEnabled).toBe(true);
});
