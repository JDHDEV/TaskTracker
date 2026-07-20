// Thin React binding over the framework-free toast store (src/lib/toasts.ts).
// `useSyncExternalStore` subscribes the owning component to the singleton store;
// the store owns all timer state, so this hook stays free of effects/timers and
// the logic stays testable without a DOM.

import { useCallback, useEffect, useSyncExternalStore } from "react";
import * as store from "../lib/toasts";
import type { Toast } from "../lib/toasts";

/** Per-toast options a caller may set. `key` makes a validation toast resolvable
 *  (push replaces in place; the owning field clears it with `dismissKey`);
 *  `ttlMs` overrides the kind default (notice 30s, error none). */
export interface ToastOptions {
  key?: string;
  ttlMs?: number;
}

export interface ToastsApi {
  toasts: Toast[];
  error: (message: string, opts?: ToastOptions) => void;
  notice: (message: string, opts?: ToastOptions) => void;
  dismiss: (id: string) => void;
  dismissKey: (key: string) => void;
}

export function useToasts(): ToastsApi {
  const toasts = useSyncExternalStore(store.subscribe, store.getSnapshot);

  // Tear the store's timers down when the owner unmounts (app teardown).
  useEffect(() => () => store.dispose(), []);

  const error = useCallback((message: string, opts?: ToastOptions) => {
    store.push({ kind: "error", message, key: opts?.key, ttlMs: opts?.ttlMs });
  }, []);
  const notice = useCallback((message: string, opts?: ToastOptions) => {
    store.push({ kind: "notice", message, key: opts?.key, ttlMs: opts?.ttlMs });
  }, []);
  const dismiss = useCallback((id: string) => store.dismiss(id), []);
  const dismissKey = useCallback((key: string) => store.dismissKey(key), []);

  return { toasts, error, notice, dismiss, dismissKey };
}
