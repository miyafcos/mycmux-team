import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined), emit: vi.fn() }));

type SettingsStore = typeof import("../../src/stores/settingsStore").useSettingsStore;
type AccountStore = typeof import("../../src/stores/accountAutoSwitchStore").useAccountAutoSwitchStore;

// Each module instance is a real store in a separate window. Storage events
// are queued (as in a browser), so a writer can deliberately remain stale.
class WindowStorage extends EventTarget implements Storage {
  private cache: Map<string, string> | null;
  constructor(private shared: SharedStorage) {
    super();
    this.cache = shared.deferReads ? new Map(shared.data) : null;
  }
  refresh() { if (this.cache) this.cache = new Map(this.shared.data); }
  get length() { return this.shared.data.size; }
  clear() { this.shared.data.clear(); }
  key(index: number) { return [...this.shared.data.keys()][index] ?? null; }
  getItem(key: string) { return (this.cache ?? this.shared.data).get(key) ?? null; }
  removeItem(key: string) { this.shared.data.delete(key); }
  setItem(key: string, value: string) {
    const oldValue = this.getItem(key);
    this.shared.writes++;
    this.shared.data.set(key, value);
    this.cache?.set(key, value);
    if (oldValue !== value) {
      for (const recipient of this.shared.windows) {
        if (recipient !== this) this.shared.events.push({ recipient, key, oldValue, newValue: value });
      }
    }
  }
}

class SharedStorage {
  deferReads = false;
  data = new Map<string, string>();
  writes = 0;
  windows: WindowStorage[] = [];
  events: { recipient: WindowStorage; key: string; oldValue: string | null; newValue: string }[] = [];
  open() {
    const storage = new WindowStorage(this);
    this.windows.push(storage);
    vi.stubGlobal("window", Object.assign(storage, { localStorage: storage }));
    vi.stubGlobal("localStorage", storage);
    return storage;
  }
  deliver() {
    let delivered = 0;
    while (this.events.length) {
      if (++delivered > 30) throw new Error("storage event feedback loop");
      const { recipient, ...detail } = this.events.shift()!;
      recipient.refresh();
      const event = Object.assign(new Event("storage"), detail, { storageArea: recipient });
      recipient.dispatchEvent(event);
    }
    return delivered;
  }
  saved(key = "mycmux-settings") { return JSON.parse(this.data.get(key)!); }
}

let shared: SharedStorage;
beforeEach(() => {
  shared = new SharedStorage();
  vi.stubGlobal("navigator", { platform: "Win32", userAgent: "Windows NT 10.0" });
});
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

async function settings(): Promise<SettingsStore> {
  shared.open();
  vi.resetModules();
  return (await import("../../src/stores/settingsStore")).useSettingsStore;
}
async function accounts(): Promise<AccountStore> {
  shared.open();
  vi.resetModules();
  return (await import("../../src/stores/accountAutoSwitchStore")).useAccountAutoSwitchStore;
}

