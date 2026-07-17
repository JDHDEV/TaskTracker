import { beforeEach, describe, expect, it } from "vitest";
import { getPreferredProvider, setPreferredProvider } from "./aiProvider";

// The node test env has no DOM; install a minimal in-memory localStorage (no
// jsdom by design). A fresh store per test keeps them isolated.
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

describe("getPreferredProvider / setPreferredProvider", () => {
  beforeEach(() => installLocalStorage());

  it("returns the stored provider when set to a known id", () => {
    setPreferredProvider("openai");
    expect(getPreferredProvider()).toBe("openai");
  });

  it("falls back to anthropic when unset", () => {
    expect(getPreferredProvider()).toBe("anthropic");
  });

  it("falls back to anthropic for an unrecognized stored value", () => {
    localStorage.setItem("provider", "gemini");
    expect(getPreferredProvider()).toBe("anthropic");
  });

  it("round-trips both providers", () => {
    setPreferredProvider("openai");
    expect(getPreferredProvider()).toBe("openai");
    setPreferredProvider("anthropic");
    expect(getPreferredProvider()).toBe("anthropic");
  });
});
