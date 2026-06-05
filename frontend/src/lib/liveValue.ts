import { useSyncExternalStore } from "react";

/**
 * A tiny external store for high-frequency values that shouldn't trigger
 * parent re-renders. Writers call `set()`; readers (typically small leaf
 * components) call `useLiveValue(store)` and re-render only when the store
 * fires.
 *
 * Notifications are coalesced to one per animation frame — multiple `set()`s
 * inside the same frame fire subscribers once, with the latest value.
 *
 * Use this for hot-path values like pan/zoom and cursor coords. For state
 * that needs persistence, selectors, or app-wide sharing, use the zustand
 * stores instead.
 */
export interface LiveValue<T> {
  get: () => T;
  set: (value: T) => void;
  subscribe: (callback: () => void) => () => void;
}

export function createLiveValue<T>(initial: T): LiveValue<T> {
  let value = initial;
  let pending = false;
  const subscribers = new Set<() => void>();

  function flush() {
    pending = false;
    for (const cb of subscribers) cb();
  }

  return {
    get: () => value,
    set: (next: T) => {
      if (Object.is(next, value)) return;
      value = next;
      if (pending) return;
      pending = true;
      requestAnimationFrame(flush);
    },
    subscribe: (callback) => {
      subscribers.add(callback);
      return () => {
        subscribers.delete(callback);
      };
    }
  };
}

export function useLiveValue<T>(store: LiveValue<T>): T {
  return useSyncExternalStore(store.subscribe, store.get);
}
