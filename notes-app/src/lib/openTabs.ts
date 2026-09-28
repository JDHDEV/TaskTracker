// Pure, unit-testable tab-state transitions for the editor tab bar (Plan 11,
// Change 1). No React, no IPC. App.tsx (items) and PromptsPage.tsx (prompts)
// each own their own OpenTabsState and drive it through these functions; the
// invariant-bearing logic (adjacency on close, no-op on unknown key, draft-key
// promotion) lives here so it can be tested in the node-env vitest setup rather
// than through the DOM.
//
// Tab identity is the caller-supplied `key` string — App builds it with
// itemKey() from projects.ts, PromptsPage the same way, and a fresh draft gets a
// synthetic `draft-<uuid>` key (plan.15 D8: the bare UUID doubles as the
// on-disk draft-backup id, stable across restarts). The reducer treats the key
// as opaque, so two distinct entities/projects never collapse as long as the
// caller keys them distinctly.
//
// Plan 18 (D3): the state also carries the strip's Back/Forward `history`
// (navHistory.ts), maintained HERE — every activeKey change goes through these
// reducers, so openTab/activateTab record a visit, closeTab/closeTabs prune the
// closed key (and re-visit the neighbour that took over, D4), promoteTab
// renames the draft key, and navigateTab moves the cursor WITHOUT recording.
// The history is in-memory only; session.ts never persists it (R-8).

import {
  back,
  emptyHistory,
  forward,
  prune,
  rename,
  visit,
  type NavDirection,
  type NavHistory,
} from "./navHistory";

/** One open tab: its stable key, a snapshot of the entity it edits, and whether
 *  the mounted editor currently has unsaved edits (surfaced via onDirtyChange). */
export interface Tab<T> {
  key: string;
  item: T;
  isDirty: boolean;
}

/** The open-tab set (tab order), which one is active (null = empty state), and
 *  the Back/Forward history over previously viewed tabs (open keys only;
 *  `history.entries[history.index]` is the active key while tabs exist). */
export interface OpenTabsState<T> {
  tabs: Tab<T>[];
  activeKey: string | null;
  history: NavHistory;
}

/** The initial empty state — no tabs, no active key (renders the placeholder). */
export function emptyTabs<T>(): OpenTabsState<T> {
  return { tabs: [], activeKey: null, history: emptyHistory() };
}

// Stable DOM ids derived from a tab key, so the tab (`role="tab"`) and its editor
// panel (`role="tabpanel"`) can cross-reference via aria-controls/aria-labelledby.
// Keys are UUID-composite or `draft-<uuid>` strings — never user text — so these
// ids never carry untrusted content. Referenced by exact-string ARIA attributes
// only (no CSS selector / querySelector), so the `:` in a composite key is fine.
export function tabDomId(key: string): string {
  return `etab-${key}`;
}
export function tabPanelDomId(key: string): string {
  return `etabpanel-${key}`;
}

/** Whether a tab with `key` is open. */
export function hasTab<T>(state: OpenTabsState<T>, key: string): boolean {
  return state.tabs.some((t) => t.key === key);
}

/** The keys of every tab with unsaved edits (plan 17 feature 7): the rails
 *  mark their rows from this set. Derived from in-memory tab state only, never
 *  persisted (R-16); a key leaves the set only when its editor reports clean
 *  after a save that returned ok. */
export function dirtyKeys<T>(state: OpenTabsState<T>): Set<string> {
  const keys = new Set<string>();
  for (const t of state.tabs) if (t.isDirty) keys.add(t.key);
  return keys;
}

/** How many open tabs have unsaved edits — the page-tab badge count. Drafts
 *  (which have no rail row) count here even though they mark no row. */
export function dirtyCount<T>(state: OpenTabsState<T>): number {
  let n = 0;
  for (const t of state.tabs) if (t.isDirty) n += 1;
  return n;
}

/** The active tab, or null when the set is empty. */
export function activeTab<T>(state: OpenTabsState<T>): Tab<T> | null {
  return state.tabs.find((t) => t.key === state.activeKey) ?? null;
}

/**
 * Open `key` (or activate it if already open). A new tab is appended at the end
 * and becomes active; an already-open key is not duplicated and simply becomes
 * active, its position and edit buffer untouched. `initialDirty` seeds the
 * unsaved dot (true for a fresh draft, which starts dirty).
 */
export function openTab<T>(
  state: OpenTabsState<T>,
  key: string,
  item: T,
  initialDirty = false,
): OpenTabsState<T> {
  if (hasTab(state, key)) return activateTab(state, key);
  return {
    tabs: [...state.tabs, { key, item, isDirty: initialDirty }],
    activeKey: key,
    history: visit(state.history, key),
  };
}

/** Activate an already-open tab (recorded as a history visit). Unknown key →
 *  no-op (no dangling activeKey). */
export function activateTab<T>(state: OpenTabsState<T>, key: string): OpenTabsState<T> {
  if (!hasTab(state, key) || state.activeKey === key) return state;
  return { ...state, activeKey: key, history: visit(state.history, key) };
}

/**
 * Close a tab. When the ACTIVE tab is closed, activate its right neighbor if one
 * exists, else its left neighbor; closing the last tab clears activeKey (empty
 * state). Closing a non-active tab leaves activeKey and order untouched. Unknown
 * key → no-op. The closed tab's dirty bookkeeping is dropped with the tab.
 */
