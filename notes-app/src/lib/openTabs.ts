// Pure, unit-testable tab-state transitions for the editor tab bar (Plan 11,
// Change 1). No React, no IPC. App.tsx (items) and PromptsPage.tsx (prompts)
// each own their own OpenTabsState and drive it through these functions; the
// invariant-bearing logic (adjacency on close, no-op on unknown key, draft-key
// promotion) lives here so it can be tested in the node-env vitest setup rather
// than through the DOM.
//
// Tab identity is the caller-supplied `key` string — App builds it with
// itemKey() from projects.ts, PromptsPage the same way, and a fresh draft gets a
// synthetic `draft-<seq>` key. The reducer treats the key as opaque, so two
// distinct entities/projects never collapse as long as the caller keys them
// distinctly.

/** One open tab: its stable key, a snapshot of the entity it edits, and whether
 *  the mounted editor currently has unsaved edits (surfaced via onDirtyChange). */
export interface Tab<T> {
  key: string;
  item: T;
  isDirty: boolean;
}

/** The open-tab set (tab order) plus which one is active (null = empty state). */
export interface OpenTabsState<T> {
  tabs: Tab<T>[];
  activeKey: string | null;
}

/** The initial empty state — no tabs, no active key (renders the placeholder). */
export function emptyTabs<T>(): OpenTabsState<T> {
  return { tabs: [], activeKey: null };
}

// Stable DOM ids derived from a tab key, so the tab (`role="tab"`) and its editor
// panel (`role="tabpanel"`) can cross-reference via aria-controls/aria-labelledby.
// Keys are UUID-composite or `draft-<seq>` strings — never user text — so these
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
  };
}

/** Activate an already-open tab. Unknown key → no-op (no dangling activeKey). */
export function activateTab<T>(state: OpenTabsState<T>, key: string): OpenTabsState<T> {
  if (!hasTab(state, key) || state.activeKey === key) return state;
  return { ...state, activeKey: key };
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
  if (state.activeKey !== key) return { tabs, activeKey: state.activeKey };
  // Closing the active tab: right neighbor (now at the same index) if present,
  // otherwise the left neighbor, otherwise nothing left → empty state.
  const neighbor = tabs[index] ?? tabs[index - 1] ?? null;
  return { tabs, activeKey: neighbor ? neighbor.key : null };
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
  };
}
