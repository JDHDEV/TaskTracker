import { describe, it, expect } from "vitest";
import {
  activateTab,
  activeTab,
  closeTab,
  dirtyCount,
  dirtyKeys,
  emptyTabs,
  hasTab,
  openTab,
  promoteTab,
  setDirty,
  setTabItem,
  tabDomId,
  tabPanelDomId,
} from "./openTabs";

// Items are plain strings ("Item A", etc.) — the reducer is generic on the
// string `key`; identity is what these tests exercise, not item shape.

describe("openTab", () => {
  it("opens a tab into an empty state, making it the sole active tab", () => {
    const result = openTab(emptyTabs<string>(), "a", "Item A");
    expect(result.tabs).toEqual([{ key: "a", item: "Item A", isDirty: false }]);
    expect(result.activeKey).toBe("a");
    expect(activeTab(result)?.item).toBe("Item A");
  });

  it("appends a second distinct key at the end and activates it, leaving the first tab untouched", () => {
    const afterFirst = openTab(emptyTabs<string>(), "a", "Item A");
    const firstTab = afterFirst.tabs[0];

    const result = openTab(afterFirst, "b", "Item B");

    expect(result.tabs.map((t) => t.key)).toEqual(["a", "b"]);
    expect(result.tabs[0]).toBe(firstTab); // same object: untouched
    expect(result.tabs[1]).toEqual({ key: "b", item: "Item B", isDirty: false });
    expect(result.activeKey).toBe("b");
  });

  it("opening an already-open key does not duplicate it, activates it, and preserves its position and stored item/dirty", () => {
    let state = openTab(emptyTabs<string>(), "a", "Item A");
    state = openTab(state, "b", "Item B");
    state = setDirty(state, "a", true); // give "a" a distinctive dirty snapshot
    state = activateTab(state, "b"); // move active away from "a"

    const result = openTab(state, "a", "A NEW SNAPSHOT THAT MUST BE IGNORED");

    expect(result.tabs).toHaveLength(2); // no duplicate
    expect(result.tabs.map((t) => t.key)).toEqual(["a", "b"]); // position unchanged
    expect(result.tabs[0]).toEqual({ key: "a", item: "Item A", isDirty: true }); // item/dirty NOT overwritten
    expect(result.activeKey).toBe("a");
  });

  it("defaults a fresh tab's isDirty to false", () => {
    const result = openTab(emptyTabs<string>(), "a", "Item A");
    expect(result.tabs[0].isDirty).toBe(false);
  });

  it("respects initialDirty=true for a fresh tab", () => {
    const result = openTab(emptyTabs<string>(), "draft-1", "New draft", true);
    expect(result.tabs[0].isDirty).toBe(true);
  });

  it("keeps two keys that differ only by a project prefix as distinct tabs", () => {
    let state = openTab(emptyTabs<string>(), "projA:1", "Item in project A");
    state = openTab(state, "projB:1", "Item in project B");

    expect(state.tabs).toHaveLength(2);
    expect(hasTab(state, "projA:1")).toBe(true);
    expect(hasTab(state, "projB:1")).toBe(true);
  });

  it("keeps an item key and a prompt key sharing the same suffix as distinct tabs", () => {
    let state = openTab(emptyTabs<string>(), "x:1", "Item x");
    state = openTab(state, "prompt-x:1", "Prompt x");

    expect(state.tabs).toHaveLength(2);
    expect(hasTab(state, "x:1")).toBe(true);
    expect(hasTab(state, "prompt-x:1")).toBe(true);
  });
});

describe("activateTab", () => {
  it("activating an existing non-active tab changes only activeKey; the tabs array is bit-for-bit unchanged", () => {
    let state = openTab(emptyTabs<string>(), "a", "Item A");
    state = openTab(state, "b", "Item B"); // "b" is active after opening

    const result = activateTab(state, "a");

    expect(result.tabs).toBe(state.tabs); // exact same array reference: no reorder, no copy
    expect(result.activeKey).toBe("a");
  });

  it("activating the already-active key is idempotent (returns the identical state)", () => {
    const state = openTab(emptyTabs<string>(), "a", "Item A");
    const result = activateTab(state, "a");
    expect(result).toBe(state);
  });

  it("activating an unknown key is a no-op: activeKey is unchanged, nothing dangles", () => {
    const state = openTab(emptyTabs<string>(), "a", "Item A");
    const result = activateTab(state, "does-not-exist");
    expect(result).toBe(state);
    expect(result.activeKey).toBe("a");
  });
});