describe("real settings stores sharing localStorage", () => {
  it.each(["AI boot", "PREFERENCE", "another setting"])("keeps A's change when stale B writes %s", async (path) => {
    const a = await settings(), b = await settings();
    a.getState().setShowSplitDownButton(true);
    expect(b.getState().showSplitDownButton).toBe(false);
    if (path === "AI boot") b.setState({ autoPaneNamingEnabled: false, replyDraftSuggestionsEnabled: true,
      aiFeatureSettingsDataJsonMigrationComplete: true });
    else if (path === "PREFERENCE") b.setState({ nativePaneTearoutEnabled: true });
    else b.getState().setNotificationsEnabled(false);
    expect(shared.saved().state.showSplitDownButton).toBe(true);
    if (path === "AI boot") expect(shared.saved().state.replyDraftSuggestionsEnabled).toBe(true);
    if (path === "another setting") expect(shared.saved().state.notificationsEnabled).toBe(false);
  });

  it("keeps Mac OFF when an ON spare writes its AI boot fields", async () => {
    vi.stubGlobal("navigator", { platform: "MacIntel", userAgent: "Macintosh; Intel Mac OS X" });
    const a = await settings(), b = await settings();
    expect(b.getState().macNativePaneTearoutEnabled).toBe(true);
    a.getState().setNativePaneTearoutEnabled(false);
    b.setState({ autoPaneNamingEnabled: false, replyDraftSuggestionsEnabled: true,
      aiFeatureSettingsDataJsonMigrationComplete: true });
    expect(shared.saved().state).toMatchObject({ nativePaneTearoutEnabled: false,
      macNativePaneTearoutEnabled: false, replyDraftSuggestionsEnabled: true });
    const reopened = await settings();
    expect(reopened.getState().nativePaneTearoutEnabled).toBe(false);
    expect(reopened.getState().macNativePaneTearoutEnabled).toBe(false);
  });

  it("rehydrates both windows without extra writes or storage events", async () => {
    const a = await settings(), b = await settings();
    a.getState().setShowSplitDownButton(true);
    b.getState().setNotificationsEnabled(false);
    expect(shared.writes).toBe(2);
    expect(shared.deliver()).toBe(2);
    expect(a.getState().notificationsEnabled).toBe(false);
    expect(b.getState().showSplitDownButton).toBe(true);
    expect(shared.writes).toBe(2);
    a.getState().setShowSplitDownButton(true);
    b.getState().setNotificationsEnabled(false);
    expect(shared.writes).toBe(2);
    expect(shared.deliver()).toBe(0);
  });

  it("compares array contents and keeps foreign values across repeated stale writes", async () => {
    const a = await settings(), b = await settings();
    a.getState().setColorAdaptCommands(["custom"]);
    b.getState().setLauncherHiddenIds(["claude"]);
    b.getState().setColorAdaptCommands(["agy"]); // same local contents, new array
    b.getState().setNotificationsEnabled(false);
    expect(shared.saved().state).toMatchObject({ colorAdaptCommands: ["custom"],
      launcherHiddenIds: ["claude"], notificationsEnabled: false });
    expect(shared.writes).toBe(3);
  });

  it("lets the last actual change to the same field win", async () => {
    const a = await settings(), b = await settings();
    a.getState().setColorAdaptCommands(["A"]);
    b.getState().setColorAdaptCommands(["B"]);
    expect(shared.saved().state.colorAdaptCommands).toEqual(["B"]);
  });

  it("does not echo a Mac preference through a spare's lagging WebKit storage cache", async () => {
    shared.deferReads = true;
    vi.stubGlobal("navigator", { platform: "MacIntel", userAgent: "Macintosh" });
    const a = await settings(), b = await settings();
    const { applyExternalStoreUpdate } = await import("../../src/stores/syncedPersist");
    a.getState().setNativePaneTearoutEnabled(false);
    a.getState().setShowSplitDownButton(true);
    expect(shared.windows[1].getItem("mycmux-settings")).toBe(null);
    applyExternalStoreUpdate(b, { nativePaneTearoutEnabled: false, macNativePaneTearoutEnabled: false });
    expect(b.getState().nativePaneTearoutEnabled).toBe(false);
    expect(shared.saved().state.showSplitDownButton).toBe(true);
    expect(shared.writes).toBe(2);
    shared.deliver();
    expect(b.getState().showSplitDownButton).toBe(true);
    expect(shared.writes).toBe(2);
  });

  it("does not echo a Windows preference and still persists the receiver's next local edit", async () => {
    const a = await settings(), b = await settings();
    const { applyExternalStoreUpdate } = await import("../../src/stores/syncedPersist");
    a.getState().setNativePaneTearoutEnabled(false);
    applyExternalStoreUpdate(b, { nativePaneTearoutEnabled: false });
    expect(shared.writes).toBe(1);
    b.getState().setShowSplitDownButton(true);
    expect(shared.saved().state).toMatchObject({ nativePaneTearoutEnabled: false, showSplitDownButton: true });
    expect(shared.writes).toBe(2);
  });

  it.each(["MacIntel", "Win32"])("keeps defaults and version-6 migration on %s", async (platform) => {
    vi.stubGlobal("navigator", { platform, userAgent: platform === "Win32" ? "Windows NT 10.0" : "Macintosh" });
    const fresh = await settings();
    expect(fresh.getState().nativePaneTearoutEnabled).toBe(true);
    expect(fresh.getState().macNativePaneTearoutEnabled).toBe(true);
    shared.data.set("mycmux-settings", JSON.stringify({ version: 6, state: {
      nativePaneTearoutEnabled: false, macNativePaneTearoutEnabled: false,
      notificationsEnabled: false, futureSetting: { preserved: true },
    } }));
    const migrated = await settings();
    expect(migrated.persist.hasHydrated()).toBe(true);
    expect(migrated.getState().nativePaneTearoutEnabled).toBe(platform === "MacIntel");
    expect(shared.saved().version).toBe(7);
    migrated.getState().setShowSplitDownButton(true);
    expect(shared.saved()).toMatchObject({ version: 7, state: {
      notificationsEnabled: false, futureSetting: { preserved: true }, showSplitDownButton: true,
    } });
    expect(Object.keys(shared.saved()).sort()).toEqual(["state", "version"]);
    expect(typeof migrated.getState().setNotificationsEnabled).toBe("function");
  });

  it("ignores unrelated keys and another storage area", async () => {
    const a = await settings(), b = await settings();
    a.getState().setShowSplitDownButton(true);
    const target = shared.windows[1];
    target.dispatchEvent(Object.assign(new Event("storage"), { key: "another-key", storageArea: target }));
    target.dispatchEvent(Object.assign(new Event("storage"), { key: "mycmux-settings", storageArea: {} }));
    expect(b.getState().showSplitDownButton).toBe(false);
    shared.deliver();
    expect(b.getState().showSplitDownButton).toBe(true);
  });
});

