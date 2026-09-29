// Store listeners that cannot take the caller down with them.
//
// zustand's setState swaps the state in and then calls each listener in turn,
// unguarded. A listener that throws therefore does two kinds of damage: the
// exception lands in whoever changed the state -- after the change already
// applied, so that caller stops half-way through its work -- and every listener
// registered after it never hears about the change. In v0.80.1-v0.80.2 a
// background precompute listener threw on each layout change, which left the
// launcher pane open, stranded panes dragged out of the window and kept the
// drop banner on screen.

import type { StoreApi } from "zustand";

/**
 * Runs `listener`, logging what it throws instead of passing it on. Without an
 * exception it hands back whatever the listener returned; after one, undefined.
 */
export function isolateStoreListener<Args extends unknown[], R>(
  storeName: string,
  listener: (...args: Args) => R,
): (...args: Args) => R | undefined {
  return (...args: Args) => {
    try {
      return listener(...args);
    } catch (error) {
      console.error(
        `[mycmux] ${storeName} store listener threw; the change it was told about still applied and the other listeners still ran`,
        error,
      );
      return undefined;
    }
  };
}

const ISOLATED_SUBSCRIBERS = Symbol("mycmux.isolatedSubscribers");

type IsolatableStore<T> = Pick<StoreApi<T>, "subscribe"> & { [ISOLATED_SUBSCRIBERS]?: true };

/**
 * From now on, every listener registered through `store.subscribe` runs
 * isolated (see isolateStoreListener); the unsubscribe it returns still
 * removes it. A second call on the same store does nothing.
 *
 * zustand's React hooks (useStore -> useSyncExternalStore) subscribe through
 * the store's inner `api.subscribe`, not this property, so rendering is left as
 * it was -- which is fine, since React's own listeners do not throw.
 */
export function isolateSubscribers<T>(store: IsolatableStore<T>, storeName: string): void {
  if (store[ISOLATED_SUBSCRIBERS]) return;
  const subscribe = store.subscribe;
  // One wrapper per listener: zustand keeps listeners in a Set, so the same
  // function subscribed twice must still be one entry, called once.
  const wrappers = new WeakMap<(state: T, previous: T) => void, (state: T, previous: T) => void>();
  store.subscribe = (listener) => {
    let isolated = wrappers.get(listener);
    if (!isolated) {
      isolated = isolateStoreListener(storeName, listener);
      wrappers.set(listener, isolated);
    }
    return subscribe(isolated);
  };
  store[ISOLATED_SUBSCRIBERS] = true;
}
