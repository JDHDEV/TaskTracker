import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as store from "./toasts";
import { TOAST_MAX, TOAST_TTL_MS } from "./toasts";

// Module-singleton store: reset it (and fake timers) before every test so no
// test can see state — or a pending real timer — left over by another.
beforeEach(() => {
  vi.useFakeTimers();
  store.dispose();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("push", () => {
  it("adds a toast visible via getSnapshot", () => {
    const id = store.push({ kind: "notice", message: "Saved" });
    const snap = store.getSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({ id, kind: "notice", message: "Saved" });
  });

  it("a keyed push replacing an existing key updates in place (same slot) and resets the TTL", () => {
    const id = store.push({ kind: "notice", message: "first", key: "k" });
    vi.advanceTimersByTime(TOAST_TTL_MS - 1); // just before the original expiry
    expect(store.getSnapshot()).toHaveLength(1);

    const id2 = store.push({ kind: "notice", message: "second", key: "k" });
    expect(id2).toBe(id); // same slot/id — replace in place, not a new toast
    expect(store.getSnapshot()).toHaveLength(1);
    expect(store.getSnapshot()[0]).toMatchObject({ kind: "notice", message: "second" });

    // The ORIGINAL remaining amount would have expired the toast if the TTL
    // had not been reset — it must still be present.
    vi.advanceTimersByTime(TOAST_TTL_MS - 1);
    expect(store.getSnapshot()).toHaveLength(1);

    // The rest of the (reset) TTL elapses → now it expires.
    vi.advanceTimersByTime(1);
    expect(store.getSnapshot()).toHaveLength(0);
  });
});

describe("dismiss / dismissKey", () => {
  it("dismiss removes exactly the target toast, leaving others", () => {
    const a = store.push({ kind: "error", message: "A" });
    const b = store.push({ kind: "error", message: "B" });
    store.dismiss(a);
    const snap = store.getSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].id).toBe(b);
  });

  it("dismissKey removes exactly the toast carrying that key, leaving others", () => {
    store.push({ kind: "error", message: "unrelated" });
    const keyedId = store.push({ kind: "notice", message: "keyed", key: "field-x" });
    store.dismissKey("field-x");
    const snap = store.getSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap.some((t) => t.id === keyedId)).toBe(false);
    expect(snap[0].message).toBe("unrelated");
  });
});

