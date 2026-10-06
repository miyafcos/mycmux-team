import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { applyAutomaticStoreUpdate, applyExternalStoreUpdate, syncedPersist } from "../../src/stores/syncedPersist";

const native = vi.hoisted(() => ({ invoke: vi.fn(), main: true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("../../src/lib/windowContext", () => ({ isMainWindow: () => native.main }));

class StorageCopy implements Storage {
  constructor(private shared: Map<string, string>, private cached = new Map(shared)) {}
  get length() { return this.cached.size; }
  clear() { this.shared.clear(); this.cached.clear(); }
  key(index: number) { return [...this.cached.keys()][index] ?? null; }
  getItem(key: string) { return this.cached.get(key) ?? null; }
  removeItem(key: string) { this.shared.delete(key); this.cached.delete(key); }
  setItem(key: string, value: string) { this.shared.set(key, value); this.cached.set(key, value); }
  refresh() { this.cached = new Map(this.shared); }
}
interface State {
  flag: boolean;
  other: boolean;
  setFlag(value: boolean): void;
  setOther(value: boolean): void;
}
let shared: Map<string, string>;
function open(platform = "MacIntel", bridge = true, name = "mycmux-settings") {
  vi.stubGlobal("navigator", { platform });
  const storage = new StorageCopy(shared);
  const target = Object.assign(new EventTarget(), { localStorage: storage }, bridge ? { __TAURI_INTERNALS__: {} } : {});
  vi.stubGlobal("window", target);
  const store = createStore<State>()(syncedPersist((set) => ({
    flag: true, other: false,
    setFlag: (flag) => set({ flag }), setOther: (other) => set({ other }),
  }), { name, version: name === "mycmux-settings" ? 7 : 0 }));
  return { store, storage, target };
}
beforeEach(() => {
  shared = new Map(); native.main = true;
  native.invoke.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe("the macOS preferences exit barrier", () => {
  it("records a real changed field after writing the existing format", () => {
    shared.set("mycmux-settings", JSON.stringify({ state: { flag: true, other: false }, version: 7 }));
    const { store } = open();
    store.getState().setFlag(false);
    expect(JSON.parse(shared.get("mycmux-settings")!)).toEqual({ state: { flag: false, other: false }, version: 7 });
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith("note_preference_write", {
      name: "mycmux-settings", patch: { flag: false }, removed: [], version: 7,
    });
  });

  it("records each stale window's own fields and preserves the shared M7 merge", () => {
    shared.set("mycmux-settings", JSON.stringify({ state: { flag: true, other: false }, version: 7 }));
    const a = open(), b = open();
    a.store.getState().setFlag(false);
    b.storage.refresh(); // the state stays stale while the latest wire value is visible
    b.store.getState().setOther(true);
    expect(JSON.parse(shared.get("mycmux-settings")!).state).toEqual({ flag: false, other: true });
    expect(native.invoke.mock.calls[1][1].patch).toEqual({ other: true });
  });

  it.each(["PREFERENCE", "automatic child"])("does not report or persist %s updates", (path) => {
    const a = open(); native.main = false;
    if (path === "PREFERENCE") applyExternalStoreUpdate(a.store, { flag: false });
    else applyAutomaticStoreUpdate(a.store, { flag: false });
    expect(a.store.getState().flag).toBe(false);
    expect(shared.size).toBe(0);
    expect(native.invoke).not.toHaveBeenCalled();
    a.store.getState().setOther(true);
    expect(native.invoke.mock.calls[0][1].patch).toEqual({ other: true });
  });

  it("does not echo storage rehydration", () => {
    shared.set("mycmux-settings", JSON.stringify({ state: { flag: true, other: false }, version: 7 }));
    const a = open();
    shared.set("mycmux-settings", JSON.stringify({ state: { flag: false, other: true }, version: 7 }));
    a.storage.refresh();
    a.target.dispatchEvent(Object.assign(new Event("storage"), { key: "mycmux-settings", storageArea: a.storage }));
    expect(a.store.getState().flag).toBe(false);
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it.each(["Win32", "Linux x86_64"])("keeps %s writes entirely synchronous and never calls the barrier", (platform) => {
    const { store } = open(platform);
    store.getState().setFlag(false);
    expect(JSON.parse(shared.get("mycmux-settings")!).state.flag).toBe(false);
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it("keeps an ordinary Mac browser independent of native IPC", () => {
    const { store } = open("MacIntel", false);
    store.getState().setOther(true);
    expect(JSON.parse(shared.get("mycmux-settings")!).state.other).toBe(true);
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it("covers the existing account-auto-switch key and version", () => {
    const { store } = open("MacIntel", true, "mycmux-account-auto-switch");
    store.getState().setOther(true);
    expect(native.invoke.mock.calls[0][1]).toMatchObject({ name: "mycmux-account-auto-switch", version: 0 });
  });

  it("reports native errors without changing the stored preference", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      native.invoke.mockRejectedValue(new Error("native unavailable"));
      const { store } = open(); store.getState().setFlag(false);
      await vi.waitFor(() => expect(warning).toHaveBeenCalled(), { timeout: 1000 });
      expect(JSON.parse(shared.get("mycmux-settings")!).state.flag).toBe(false);
    } finally { warning.mockRestore(); }
  });
});
