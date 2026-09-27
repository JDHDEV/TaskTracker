import { beforeEach, describe, expect, it } from "vitest";
import { getReviewLayout, setReviewLayout, isReviewLayout } from "./reviewLayout";

// The node test env has no DOM; install a minimal in-memory localStorage (no
// jsdom by design), matching the aiProvider.test.ts pattern. A fresh store per
// test keeps them isolated.
function installLocalStorage(): void {
  const store = new Map<string, string>();
  const stub: Pick<Storage, "getItem" | "setItem" | "removeItem" | "clear"> = {
    getItem: (k) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
    clear: () => store.clear(),
  };
  (globalThis as unknown as { localStorage: Storage }).localStorage =
    stub as unknown as Storage;
}

// A storage whose getItem/setItem always throw (a private window or blocked
// site data) — get/set must degrade quietly rather than propagate.
function installThrowingLocalStorage(): void {
  const stub: Pick<Storage, "getItem" | "setItem" | "removeItem" | "clear"> = {
    getItem: () => {
      throw new Error("storage disabled");
    },
    setItem: () => {
      throw new Error("storage disabled");
    },
    removeItem: () => {
      throw new Error("storage disabled");
    },
    clear: () => {
      throw new Error("storage disabled");
    },
  };
  (globalThis as unknown as { localStorage: Storage }).localStorage =
    stub as unknown as Storage;
}

describe("getReviewLayout / setReviewLayout", () => {
  beforeEach(() => installLocalStorage());

  it("defaults to 'inline' when unset", () => {
    expect(getReviewLayout()).toBe("inline");
  });

  it("defaults to 'inline' for a garbage stored value", () => {
    localStorage.setItem("reviewLayout", "sideways");
    expect(getReviewLayout()).toBe("inline");
  });

  it("defaults to 'inline' for an empty stored value", () => {
    localStorage.setItem("reviewLayout", "");
    expect(getReviewLayout()).toBe("inline");
  });

  it("round-trips 'inline'", () => {
    setReviewLayout("split"); // start from the non-default so the round-trip is meaningful
    setReviewLayout("inline");
    expect(getReviewLayout()).toBe("inline");
  });

  it("round-trips 'split'", () => {
    setReviewLayout("split");
    expect(getReviewLayout()).toBe("split");
  });

  it("persists under exactly the key 'reviewLayout'", () => {
    setReviewLayout("split");
    expect(localStorage.getItem("reviewLayout")).toBe("split");
  });
});

describe("isReviewLayout", () => {
  it("accepts 'inline' and 'split'", () => {
    expect(isReviewLayout("inline")).toBe(true);
    expect(isReviewLayout("split")).toBe(true);
  });

  it("rejects null", () => {
    expect(isReviewLayout(null)).toBe(false);
  });

  it("rejects undefined", () => {
    expect(isReviewLayout(undefined)).toBe(false);
  });

  it("rejects a number", () => {
    expect(isReviewLayout(1)).toBe(false);
  });

  it("rejects a wrong-case match ('SPLIT')", () => {
    expect(isReviewLayout("SPLIT")).toBe(false);
  });

  it("rejects an unrelated string", () => {
    expect(isReviewLayout("sideways")).toBe(false);
  });
});

describe("throwing storage", () => {
  beforeEach(() => installThrowingLocalStorage());

  it("getReviewLayout() returns the 'inline' default when storage.getItem throws", () => {
    expect(getReviewLayout()).toBe("inline");
  });

  it("setReviewLayout('split') does not throw when storage.setItem throws", () => {
    expect(() => setReviewLayout("split")).not.toThrow();
  });
});
