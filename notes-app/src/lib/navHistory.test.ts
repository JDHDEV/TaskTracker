import { describe, it, expect } from "vitest";
import {
  MAX_HISTORY,
  back,
  canBack,
  canForward,
  emptyHistory,
  forward,
  navFromKey,
  navFromMouse,
  prune,
  rename,
  visit,
  type NavHistory,
} from "./navHistory";

// Builds a frozen NavHistory fixture (both the object and its entries array)
// so a purity test can assert an implementation never mutates its input.
function frozen(entries: string[], index: number): NavHistory {
  return Object.freeze({ entries: Object.freeze(entries.slice()) as string[], index });
}

describe("visit", () => {
  it("visiting into an empty history puts the cursor on the sole entry, with canBack/canForward both false", () => {
    const result = visit(emptyHistory(), "a");
    expect(result).toEqual({ entries: ["a"], index: 0 });
    expect(canBack(result)).toBe(false);
    expect(canForward(result)).toBe(false);
  });

  it("visiting a, b, c then walking back/forward lands on the expected keys", () => {
    let h = visit(emptyHistory(), "a");
    h = visit(h, "b");
    h = visit(h, "c");
    expect(h.entries).toEqual(["a", "b", "c"]);
    expect(h.index).toBe(2);

    const b1 = back(h);
    expect(b1?.key).toBe("b");
    const b2 = back(b1!.history);
    expect(b2?.key).toBe("a");
    const f1 = forward(b2!.history);
    expect(f1?.key).toBe("b");
  });

  it("back at the start and forward at the end both return null and leave the input reference untouched", () => {
    let h = visit(emptyHistory(), "a");
    h = visit(h, "b");

    // At the start: index 0.
    const atStart = { entries: h.entries, index: 0 };
    expect(back(atStart)).toBeNull();

    // At the end: index === entries.length - 1 (h itself).
    expect(forward(h)).toBeNull();
  });

  it("truncates the forward branch on a new visit after going back: a,b,c, back x2, visit d -> [a,d], canForward false", () => {
    let h = visit(emptyHistory(), "a");
    h = visit(h, "b");
    h = visit(h, "c");

    const afterBack1 = back(h)!;
    const afterBack2 = back(afterBack1.history)!;
    expect(afterBack2.key).toBe("a");

    const afterVisitD = visit(afterBack2.history, "d");
    expect(afterVisitD.entries).toEqual(["a", "d"]);
    expect(afterVisitD.index).toBe(1);
    expect(canForward(afterVisitD)).toBe(false);
  });

  it("visiting the current entry is a no-op (identical reference); a, b, a keeps three distinct entries, not a global dedupe", () => {
    let h = visit(emptyHistory(), "a");
    h = visit(h, "b");
    h = visit(h, "a");
    expect(h.entries).toEqual(["a", "b", "a"]);
    expect(h.index).toBe(2);

    const again = visit(h, "a");
    expect(again).toBe(h); // no-op: same reference
  });

  it("caps retained entries at MAX_HISTORY, keeping the cursor on the newest, and back still works across the evicted boundary", () => {
    let h = emptyHistory();
    for (let i = 0; i < MAX_HISTORY + 5; i++) h = visit(h, `k${i}`);

    expect(h.entries).toHaveLength(MAX_HISTORY);
    expect(h.entries[h.entries.length - 1]).toBe(`k${MAX_HISTORY + 4}`);
    expect(h.entries[0]).toBe("k5"); // the oldest 5 (k0..k4) were evicted
    expect(h.index).toBe(MAX_HISTORY - 1);

    const stepped = back(h)!;
    expect(stepped.key).toBe(`k${MAX_HISTORY + 3}`);
  });

  it("a single eviction beyond the cap drops exactly the oldest entry and shifts survivors, without scrambling any surviving key's identity", () => {
    let h = emptyHistory();
    for (let i = 0; i < MAX_HISTORY; i++) h = visit(h, `k${i}`); // fills exactly to the cap: no eviction yet
    expect(h.entries).toHaveLength(MAX_HISTORY);
    expect(h.entries[0]).toBe("k0");

    const afterOneMore = visit(h, "new");
    expect(afterOneMore.entries).toHaveLength(MAX_HISTORY); // still capped
    expect(afterOneMore.entries[0]).toBe("k1"); // "k0" evicted; "k1" is now the oldest survivor
    expect(afterOneMore.entries[afterOneMore.entries.length - 1]).toBe("new");
    expect(afterOneMore.index).toBe(MAX_HISTORY - 1); // cursor stays on the newest entry
  });

  it("does not mutate its inputs (frozen entries array and history object)", () => {
    const h = frozen(["a", "b"], 1);
    expect(() => visit(h, "c")).not.toThrow();
    expect(h).toEqual({ entries: ["a", "b"], index: 1 });
  });
});

