// Framework-free toast store: keyed replace, per-toast TTL, pause/resume, and
// strict timer ownership. Kept out of React (no jsdom/RTL in the project) so the
// whole lifecycle is unit-testable with `vi.useFakeTimers()` in the node env;
// `src/hooks/useToasts.ts` is only a thin `useSyncExternalStore` binding.
//
// Timers use real `setTimeout`/`Date.now()` — fake-timer-driven tests fake both.

export type ToastKind = "error" | "notice";

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
  /** Stable identity for a resolvable validation toast. Pushing the same key
   *  replaces in place (no duplicate); the owning field clears it on resolution. */
  key?: string;
  /** Explicit time-to-live. Omitted → the kind default (notice: 30s, error: none). */
  ttlMs?: number;
}

export interface PushInput {
  kind: ToastKind;
  message: string;
  key?: string;
  ttlMs?: number;
}

/** Notices auto-expire after this; errors persist by default (§10 Q1). */
export const TOAST_TTL_MS = 30_000;

/** Hard cap on the visible stack — the oldest is evicted past this, so persistent
 *  errors (which have no TTL) can never grow the banner column unbounded (§5.1). */
export const TOAST_MAX = 4;

type Listener = () => void;

/** Live timer bookkeeping for one toast (absent for a toast with no TTL). */
interface Timer {
  remaining: number; // ms left to run
  startedAt: number; // Date.now() when the current run armed
  handle: ReturnType<typeof setTimeout> | null;
  paused: boolean;
}

// Module-singleton state. `toasts` is replaced (never mutated in place) on every
// change so `getSnapshot` returns a stable reference between changes — the
// contract `useSyncExternalStore` requires.
let toasts: Toast[] = [];
const timers = new Map<string, Timer>();
const listeners = new Set<Listener>();
let seq = 0;

function emit(): void {
  for (const l of listeners) l();
}

/** The effective TTL: an explicit `ttlMs` wins; otherwise notices get the
 *  default and errors get none (persist until dismissed/resolved). */
function effectiveTtl(t: Toast): number | undefined {
  if (t.ttlMs !== undefined) return t.ttlMs;
  return t.kind === "notice" ? TOAST_TTL_MS : undefined;
}

function clearTimer(id: string): void {
  const t = timers.get(id);
  if (t?.handle != null) clearTimeout(t.handle);
  timers.delete(id);
}

function armTimer(toast: Toast, startPaused = false): void {
  const ttl = effectiveTtl(toast);
  if (ttl === undefined) return; // persists — no timer to own
  const timer: Timer = {
    remaining: ttl,
    startedAt: Date.now(),
    handle: null,
    paused: startPaused,
  };
  // A replace-in-place while the toast is hovered/focused re-arms at full TTL
  // but stays PAUSED, so the fresh timer doesn't tick under the pointer (WCAG
  // 2.2.1) — `resume` re-arms it on mouseleave/blur.
  if (!startPaused) {
    timer.handle = setTimeout(() => expire(toast.id), ttl);
  }
  timers.set(toast.id, timer);
}

/** Fired by a toast's own timer: drop the timer record and remove the toast. */
function expire(id: string): void {
  clearTimer(id);
  removeToast(id);
}

function removeToast(id: string): void {
  const next = toasts.filter((t) => t.id !== id);
  if (next.length !== toasts.length) {
    toasts = next;
    emit();
  }
}

/** Replace the toast at `id` in place (same slot, same id → DOM identity is
 *  kept) and reset its timer. Returns the id. */
function replaceInPlace(id: string, input: PushInput): string {
  // Preserve an active pause across the replace: the component instance (same
  // React key = same id) does NOT re-mount, so no fresh mouseenter/focus event
  // fires to re-pause the new timer — carry the paused state here instead.
  const wasPaused = timers.get(id)?.paused ?? false;
  clearTimer(id);
  const toast: Toast = {
    id,
    kind: input.kind,
    message: input.message,
    key: input.key,
    ttlMs: input.ttlMs,
  };
  toasts = toasts.map((t) => (t.id === id ? toast : t));
  armTimer(toast, wasPaused);
  emit();
  return id;
}

function enforceCap(): void {
  while (toasts.length > TOAST_MAX) {
    clearTimer(toasts[0].id);
    toasts = toasts.slice(1);
  }
}

/**
 * Push a toast. A keyed push whose key already exists REPLACES it in place and
 * resets its timer (resolvable validation toasts never stack). An unkeyed ERROR
 * that duplicates an existing unkeyed error `message` replaces rather than stacks
 * — errors have no TTL, so a repeated identical failure must not pile up. Unkeyed
 * NOTICES are NOT deduped: they auto-expire, and a repeated action (e.g. a second
 * unload) must give its own visible feedback rather than silently refreshing an
 * existing identical notice in place. Everything else appends, then the stack is
 * capped at TOAST_MAX (oldest evicted). Returns the toast id.
 */
export function push(input: PushInput): string {
  if (input.key !== undefined) {
    const existing = toasts.find((t) => t.key === input.key);
    if (existing) return replaceInPlace(existing.id, input);
  } else if (input.kind === "error") {
    const dup = toasts.find(
      (t) => t.key === undefined && t.kind === "error" && t.message === input.message,
    );
    if (dup) return replaceInPlace(dup.id, input);
  }
  const id = String(++seq);
  const toast: Toast = {
    id,
    kind: input.kind,
    message: input.message,
    key: input.key,
    ttlMs: input.ttlMs,
  };
  toasts = [...toasts, toast];
  armTimer(toast);
  enforceCap();
  emit();
  return id;
}

/** Dismiss a toast by id, cancelling its pending timer. No-op if unknown. */
export function dismiss(id: string): void {
  clearTimer(id);
  removeToast(id);
}

/** Dismiss the toast carrying `key` (resolve-on-condition). No-op if absent or
 *  already expired — so a paired timer/resolution race never throws. */
export function dismissKey(key: string): void {
  const target = toasts.find((t) => t.key === key);
  if (target) dismiss(target.id);
}

/** Pause a toast's auto-dismiss timer, banking the remaining time (WCAG 2.2.1
 *  hover/focus). No-op for a toast with no timer or already paused. */
export function pause(id: string): void {
  const t = timers.get(id);
  if (!t || t.paused || t.handle == null) return;
  clearTimeout(t.handle);
  t.handle = null;
  t.remaining = Math.max(0, t.remaining - (Date.now() - t.startedAt));
  t.paused = true;
}

/** Resume a paused timer with only the REMAINING time (not a full re-arm). */
export function resume(id: string): void {
  const t = timers.get(id);
  if (!t || !t.paused) return;
  t.paused = false;
  t.startedAt = Date.now();
  t.handle = setTimeout(() => expire(id), t.remaining);
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSnapshot(): Toast[] {
  return toasts;
}

/** Clear every pending timer and empty the stack — called on the owner's
 *  unmount so no stale timer fires against a torn-down tree. */
export function dispose(): void {
  for (const id of [...timers.keys()]) clearTimer(id);
  if (toasts.length) {
    toasts = [];
    emit();
  }
}
