import type { StateCreator, StoreApi, StoreMutatorIdentifier } from "zustand/vanilla";
import { persist, type PersistOptions, type PersistStorage, type StorageValue } from "zustand/middleware";
import { invoke } from "@tauri-apps/api/core";
import { isMainWindow } from "../lib/windowContext";

const externalUpdates = new WeakMap<object, (update: () => void) => void>();

type StoreUpdate<T> = T | Partial<T> | ((state: T) => T | Partial<T>);

/** A preference receipt already has an owning writer; update only this window's copy. */
export function applyExternalStoreUpdate<T>(store: Pick<StoreApi<T>, "setState">, state: StoreUpdate<T>): void {
  const apply = externalUpdates.get(store.setState);
  if (apply) apply(() => store.setState(state));
  else store.setState(state);
}

/** Only main persists automatic changes; explicit user actions keep their normal setters. */
export function applyAutomaticStoreUpdate<T>(store: Pick<StoreApi<T>, "setState">, state: StoreUpdate<T>): void {
  if (isMainWindow()) store.setState(state);
  else applyExternalStoreUpdate(store, state);
}

// Snapshots must have the same contents as the JSON on disk: no actions or
// shared object references, and no differences caused by object key order.
function snapshot(state: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
}

function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length
      && a.every((value, index) => equal(value, b[index]));
  }
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && equal(left[key], right[key]));
}

/** The existing persist wire format, with field patches and cross-window hydration. */
export function syncedPersist<
  T,
  Mps extends [StoreMutatorIdentifier, unknown][] = [],
  Mcs extends [StoreMutatorIdentifier, unknown][] = [],
  U = T,
>(
  initializer: StateCreator<T, [...Mps, ["zustand/persist", unknown]], Mcs>,
  options: PersistOptions<T, U>,
): StateCreator<T, Mps, [["zustand/persist", U], ...Mcs]> {
  return (set, get, api) => {
    let target: Window, local: Storage;
    try {
      target = window;
      local = target.localStorage;
    } catch {
      // Retain Zustand's unavailable-storage behavior (including SSR).
      return persist(initializer, options)(set, get, api);
    }

    const project = (state: T) => snapshot(options.partialize ? options.partialize(state) : state);
    let baseline: Record<string, unknown> = {};
    let external = false;
    let hydrating = false;
    const storage: PersistStorage<U> = {
      getItem(name) {
        const raw = local.getItem(name);
        const value = raw === null ? null : JSON.parse(raw) as StorageValue<U>;
        // A migration writes before its completion callback. Compare it with
        // the old serialized state so the existing migrate/version contract stays intact.
        if (value) baseline = snapshot(value.state);
        return value;
      },
      setItem(name, value) {
        const next = snapshot(value.state);
        if (external || (hydrating && !isMainWindow())) {
          baseline = next;
          return;
        }
        const changed = [...new Set([...Object.keys(baseline), ...Object.keys(next)])]
          .filter((key) => !equal(baseline[key], next[key]));
        const raw = local.getItem(name);
        const latest = raw === null ? null : JSON.parse(raw) as StorageValue<U>;
        if (!changed.length && (!latest || latest.version === value.version)) return;
        const merged = latest ? { ...latest.state } as Record<string, unknown> : { ...next };
        for (const key of changed) {
          if (Object.prototype.hasOwnProperty.call(next, key)) merged[key] = next[key];
          else delete merged[key];
        }
        const saved = { ...latest, state: merged, version: value.version };
        // Content equality also avoids writes when another window already
        // saved this change; rehydration itself never starts a write loop.
        if (!latest || !equal(latest, saved)) {
          local.setItem(name, JSON.stringify(saved));
          // macOS localStorage returns before WebKit commits its SQLite file.
          // Report only the fields this window wrote; the native exit worker
          // waits for these values on disk, without becoming another writer.
          if (typeof navigator !== "undefined" && /^Mac/i.test(navigator.platform)
            && "__TAURI_INTERNALS__" in target) {
            const patch: Record<string, unknown> = {}, removed: string[] = [];
            for (const key of changed) {
              if (Object.prototype.hasOwnProperty.call(next, key)) patch[key] = next[key];
              else removed.push(key);
            }
            void invoke("note_preference_write", { name, patch, removed, version: value.version ?? 0 })
              .catch((error) => console.warn("[settings-flush] Could not report a preference write:", error));
          }
        }
        // The local store can still be stale. Using merged here would make its
        // next unrelated edit appear to change the foreign fields back again.
        baseline = next;
      },
      removeItem: (name) => local.removeItem(name),
    };

    const state = persist(initializer, {
      ...options,
      storage,
      onRehydrateStorage(current) {
        hydrating = true;
        baseline = project(current);
        const after = options.onRehydrateStorage?.(current);
        return (hydrated, error) => {
          hydrating = false;
          if (hydrated !== undefined) baseline = project(hydrated);
          after?.(hydrated, error);
        };
      },
    })(set, get, api);
    // Covers skipHydration and unavailable/corrupt stored data too.
    baseline = project(state);
    externalUpdates.set(api.setState, (update) => {
      const previous = external;
      external = true;
      try { update(); } finally { external = previous; }
    });
    const persistence = api as typeof api & { persist: { rehydrate(): void | Promise<void> } };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== options.name || (event.storageArea && event.storageArea !== local)) return;
      // Read the current value, rather than an older queued event's newValue.
      // Zustand 5 hydrates through its original set(), bypassing persistence.
      void persistence.persist.rehydrate();
    };
    target.addEventListener("storage", onStorage);
    import.meta.hot?.dispose(() => target.removeEventListener("storage", onStorage));
    return state;
  };
}