describe("setDirty", () => {
  it("flips only the target tab's isDirty, leaving other tabs untouched", () => {
    let state = openTab(emptyTabs<string>(), "a", "Item A");
    state = openTab(state, "b", "Item B");
    const bTabBefore = state.tabs[1];

    const result = setDirty(state, "a", true);

    expect(result.tabs[0].isDirty).toBe(true);
    expect(result.tabs[1]).toBe(bTabBefore); // "b" untouched, same object
  });

  it("is a no-op for an unknown key", () => {
    const state = openTab(emptyTabs<string>(), "a", "Item A");
    const result = setDirty(state, "does-not-exist", true);
    expect(result).toBe(state);
  });

  it("supports a dirty -> clean transition", () => {
    let state = openTab(emptyTabs<string>(), "a", "Item A", true);
    expect(state.tabs[0].isDirty).toBe(true);

    state = setDirty(state, "a", false);
    expect(state.tabs[0].isDirty).toBe(false);
  });
});

describe("closeTab", () => {
  // Fixture: three tabs opened in order a, b, c ("c" active by default since
  // openTab activates the freshly-opened tab).
  function threeTabs() {
    let state = openTab(emptyTabs<string>(), "a", "Item A");
    state = openTab(state, "b", "Item B");
    state = openTab(state, "c", "Item C");
    return state;
  }

  it("closing a non-active tab removes only it, leaves activeKey unchanged, preserves order of the rest", () => {
    const state = activateTab(threeTabs(), "a"); // active = "a" (first), close a different one
    const result = closeTab(state, "b");

    expect(result.tabs.map((t) => t.key)).toEqual(["a", "c"]);
    expect(result.activeKey).toBe("a");
  });

  it("closing the only open tab empties tabs and clears activeKey", () => {
    const state = openTab(emptyTabs<string>(), "a", "Item A");
    const result = closeTab(state, "a");
    expect(result.tabs).toEqual([]);
    expect(result.activeKey).toBeNull();
  });

  it("closing the active tab when it is FIRST activates the right neighbor", () => {
    const state = activateTab(threeTabs(), "a"); // active = "a" (index 0)
    const result = closeTab(state, "a");

    expect(result.tabs.map((t) => t.key)).toEqual(["b", "c"]);
    expect(result.activeKey).toBe("b");
    expect(activeTab(result)?.item).toBe("Item B");
  });

  it("closing the active tab when it is in the MIDDLE activates the right neighbor", () => {
    const state = activateTab(threeTabs(), "b"); // active = "b" (index 1)
    const result = closeTab(state, "b");

    expect(result.tabs.map((t) => t.key)).toEqual(["a", "c"]);
    expect(result.activeKey).toBe("c");
  });

  it("closing the active tab when it is LAST activates the left neighbor (no right neighbor exists)", () => {
    const state = activateTab(threeTabs(), "c"); // active = "c" (index 2, last)
    const result = closeTab(state, "c");

    expect(result.tabs.map((t) => t.key)).toEqual(["a", "b"]);
    expect(result.activeKey).toBe("b");
  });

  it("closing an unknown key is a no-op", () => {
    const state = threeTabs();
    const result = closeTab(state, "does-not-exist");
    expect(result).toBe(state);
  });

  it("closing a tab drops only its own dirty bookkeeping, leaving other tabs' dirty flags intact", () => {
    let state = threeTabs();
    state = setDirty(state, "b", true);
    state = activateTab(state, "a"); // close a non-active tab so we isolate the dirty-preservation check

    const result = closeTab(state, "a");

    expect(hasTab(result, "a")).toBe(false);
    expect(result.tabs.find((t) => t.key === "b")?.isDirty).toBe(true);
    expect(result.tabs.find((t) => t.key === "c")?.isDirty).toBe(false);
  });
});