describe("real account auto-switch stores sharing localStorage", () => {
  const key = "mycmux-account-auto-switch";
  it("keeps an enable change when a stale window changes excluded targets or status", async () => {
    const a = await accounts(), b = await accounts();
    a.getState().setEnabled("claude", true);
    b.getState().setTargetIncluded("codex", "excluded", false);
    b.setState({ status: { codex: "test status" } });
    expect(shared.saved(key).state).toMatchObject({ enabled: { claude: true },
      excludedTargets: { codex: ["excluded"] } });
    expect(shared.writes).toBe(2);
    expect(shared.deliver()).toBe(2);
    expect(a.getState().excludedTargets.codex).toEqual(["excluded"]);
    expect(b.getState().enabled.claude).toBe(true);
    expect(b.getState().status.codex).toBe("test status");
    expect(shared.writes).toBe(2);
    expect(Object.keys(shared.saved(key).state).sort()).toEqual(["attempts", "enabled", "excludedTargets"]);
  });

  it("compares object contents rather than references or object key order", async () => {
    const a = await accounts(), b = await accounts();
    a.getState().setEnabled("claude", true);
    b.setState({ enabled: { grok: false, codex: false, claude: false } });
    b.setState({ attempts: { codex: { source: "one", target: "two", at: 123 } } });
    expect(shared.saved(key).state.enabled.claude).toBe(true);
    expect(shared.saved(key).state.attempts.codex.at).toBe(123);
    expect(shared.writes).toBe(2);
    const reopened = await accounts();
    expect(reopened.getState().enabled.claude).toBe(true);
    expect(reopened.getState().attempts.codex.at).toBe(123);
  });

  it("hydrates saves from before excluded targets existed with the original merge", async () => {
    shared.data.set(key, JSON.stringify({ version: 0, state: {
      enabled: { claude: true, codex: false, grok: false }, attempts: {},
    } }));
    const a = await accounts();
    expect(a.getState().excludedTargets).toEqual({ claude: [], codex: [], grok: [] });
    a.getState().setTargetIncluded("claude", "target", false);
    expect(shared.saved(key).version).toBe(0);
    expect(shared.saved(key).state.excludedTargets.claude).toEqual(["target"]);
  });
});
