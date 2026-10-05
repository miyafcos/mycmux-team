// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const identity = vi.hoisted(() => ({ label: "main" }));
const dependencies = vi.hoisted(() => ({ cli: {} as any, usage: {} as any }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined), emit: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: identity.label }) }));
vi.mock("../../src/stores/cliAccountStore", () => ({ useCliAccountStore: { getState: () => dependencies.cli } }));
vi.mock("../../src/stores/usageStore", () => ({ useUsageStore: { getState: () => dependencies.usage } }));
vi.mock("../../src/stores/toastStore", () => ({ useToastStore: { getState: () => ({ pushToast: vi.fn() }) } }));

// Each window sees its own WebKit cache. A's writes do not reach B until
// delivery, including reads performed inside the real persist middleware.
class WindowStorage extends EventTarget implements Storage {
  cache: Map<string, string>;
  constructor(private shared: SharedStorage) { super(); this.cache = new Map(shared.data); }
  get length() { return this.cache.size; }
  clear() { this.shared.data.clear(); this.cache.clear(); }
  key(index: number) { return [...this.cache.keys()][index] ?? null; }
  getItem(key: string) { return this.cache.get(key) ?? null; }
  removeItem(key: string) { this.shared.data.delete(key); this.cache.delete(key); }
  setItem(key: string, value: string) {
    this.shared.writes++;
    this.shared.data.set(key, value);
    this.cache.set(key, value);
  }
}
class SharedStorage {
  data = new Map<string, string>();
  writes = 0;
  windows: WindowStorage[] = [];
  open(cached?: WindowStorage) {
    const storage = cached ?? new WindowStorage(this);
    this.windows.push(storage);
    const target = Object.assign(new EventTarget(), { localStorage: storage,
      setInterval: vi.fn(() => 0), clearInterval: vi.fn(), setTimeout, clearTimeout });
    vi.stubGlobal("window", target);
    vi.stubGlobal("localStorage", storage);
    return storage;
  }
  saved(key = "mycmux-settings") { return JSON.parse(this.data.get(key)!); }
}
let shared: SharedStorage;
beforeEach(() => {
  shared = new SharedStorage();
  identity.label = "main";
  vi.stubGlobal("navigator", { platform: "MacIntel", userAgent: "Macintosh" });
});
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

async function settings(label: string, cached?: WindowStorage) {
  shared.open(cached);
  vi.resetModules();
  identity.label = label;
  const context = await import("../../src/lib/windowContext");
  context.windowLabel(); // Freeze this module instance's actual window identity.
  const module = await import("../../src/stores/settingsStore");
  const listener = await import("../../src/components/layout/SocketListener");
  return { store: module.useSettingsStore, listener, mark: module.markAiFeatureSettingsDataJsonMigrationComplete };
}
async function accounts(label: string) {
  shared.open();
  vi.resetModules();
  identity.label = label;
  (await import("../../src/lib/windowContext")).windowLabel();
  return (await import("../../src/stores/accountAutoSwitchStore")).useAccountAutoSwitchStore;
}
const ai = { ai_provider: "codex", ai_model: "gpt-5.3-codex", ai_enabled: true,
  auto_pane_naming_enabled: false, reply_draft_suggestions_enabled: true } as const;