describe("promoteTab", () => {
  // Fixture: "a", a dirty draft "draft-1", then "c" — draft in the middle,
  // not active (opening "c" last makes it active).
  function draftMiddleState() {
    let state = openTab(emptyTabs<string>(), "a", "Item A");
    state = openTab(state, "draft-1", "New draft", true);
    state = openTab(state, "c", "Item C");
    return state;
  }

  it("renames oldKey to newKey in place, swaps in the new item, and clears isDirty", () => {
    const state = draftMiddleState();
    const result = promoteTab(state, "draft-1", "real:1", "Saved Item");

    expect(result.tabs.map((t) => t.key)).toEqual(["a", "real:1", "c"]); // same position
    expect(result.tabs[1]).toEqual({ key: "real:1", item: "Saved Item", isDirty: false });
  });

  it("activates newKey when oldKey was the active tab", () => {
    let state = draftMiddleState();
    state = activateTab(state, "draft-1");

    const result = promoteTab(state, "draft-1", "real:1", "Saved Item");
    expect(result.activeKey).toBe("real:1");
  });

  it("leaves activeKey unchanged when oldKey was not the active tab", () => {
    const state = draftMiddleState(); // active is "c", not the draft
    const result = promoteTab(state, "draft-1", "real:1", "Saved Item");
    expect(result.activeKey).toBe("c");
  });

  it("is a no-op when oldKey is not open", () => {
    const state = draftMiddleState();
    const result = promoteTab(state, "does-not-exist", "real:1", "Saved Item");
    expect(result).toBe(state);
  });
});

describe("setTabItem", () => {
  it("replaces a tab's item snapshot, preserving key, position, isDirty, and activeKey", () => {
    let state = openTab(emptyTabs<string>(), "a", "Item A");
    state = openTab(state, "b", "Item B");
    state = setDirty(state, "b", true);
    state = activateTab(state, "a");

    const result = setTabItem(state, "b", "Refreshed Item B");

    expect(result.tabs.map((t) => t.key)).toEqual(["a", "b"]); // position unchanged
    expect(result.tabs[1]).toEqual({ key: "b", item: "Refreshed Item B", isDirty: true });
    expect(result.activeKey).toBe("a");
  });

  it("is a no-op for an unknown key", () => {
    const state = openTab(emptyTabs<string>(), "a", "Item A");
    const result = setTabItem(state, "does-not-exist", "X");
    expect(result).toBe(state);
  });
});

// --- plan.15 (draft restore): pins on EXISTING openTab/setDirty behavior that
// the boot-time draft-restore union code relies on. These are regression pins
// on already-implemented openTabs.ts, not new behavior, so — unlike
// drafts.test.ts — they are expected to PASS immediately (exempt from the
// fail-first check that applies to the not-yet-implemented drafts module).
describe("plan.15 draft-restore pins", () => {
  it("a restored draft tab opens dirty immediately via openTab's initialDirty, keyed draft-<uuid>", () => {
    const key = "draft-550e8400-e29b-41d4-a716-446655440000";
    const result = openTab(emptyTabs<string>(), key, "Restored draft content", true);
    expect(result.tabs).toEqual([{ key, item: "Restored draft content", isDirty: true }]);
    expect(result.activeKey).toBe(key);
  });

  it("openTab on an ALREADY-OPEN key ignores initialDirty: activation only, dirty flag untouched (restore-union code must call setDirty explicitly)", () => {
    let state = openTab(emptyTabs<string>(), "a", "Item A"); // isDirty: false
    state = openTab(state, "b", "Item B"); // "b" becomes active

    // Re-"opening" "a" as if restoring it dirty must NOT flip its dirty flag.
    const result = openTab(state, "a", "IGNORED SNAPSHOT", true);

    expect(result.tabs.find((t) => t.key === "a")).toEqual({
      key: "a",
      item: "Item A",
      isDirty: false,
    });
    expect(result.activeKey).toBe("a"); // activation still happens
  });
});