describe("TTL boundary", () => {
  it("a notice is present just before TOAST_TTL_MS and gone one ms later", () => {
    store.push({ kind: "notice", message: "expiring" });
    vi.advanceTimersByTime(TOAST_TTL_MS - 1);
    expect(store.getSnapshot()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(store.getSnapshot()).toHaveLength(0);
  });
});

describe("constants", () => {
  it("TOAST_TTL_MS is 30_000ms", () => {
    expect(TOAST_TTL_MS).toBe(30_000);
  });
});

describe("manual dismiss cancels the pending timer", () => {
  it("dismissing the only toast drops the timer count to zero", () => {
    const id = store.push({ kind: "notice", message: "only" });
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    store.dismiss(id);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("resolve-path", () => {
  it("dismissKey before TTL removes immediately, and advancing past the original TTL does not throw", () => {
    const id = store.push({ kind: "notice", message: "Checking…", key: "validate-title" });
    vi.advanceTimersByTime(5_000);
    store.dismissKey("validate-title");
    expect(store.getSnapshot().some((t) => t.id === id)).toBe(false);
    expect(() => vi.advanceTimersByTime(TOAST_TTL_MS)).not.toThrow();
    expect(store.getSnapshot()).toHaveLength(0);
  });
});

describe("independent per-toast timers", () => {
  it("advancing to the older toast's expiry removes only the older one", () => {
    const older = store.push({ kind: "notice", message: "older" });
    vi.advanceTimersByTime(5);
    store.push({ kind: "notice", message: "younger" });

    // Older armed at t=0, expires at TOAST_TTL_MS. Younger armed at t=5,
    // expires at TOAST_TTL_MS + 5. Advance to just past the older's expiry.
    vi.advanceTimersByTime(TOAST_TTL_MS - 5);
    const snap = store.getSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap.some((t) => t.id === older)).toBe(false);
    expect(snap[0].message).toBe("younger");
  });
});

describe("dispose", () => {
  it("clears all pending timers and empties the snapshot", () => {
    store.push({ kind: "notice", message: "a" });
    store.push({ kind: "notice", message: "b" });
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    store.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(store.getSnapshot()).toHaveLength(0);
  });
});

describe("default TTL by kind", () => {
  it("errors default to no TTL; notices default to 30s", () => {
    store.push({ kind: "error", message: "persists" });
    store.push({ kind: "notice", message: "expires" });
    vi.advanceTimersByTime(TOAST_TTL_MS + 1);
    const snap = store.getSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].message).toBe("persists");
  });
});

describe("pause / resume", () => {
  it("resume continues the REMAINING time, not a full re-arm", () => {
    const id = store.push({ kind: "notice", message: "hoverable" });
    vi.advanceTimersByTime(10_000); // 10s elapsed of 30s TTL
    store.pause(id);

    // Paused: advancing well past the original TTL must not expire it.
    vi.advanceTimersByTime(TOAST_TTL_MS);
    expect(store.getSnapshot()).toHaveLength(1);

    store.resume(id);
    // ~20s should remain (30s - 10s already elapsed).
    vi.advanceTimersByTime(TOAST_TTL_MS - 10_000 - 1);
    expect(store.getSnapshot()).toHaveLength(1); // just before the remaining time elapses
    vi.advanceTimersByTime(1);
    expect(store.getSnapshot()).toHaveLength(0);
  });

  it("a keyed replace while paused stays paused (does not silently re-arm under the pointer)", () => {
    // WCAG 2.2.1: a hovered/focused toast is paused; re-pushing its key (or an
    // identical unkeyed message) must NOT start a fresh timer that ticks down
    // while the pointer still rests on it — the component does not re-mount, so
    // no new mouseenter fires. The replace re-arms at full TTL but stays PAUSED.
    const id = store.push({ kind: "notice", message: "first", key: "k" });
    store.pause(id); // user hovers it

    store.push({ kind: "notice", message: "second", key: "k" }); // same key re-pushed
    // Still paused after the replace: advancing well past a full TTL keeps it.
    vi.advanceTimersByTime(TOAST_TTL_MS * 2);
    expect(store.getSnapshot()).toHaveLength(1);
    expect(store.getSnapshot()[0]).toMatchObject({ message: "second" });

    // On mouseleave/blur the resumed timer counts down the (full, reset) TTL.
    store.resume(id);
    vi.advanceTimersByTime(TOAST_TTL_MS - 1);
    expect(store.getSnapshot()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(store.getSnapshot()).toHaveLength(0);
  });
});

describe("dedup + cap", () => {
  it("pushing the same unkeyed ERROR twice keeps one entry (persistent, no TTL)", () => {
    store.push({ kind: "error", message: "Network error" });
    store.push({ kind: "error", message: "Network error" });
    const snap = store.getSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].message).toBe("Network error");
  });

  it("pushing the same unkeyed NOTICE twice keeps BOTH (each action gives feedback)", () => {
    // Notices auto-expire, so an identical repeat (e.g. a second unload) must
    // show its own toast rather than silently refreshing the first in place.
    store.push({ kind: "notice", message: "Unloaded \"Alpha\"." });
    store.push({ kind: "notice", message: "Unloaded \"Alpha\"." });
    const snap = store.getSnapshot();
    expect(snap).toHaveLength(2);
    expect(snap.every((t) => t.message === 'Unloaded "Alpha".')).toBe(true);
  });

  it("pushing 5 distinct unkeyed toasts caps at TOAST_MAX, evicting the oldest", () => {
    const ids = [1, 2, 3, 4, 5].map((n) => store.push({ kind: "error", message: `err ${n}` }));
    const snap = store.getSnapshot();
    expect(snap).toHaveLength(TOAST_MAX);
    expect(snap.some((t) => t.id === ids[0])).toBe(false); // oldest evicted
    expect(snap.map((t) => t.message)).toEqual(["err 2", "err 3", "err 4", "err 5"]);
  });
});

describe("subscribe / getSnapshot", () => {
  it("notifies subscribers on push, dismiss, and expiry", () => {
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    const id = store.push({ kind: "notice", message: "hi" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toHaveLength(1);

    store.dismiss(id);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).toHaveLength(0);

    store.push({ kind: "notice", message: "bye" });
    expect(listener).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(TOAST_TTL_MS);
    expect(listener).toHaveBeenCalledTimes(4);
    expect(store.getSnapshot()).toHaveLength(0);

    unsubscribe();
  });
});

describe("edge cases", () => {
  it("two different keys expiring on the same tick both clear without throwing", () => {
    store.push({ kind: "notice", message: "one", key: "k1" });
    store.push({ kind: "notice", message: "two", key: "k2" });
    expect(() => vi.advanceTimersByTime(TOAST_TTL_MS)).not.toThrow();
    expect(store.getSnapshot()).toHaveLength(0);
  });

  it("dismissKey on an absent or already-expired key is a no-op", () => {
    store.push({ kind: "error", message: "unrelated" }); // no default TTL — survives the advances below
    expect(() => store.dismissKey("never-existed")).not.toThrow();
    expect(store.getSnapshot()).toHaveLength(1);

    const id = store.push({ kind: "notice", message: "will expire", key: "k" });
    vi.advanceTimersByTime(TOAST_TTL_MS);
    expect(store.getSnapshot().some((t) => t.id === id)).toBe(false);
    expect(() => store.dismissKey("k")).not.toThrow();
    expect(store.getSnapshot()).toHaveLength(1); // only "unrelated" remains
  });
});