describe.each(["MacIntel", "Win32"])("automatic settings updates on %s", (platform) => {
  beforeEach(() => vi.stubGlobal("navigator", { platform, userAgent: platform }));
  it.each(["mycmux-w-spare", "mycmux-w-detached"])("keeps A's edits when %s hydrates AI from a stale cache", async (label) => {
    const a = await settings("main");
    a.store.getState().setNotificationsEnabled(false); // Seed a real, complete save.
    const b = await settings(label);
    const stale = shared.windows[1].getItem("mycmux-settings");
    a.store.getState().setNativePaneTearoutEnabled(false);
    a.store.getState().setShowSplitDownButton(true);
    expect(shared.windows[1].getItem("mycmux-settings")).toBe(stale);
    const saved = shared.data.get("mycmux-settings"), writes = shared.writes;
    b.listener.hydrateAiSettingsFromDataJson(ai);
    expect(b.store.getState()).toMatchObject({ autoPaneNamingEnabled: false,
      replyDraftSuggestionsEnabled: true, aiFeatureSettingsDataJsonMigrationComplete: true });
    expect(shared.data.get("mycmux-settings")).toBe(saved);
    expect(shared.writes).toBe(writes);
    const reopened = await settings("main");
    expect(reopened.store.getState()).toMatchObject({ nativePaneTearoutEnabled: false,
      showSplitDownButton: true, notificationsEnabled: false });
  }, 15_000);
  it("marks a child migration complete locally without saving its stale settings", async () => {
    const a = await settings("main");
    a.store.getState().setNotificationsEnabled(false);
    const b = await settings("mycmux-w-child");
    a.store.getState().setShowSplitDownButton(true);
    const saved = shared.data.get("mycmux-settings"), writes = shared.writes;
    b.mark();
    expect(b.store.getState().aiFeatureSettingsDataJsonMigrationComplete).toBe(true);
    expect(shared.data.get("mycmux-settings")).toBe(saved);
    expect(shared.writes).toBe(writes);
  }, 15_000);
  it("keeps main hydration and migration saves, and explicit child user saves", async () => {
    const a = await settings("main");
    a.listener.hydrateAiSettingsFromDataJson(ai);
    expect(shared.saved().state).toMatchObject({ autoPaneNamingEnabled: false,
      replyDraftSuggestionsEnabled: true, aiFeatureSettingsDataJsonMigrationComplete: true });
    const b = await settings("mycmux-w-child");
    const saved = shared.data.get("mycmux-settings");
    b.listener.hydrateAiSettingsFromDataJson(ai);
    expect(shared.data.get("mycmux-settings")).toBe(saved);
    b.store.getState().setShowSplitDownButton(true);
    b.store.getState().setNativePaneTearoutEnabled(false);
    b.store.getState().setAutoPaneNamingEnabled(true);
    b.store.getState().setReplyDraftSuggestionsEnabled(false);
    expect(shared.saved().state).toMatchObject({ showSplitDownButton: true,
      nativePaneTearoutEnabled: false, autoPaneNamingEnabled: true, replyDraftSuggestionsEnabled: false });
    expect(shared.saved().version).toBe(7);
    a.mark();
    expect(shared.saved().state.aiFeatureSettingsDataJsonMigrationComplete).toBe(true);
  }, 15_000);
  it("migrates an old child cache locally without replacing main's version-7 edits", async () => {
    shared.data.set("mycmux-settings", JSON.stringify({ version: 6, state: {
      nativePaneTearoutEnabled: false, macNativePaneTearoutEnabled: false,
      showSplitDownButton: false, notificationsEnabled: false,
    } }));
    const held = new WindowStorage(shared);
    const a = await settings("main");
    a.store.getState().setNativePaneTearoutEnabled(false);
    a.store.getState().setShowSplitDownButton(true);
    const saved = shared.data.get("mycmux-settings"), writes = shared.writes;
    const b = await settings("mycmux-w-child", held);
    expect(b.store.persist.hasHydrated()).toBe(true);
    expect(b.store.getState().nativePaneTearoutEnabled).toBe(platform === "MacIntel");
    expect(shared.data.get("mycmux-settings")).toBe(saved);
    expect(shared.writes).toBe(writes);
    expect(shared.saved().version).toBe(7);
  }, 15_000);
});