describe("prune", () => {
  it("removes every occurrence of closed keys and collapses adjacent duplicates left behind", () => {
    // [a, b, a] with "b" closed collapses the adjacent "a","a" into one "a".
    const h = { entries: ["a", "b", "a"], index: 2 };
    const result = prune(h, (k) => k !== "b");
    expect(result.entries).toEqual(["a"]);
    expect(result.index).toBe(0);
  });

  it("clamps the cursor to the nearest earlier surviving entry", () => {
    // entries [a, b, c], cursor on c (index 2); b is closed -> a is the
    // nearest earlier survivor, at surviving index 0.
    const h = { entries: ["a", "b", "c"], index: 2 };
    const result = prune(h, (k) => k !== "b" && k !== "c");
    expect(result.entries).toEqual(["a"]);
    expect(result.index).toBe(0);
  });

  it("falls back to the first survivor when nothing survives at or before the cursor", () => {
    // entries [a, b, c], cursor on a (index 0); a is closed, b and c survive.
    const h = { entries: ["a", "b", "c"], index: 0 };
    const result = prune(h, (k) => k !== "a");
    expect(result.entries).toEqual(["b", "c"]);
    expect(result.index).toBe(0); // first survivor
  });

  it("returns index -1 when nothing survives", () => {
    const h = { entries: ["a", "b"], index: 1 };
    const result = prune(h, () => false);
    expect(result.entries).toEqual([]);
    expect(result.index).toBe(-1);
  });

  it("returns the identical reference when nothing is pruned", () => {
    const h = { entries: ["a", "b"], index: 1 };
    const result = prune(h, () => true);
    expect(result).toBe(h);
  });

  it("does not mutate its inputs (frozen entries array and history object)", () => {
    const h = frozen(["a", "b", "c"], 2);
    expect(() => prune(h, (k) => k !== "b")).not.toThrow();
    expect(h).toEqual({ entries: ["a", "b", "c"], index: 2 });
  });
});

describe("rename", () => {
  it("rewrites every occurrence of oldKey to newKey and keeps the cursor on the same visit", () => {
    // [a, old, old] (adjacent duplicate pre-existing), cursor on the second "old".
    const h = { entries: ["a", "old", "old"], index: 2 };
    const result = rename(h, "old", "new");
    expect(result.entries).toEqual(["a", "new"]); // adjacent duplicate collapsed
    expect(result.index).toBe(1); // still pointing at the renamed entry
  });

  it("collapses a duplicate the rewrite creates: [old, new] -> [new] with cursor kept on the renamed visit", () => {
    const h = { entries: ["old", "new"], index: 0 };
    const result = rename(h, "old", "new");
    expect(result.entries).toEqual(["new"]);
    expect(result.index).toBe(0);
  });

  it("returns the identical reference for an unknown oldKey", () => {
    const h = { entries: ["a", "b"], index: 1 };
    const result = rename(h, "does-not-exist", "z");
    expect(result).toBe(h);
  });

  it("does not mutate its inputs (frozen entries array and history object)", () => {
    const h = frozen(["a", "old"], 1);
    expect(() => rename(h, "old", "new")).not.toThrow();
    expect(h).toEqual({ entries: ["a", "old"], index: 1 });
  });
});

describe("navFromKey", () => {
  function key(overrides: Partial<Parameters<typeof navFromKey>[0]> = {}) {
    return {
      key: "ArrowLeft",
      altKey: true,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      ...overrides,
    };
  }

  it("Alt+ArrowLeft maps to back", () => {
    expect(navFromKey(key())).toBe("back");
  });

  it("Alt+ArrowRight maps to forward", () => {
    expect(navFromKey(key({ key: "ArrowRight" }))).toBe("forward");
  });

  it("plain ArrowLeft (no Alt) maps to null", () => {
    expect(navFromKey(key({ altKey: false }))).toBeNull();
  });

  it("Alt+Ctrl+ArrowLeft maps to null (no other modifier allowed)", () => {
    expect(navFromKey(key({ ctrlKey: true }))).toBeNull();
  });

  it("Alt+Meta+ArrowLeft maps to null", () => {
    expect(navFromKey(key({ metaKey: true }))).toBeNull();
  });

  it("Alt+Shift+ArrowLeft maps to null", () => {
    expect(navFromKey(key({ shiftKey: true }))).toBeNull();
  });

  it("an auto-repeat keydown maps to null", () => {
    expect(navFromKey(key({ repeat: true }))).toBeNull();
  });

  it("a keydown mid-IME-composition maps to null", () => {
    expect(navFromKey(key({ isComposing: true }))).toBeNull();
  });

  it("an unrelated key with Alt held maps to null", () => {
    expect(navFromKey(key({ key: "a" }))).toBeNull();
  });
});

describe("navFromMouse", () => {
  it("button 3 (XButton1) maps to back", () => {
    expect(navFromMouse({ button: 3 })).toBe("back");
  });

  it("button 4 (XButton2) maps to forward", () => {
    expect(navFromMouse({ button: 4 })).toBe("forward");
  });

  it("buttons 0, 1, 2 map to null", () => {
    expect(navFromMouse({ button: 0 })).toBeNull();
    expect(navFromMouse({ button: 1 })).toBeNull();
    expect(navFromMouse({ button: 2 })).toBeNull();
  });
});