export function closeTab<T>(state: OpenTabsState<T>, key: string): OpenTabsState<T> {
  const index = state.tabs.findIndex((t) => t.key === key);
  if (index === -1) return state;
  const tabs = state.tabs.filter((t) => t.key !== key);
  // The closed key leaves the history (D5: Back never reopens a closed tab).
  let history = prune(state.history, (k) => tabs.some((t) => t.key === k));
  if (state.activeKey !== key) return { tabs, activeKey: state.activeKey, history };
  // Closing the active tab: right neighbor (now at the same index) if present,
  // otherwise the left neighbor, otherwise nothing left → empty state. The
  // neighbour's activation is a visit (D4): prune's clamp may land elsewhere,
  // and `entries[index]` must stay the active key.
  const neighbor = tabs[index] ?? tabs[index - 1] ?? null;
  if (neighbor) history = visit(history, neighbor.key);
  return { tabs, activeKey: neighbor ? neighbor.key : null, history };
}

/**
 * Close several tabs at once (Plan 18 "Close all"). Unknown and duplicate keys
 * are ignored; an empty or all-unknown list → identical reference. When the
 * active tab is among them, the nearest surviving RIGHT neighbour of its
 * original position takes over, else the nearest surviving left one, else the
 * empty state — the same rule as closeTab, applied once to the whole set (so
 * the result can differ from folding closeTab, which walks neighbour by
 * neighbour). History is pruned and the take-over is a visit (D4).
 */
export function closeTabs<T>(state: OpenTabsState<T>, keys: readonly string[]): OpenTabsState<T> {
  const closing = new Set(keys);
  if (!state.tabs.some((t) => closing.has(t.key))) return state;
  const tabs = state.tabs.filter((t) => !closing.has(t.key));
  let activeKey = state.activeKey;
  if (activeKey !== null && closing.has(activeKey)) {
    const origin = state.tabs.findIndex((t) => t.key === activeKey);
    let neighbor: Tab<T> | null = null;
    for (let i = origin + 1; i < state.tabs.length && !neighbor; i++)
      if (!closing.has(state.tabs[i].key)) neighbor = state.tabs[i];
    for (let i = origin - 1; i >= 0 && !neighbor; i--)
      if (!closing.has(state.tabs[i].key)) neighbor = state.tabs[i];
    activeKey = neighbor ? neighbor.key : null;
  }
  let history = prune(state.history, (k) => tabs.some((t) => t.key === k));
  if (activeKey !== null && activeKey !== state.activeKey) history = visit(history, activeKey);
  return { tabs, activeKey, history };
}

/**
 * Back/Forward (Plan 18): move the history cursor one step and activate the
 * key it lands on WITHOUT recording a visit (navigation never records itself).
 * Identical reference at either end, or when the target is somehow not open
 * (R-8: entries are validated on use, never trusted).
 */
export function navigateTab<T>(state: OpenTabsState<T>, dir: NavDirection): OpenTabsState<T> {
  const step = dir === "back" ? back(state.history) : forward(state.history);
  if (!step || !hasTab(state, step.key)) return state;
  return { ...state, activeKey: step.key, history: step.history };
}

/**
 * Collapse the history to just the active key (or nothing). Called ONCE after
 * an owner's session restore, whose replayed openTab calls would otherwise
 * read as a walk through every restored tab.
 */
export function resetHistory<T>(state: OpenTabsState<T>): OpenTabsState<T> {
  const history = state.activeKey === null ? emptyHistory() : visit(emptyHistory(), state.activeKey);
  return { ...state, history };
}

/** Set a tab's unsaved flag. Unknown key → no-op; other tabs untouched. */
export function setDirty<T>(
  state: OpenTabsState<T>,
  key: string,
  isDirty: boolean,
): OpenTabsState<T> {
  if (!hasTab(state, key)) return state;
  return {
    ...state,
    tabs: state.tabs.map((t) => (t.key === key ? { ...t, isDirty } : t)),
  };
}

/**
 * Replace a tab's snapshot in place (refresh reconciliation): overwrite the
 * stored `item` without changing key, position, active status, or dirty flag.
 * Unknown key → no-op. Used after a background refresh so Pin/Archive labels
 * (rendered from the snapshot) don't go stale, without disturbing the mounted
 * editor's in-progress edit buffer (which lives in the instance, not here).
 */
export function setTabItem<T>(
  state: OpenTabsState<T>,
  key: string,
  item: T,
): OpenTabsState<T> {
  if (!hasTab(state, key)) return state;
  return {
    ...state,
    tabs: state.tabs.map((t) => (t.key === key ? { ...t, item } : t)),
  };
}

/**
 * Promote a draft tab to its real key after the draft's first save: rename
 * `oldKey` → `newKey` in place, swap in the created `item` snapshot, clear the
 * dirty flag, and keep the tab active if it was. Preserves position so the tab
 * doesn't jump. No-op if `oldKey` isn't open; if `newKey` is somehow already
 * open, the stale duplicate is dropped so the promoted tab is the only one.
 */
export function promoteTab<T>(
  state: OpenTabsState<T>,
  oldKey: string,
  newKey: string,
  item: T,
): OpenTabsState<T> {
  if (!hasTab(state, oldKey)) return state;
  const tabs = state.tabs
    .filter((t) => t.key === oldKey || t.key !== newKey)
    .map((t) => (t.key === oldKey ? { key: newKey, item, isDirty: false } : t));
  return {
    tabs,
    activeKey: state.activeKey === oldKey ? newKey : state.activeKey,
    // The draft's visits follow it to the saved key (no dangling draft entry).
    history: rename(state.history, oldKey, newKey),
  };
}
