// Pure, unit-testable Back/Forward history for one editor tab strip (Plan 18,
// D3/D5). No React, no DOM, no persistence (R-8: history lives in memory only
// and is never written to the session blob). It is carried as the `history`
// field of OpenTabsState and maintained by the openTabs.ts reducers — the ONE
// place every activeKey change flows through — so it is correct without
// effect-ordering tricks.
//
// Invariant: `entries` hold only OPEN tab keys, and whenever the strip has
// tabs, `entries[index]` is the active key. Keys are opaque strings (the same
// caller-supplied keys openTabs.ts uses); a closed key is pruned, never
// re-opened by Back (v1 default, D5).
//
// Every function returns the INPUT reference on a no-op, so a reducer that
// wraps one can preserve React's bail-out semantics.

export interface NavHistory {
  entries: string[];
  /** Cursor into `entries`; -1 only while `entries` is empty. */
  index: number;
}

/** Hard cap on retained entries: the oldest is evicted past this. */
export const MAX_HISTORY = 50;

/** No entries, no cursor. */
export function emptyHistory(): NavHistory {
  return { entries: [], index: -1 };
}

/**
 * Record a visit to `key`: everything after the cursor is dropped (a new
 * branch, browser-style), `key` is appended and becomes current, and the
 * oldest entries beyond MAX_HISTORY are evicted. Visiting the current entry
 * is a no-op (identical reference), so consecutive duplicates never form.
 */
export function visit(h: NavHistory, key: string): NavHistory {
  if (h.index >= 0 && h.entries[h.index] === key) return h;
  let entries = h.entries.slice(0, h.index + 1);
  entries.push(key);
  if (entries.length > MAX_HISTORY) entries = entries.slice(entries.length - MAX_HISTORY);
  return { entries, index: entries.length - 1 };
}

/**
 * Drop every entry `isOpen` rejects, collapse the adjacent duplicates that
 * removal creates, and clamp the cursor to the nearest EARLIER surviving entry
 * (else the first survivor, else -1 when nothing survives). Identical
 * reference when nothing changed.
 */
export function prune(h: NavHistory, isOpen: (key: string) => boolean): NavHistory {
  const entries: string[] = [];
  let index = -1;
  for (let i = 0; i < h.entries.length; i++) {
    const key = h.entries[i];
    if (!isOpen(key)) continue;
    if (entries.length === 0 || entries[entries.length - 1] !== key) entries.push(key);
    if (i <= h.index) index = entries.length - 1;
  }
  if (entries.length > 0 && index === -1) index = 0;
  if (entries.length === h.entries.length && index === h.index) return h;
  return { entries, index };
}

/**
 * Rewrite every occurrence of `oldKey` as `newKey` (a draft tab promoted to
 * its saved key), collapsing any adjacent duplicates the rewrite creates and
 * keeping the cursor on the same visit. Unknown `oldKey` → identical reference.
 */
export function rename(h: NavHistory, oldKey: string, newKey: string): NavHistory {
  if (oldKey === newKey || !h.entries.includes(oldKey)) return h;
  const entries: string[] = [];
  let index = h.index;
  for (let i = 0; i < h.entries.length; i++) {
    const key = h.entries[i] === oldKey ? newKey : h.entries[i];
    if (entries.length === 0 || entries[entries.length - 1] !== key) entries.push(key);
    if (i === h.index) index = entries.length - 1;
  }
  return { entries, index };
}

/** Whether there is an earlier entry to go back to. */
export function canBack(h: NavHistory): boolean {
  return h.index > 0;
}

/** Whether there is a later entry to go forward to. */
export function canForward(h: NavHistory): boolean {
  return h.index >= 0 && h.index < h.entries.length - 1;
}

/** Move the cursor back one entry; null at the start (the caller keeps `h`). */
export function back(h: NavHistory): { history: NavHistory; key: string } | null {
  if (!canBack(h)) return null;
  const index = h.index - 1;
  return { history: { entries: h.entries, index }, key: h.entries[index] };
}

/** Move the cursor forward one entry; null at the end (the caller keeps `h`). */
export function forward(h: NavHistory): { history: NavHistory; key: string } | null {
  if (!canForward(h)) return null;
  const index = h.index + 1;
  return { history: { entries: h.entries, index }, key: h.entries[index] };
}

export type NavDirection = "back" | "forward";

/**
 * Map a keydown to a navigation: Alt+ArrowLeft → back, Alt+ArrowRight →
 * forward, with NO other modifier held (Ctrl/Meta/Shift combos are someone
 * else's chord), never on an auto-repeat or mid-IME-composition. Structurally
 * typed so it is node-testable without a DOM KeyboardEvent.
 */
export function navFromKey(e: {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
}): NavDirection | null {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
  if (e.repeat || e.isComposing) return null;
  if (e.key === "ArrowLeft") return "back";
  if (e.key === "ArrowRight") return "forward";
  return null;
}

/** Map a mouse button to a navigation: 3 (XButton1) → back, 4 (XButton2) →
 *  forward — the browser's own back/forward buttons. */
export function navFromMouse(e: { button: number }): NavDirection | null {
  if (e.button === 3) return "back";
  if (e.button === 4) return "forward";
  return null;
}