describe("automatic account state updates with a stale child cache", () => {
  const key = "mycmux-account-auto-switch";
  function prepare(result: "success" | "failure" | "warnings" | "no-target") {
    const profile = (id: string) => ({ id, provider: "claude", label: id, identity_key: id,
      needs_relogin: false });
    const usage = (id: string, pct: number) => ({ profile_id: id, provider: "claude", label: id,
      registered: true, is_active: id === "a", needs_relogin: false, state: "ok",
      five_hour: { pct, resets_at: new Date(Date.now()+3_600_000).toISOString() },
      seven_day: { pct: 10, resets_at: new Date(Date.now()+3_600_000).toISOString() },
      seven_day_sonnet: null, seven_day_opus: null, model_windows: [],
      fetched_at: new Date().toISOString() });
    dependencies.usage = { accounts: [usage("a", 100), usage("b", 5)], lastError: null };
    dependencies.cli = { profiles: result === "no-target" ? [profile("a")] : [profile("a"), profile("b")],
      live: [{ provider: "claude", present: true, identity_key: "a", matched_profile_id: "a", error: null }],
      loading: false, fetchError: null, busyByProvider: { claude: null, codex: null, grok: null },
      fetch: vi.fn(async () => {}), switchTo: vi.fn(async (_provider, _target, guard) => {
        if (!guard()) throw new Error("the real attempt guard must run");
        if (result === "failure") return null;
        return { profile: profile("b"), warnings: result === "warnings" ? ["warning"] : [] };
      }) };
  }
  it.each(["success", "failure", "warnings", "no-target"] as const)("does not overwrite main picks on child %s", async (result) => {
    const a = await accounts("main");
    a.getState().setEnabled("claude", true);
    const b = await accounts("mycmux-w-child");
    a.getState().setTargetIncluded("codex", "keep-excluded", false);
    const saved = shared.data.get(key), writes = shared.writes;
    prepare(result);
    await b.getState().evaluate();
    expect(b.getState().status.claude).toBeTruthy();
    if (result !== "no-target") expect(b.getState().attempts.claude).toMatchObject({ source: "a", target: "b" });
    if (result === "failure" || result === "warnings") expect(b.getState().enabled.claude).toBe(false);
    expect(shared.data.get(key)).toBe(saved);
    expect(shared.writes).toBe(writes);
    expect(shared.saved(key).state.excludedTargets.codex).toEqual(["keep-excluded"]);
  });
  it("keeps main attempt persistence and explicit child picks", async () => {
    const a = await accounts("main");
    a.getState().setEnabled("claude", true);
    prepare("success");
    await a.getState().evaluate();
    expect(shared.saved(key).state.attempts.claude).toMatchObject({ source: "a", target: "b" });
    const b = await accounts("mycmux-w-child");
    b.getState().setEnabled("codex", true);
    b.getState().setTargetIncluded("codex", "user-excluded", false);
    expect(shared.saved(key).state).toMatchObject({ enabled: { codex: true },
      excludedTargets: { codex: ["user-excluded"] } });
    expect(shared.saved(key).version).toBe(0);
    expect(Object.keys(shared.saved(key).state).sort()).toEqual(["attempts", "enabled", "excludedTargets"]);
  });
  it("keeps repeated-limit auto-stop local in a child and persisted in main", async () => {
    const a = await accounts("main");
    a.getState().setEnabled("claude", true);
    a.setState({ attempts: { claude: { source: "a", target: "b", at: Date.now()-600_000 } } });
    const b = await accounts("mycmux-w-child");
    a.getState().setTargetIncluded("codex", "keep-excluded", false);
    const saved = shared.data.get(key), writes = shared.writes;
    prepare("success");
    await b.getState().evaluate();
    expect(b.getState().enabled.claude).toBe(false);
    expect(shared.data.get(key)).toBe(saved);
    expect(shared.writes).toBe(writes);
    await a.getState().evaluate();
    expect(shared.saved(key).state.enabled.claude).toBe(false);
    expect(shared.saved(key).state.excludedTargets.codex).toEqual(["keep-excluded"]);
  });
});