// plan 17 feature 7: pure derivation of "which open tabs have unsaved edits"
// for the rail markers and page-tab badges (D9). No React, no persistence
// (R-16) — these read straight off OpenTabsState.
describe("dirtyKeys / dirtyCount", () => {
  it("an empty state has an empty dirty set and a zero count", () => {
    const state = emptyTabs<string>();
    expect(dirtyKeys(state)).toEqual(new Set());
    expect(dirtyCount(state)).toBe(0);
  });

  it("with mixed clean/dirty tabs, dirtyKeys returns only the dirty ones and dirtyCount matches its size", () => {
    let state = openTab(emptyTabs<string>(), "a", "Item A"); // clean
    state = openTab(state, "b", "Item B"); // clean
    state = openTab(state, "c", "Item C"); // will be made dirty
    state = setDirty(state, "a", true);
    state = setDirty(state, "c", true);

    const keys = dirtyKeys(state);
    expect(keys).toEqual(new Set(["a", "c"]));
    expect(keys.has("b")).toBe(false);
    expect(dirtyCount(state)).toBe(2);
  });

  it("setDirty(key, false) removes the key from dirtyKeys and decrements dirtyCount", () => {
    let state = openTab(emptyTabs<string>(), "a", "Item A");
    state = setDirty(state, "a", true);
    expect(dirtyKeys(state)).toEqual(new Set(["a"]));
    expect(dirtyCount(state)).toBe(1);

    state = setDirty(state, "a", false);
    expect(dirtyKeys(state)).toEqual(new Set());
    expect(dirtyCount(state)).toBe(0);
  });

  it("closeTab removes a dirty tab's key from dirtyKeys and decrements dirtyCount", () => {
    let state = openTab(emptyTabs<string>(), "a", "Item A");
    state = openTab(state, "b", "Item B");
    state = setDirty(state, "a", true);
    state = setDirty(state, "b", true);
    expect(dirtyCount(state)).toBe(2);

    state = closeTab(state, "a");
    expect(dirtyKeys(state)).toEqual(new Set(["b"]));
    expect(dirtyCount(state)).toBe(1);
  });

  it("promoteTab clears the dirty flag on the promoted tab: the OLD key leaves the set and the NEW key is not in it", () => {
    let state = openTab(emptyTabs<string>(), "draft-1", "New draft", true); // starts dirty
    expect(dirtyKeys(state)).toEqual(new Set(["draft-1"]));

    state = promoteTab(state, "draft-1", "real:1", "Saved Item");

    // promoteTab hard-codes isDirty: false on the promoted tab (openTabs.ts) —
    // this is NOT "the dirty flag carries over to the new key": neither the
    // old nor the new key is dirty afterward.
    expect(dirtyKeys(state).has("draft-1")).toBe(false);
    expect(dirtyKeys(state).has("real:1")).toBe(false);
    expect(dirtyKeys(state)).toEqual(new Set());
    expect(dirtyCount(state)).toBe(0);
  });

  it("keeps composite keys from two projects sharing the same item uuid as distinct dirty entries", () => {
    let state = openTab(emptyTabs<string>(), "projA:1", "Item in project A");
    state = openTab(state, "projB:1", "Item in project B");
    state = setDirty(state, "projA:1", true);

    const keys = dirtyKeys(state);
    expect(keys.has("projA:1")).toBe(true);
    expect(keys.has("projB:1")).toBe(false);
    expect(dirtyCount(state)).toBe(1);

    state = setDirty(state, "projB:1", true);
    expect(dirtyKeys(state)).toEqual(new Set(["projA:1", "projB:1"]));
    expect(dirtyCount(state)).toBe(2);
  });

  it("returns a fresh Set each call: mutating the result does not affect subsequent reads of the same state", () => {
    let state = openTab(emptyTabs<string>(), "a", "Item A");
    state = setDirty(state, "a", true);

    const keys = dirtyKeys(state);
    keys.add("intruder");
    keys.delete("a");

    // A second, independent call proves the mutation above didn't touch the
    // underlying state.
    expect(dirtyKeys(state)).toEqual(new Set(["a"]));
    expect(dirtyKeys(state).has("intruder")).toBe(false);
  });
});

describe("tabDomId / tabPanelDomId", () => {
  it("return distinct, stable, prefixed strings for the same key", () => {
    expect(tabDomId("a:1")).toBe("etab-a:1");
    expect(tabPanelDomId("a:1")).toBe("etabpanel-a:1");
    expect(tabDomId("a:1")).toBe(tabDomId("a:1")); // stable across calls
    expect(tabDomId("a:1")).not.toBe(tabPanelDomId("a:1")); // tab id != panel id
  });

  it("produce distinct ids for distinct keys", () => {
    expect(tabDomId("a")).not.toBe(tabDomId("b"));
    expect(tabPanelDomId("a")).not.toBe(tabPanelDomId("b"));
  });
});
