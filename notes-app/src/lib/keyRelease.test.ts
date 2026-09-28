import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RELEASE_CAP_MS, trackHeldKeys } from "./keyRelease";

function key(type: "keydown" | "keyup", code: string): Event {
  return Object.assign(new Event(type), { code });
}

/** True once `p` has settled; polled after a microtask flush. */
async function settled(p: Promise<void>): Promise<boolean> {
  let done = false;
  void p.then(() => {
    done = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  return done;
}

describe("trackHeldKeys", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("tracks key codes across keydown and keyup", () => {
    const target = new EventTarget();
    const keys = trackHeldKeys(target);
    target.dispatchEvent(key("keydown", "Enter"));
    target.dispatchEvent(key("keydown", "ShiftLeft"));
    expect([...keys.held]).toEqual(["Enter", "ShiftLeft"]);
    target.dispatchEvent(key("keyup", "Enter"));
    expect([...keys.held]).toEqual(["ShiftLeft"]);
  });

  it("resolves immediately when nothing is held", async () => {
    const keys = trackHeldKeys(new EventTarget());
    expect(await settled(keys.whenReleased())).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for the held key to come up, and not a moment longer", async () => {
    const target = new EventTarget();
    const keys = trackHeldKeys(target);
    target.dispatchEvent(key("keydown", "Enter"));
    const p = keys.whenReleased();
    expect(await settled(p)).toBe(false);
    vi.advanceTimersByTime(RELEASE_CAP_MS - 1);
    expect(await settled(p)).toBe(false);
    target.dispatchEvent(key("keyup", "Enter"));
    expect(await settled(p)).toBe(true);
    // The cap timer is cancelled once the release arrives.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for every held key, not just the first one released", async () => {
    const target = new EventTarget();
    const keys = trackHeldKeys(target);
    target.dispatchEvent(key("keydown", "ShiftLeft"));
    target.dispatchEvent(key("keydown", "Tab"));
    const p = keys.whenReleased();
    target.dispatchEvent(key("keyup", "Tab"));
    expect(await settled(p)).toBe(false);
    target.dispatchEvent(key("keyup", "ShiftLeft"));
    expect(await settled(p)).toBe(true);
  });

  it("gives up after the cap when the key-up never arrives", async () => {
    const target = new EventTarget();
    const keys = trackHeldKeys(target);
    target.dispatchEvent(key("keydown", "Enter"));
    const p = keys.whenReleased();
    vi.advanceTimersByTime(RELEASE_CAP_MS - 1);
    expect(await settled(p)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(await settled(p)).toBe(true);
    // The key is still down as far as the tracker knows: a later wait must
    // start its own cap rather than resolve at once.
    expect([...keys.held]).toEqual(["Enter"]);
    expect(await settled(keys.whenReleased())).toBe(false);
  });

  it("honours a caller-supplied cap", async () => {
    const target = new EventTarget();
    const keys = trackHeldKeys(target);
    target.dispatchEvent(key("keydown", "Enter"));
    const p = keys.whenReleased(50);
    vi.advanceTimersByTime(49);
    expect(await settled(p)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(await settled(p)).toBe(true);
  });

  it("treats window blur as releasing everything", async () => {
    const target = new EventTarget();
    const keys = trackHeldKeys(target);
    target.dispatchEvent(key("keydown", "Enter"));
    const p = keys.whenReleased();
    target.dispatchEvent(new Event("blur"));
    expect(keys.held.size).toBe(0);
    expect(await settled(p)).toBe(true);
  });

  it("wakes every concurrent waiter on the same release", async () => {
    const target = new EventTarget();
    const keys = trackHeldKeys(target);
    target.dispatchEvent(key("keydown", "Delete"));
    const a = keys.whenReleased();
    const b = keys.whenReleased();
    target.dispatchEvent(key("keyup", "Delete"));
    expect(await settled(a)).toBe(true);
    expect(await settled(b)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  // Not covered here: the capture-phase registration (a shortcut handler on a
  // descendant that stops propagation must not hide the key). Node's flat
  // EventTarget has no tree, so capture and bubble order cannot be told apart.
});
