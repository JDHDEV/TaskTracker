import { beforeEach, describe, expect, it } from "vitest";
import {
  PALETTES,
  getStoredPalette,
  isPaletteId,
  polarityOf,
  setStoredPalette,
  type PaletteId,
  type Polarity,
} from "./palettes";

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

const EXPECTED_POLARITY: Record<PaletteId, Polarity> = {
  original: "light",
  "v2-light": "light",
  "v2-dark": "dark",
  "neon-noir": "dark",
  "claude-terminal": "dark",
};

const KNOWN_IDS = Object.keys(EXPECTED_POLARITY) as PaletteId[];

describe("PALETTES registry", () => {
  it("has exactly 5 palettes with unique ids", () => {
    expect(PALETTES).toHaveLength(5);
    expect(new Set(PALETTES.map((p) => p.id)).size).toBe(5);
  });

  it("has an id set exactly matching the known palette vocabulary", () => {
    expect(new Set(PALETTES.map((p) => p.id))).toEqual(new Set(KNOWN_IDS));
  });

  it("gives every entry a non-empty id, label, and light/dark polarity", () => {
    for (const p of PALETTES) {
      expect(p.id.length).toBeGreaterThan(0);
      expect(p.label.length).toBeGreaterThan(0);
      expect(["light", "dark"]).toContain(p.polarity);
    }
  });
});

describe("polarityOf", () => {
  it.each(KNOWN_IDS)("reports the declared polarity for %s", (id) => {
    expect(polarityOf(id)).toBe(EXPECTED_POLARITY[id]);
  });
});

describe("isPaletteId", () => {
  it.each(KNOWN_IDS)("is true for known id %s", (id) => {
    expect(isPaletteId(id)).toBe(true);
  });

  it.each([null, "", "gemini", "dark", "Original", "v2light", "  original"])(
    "is false for %j",
    (bad) => {
      expect(isPaletteId(bad)).toBe(false);
    },
  );
});

describe("getStoredPalette / setStoredPalette", () => {
  beforeEach(() => installLocalStorage());

  it("falls back to original when unset", () => {
    expect(getStoredPalette()).toBe("original");
  });

  it.each(KNOWN_IDS)("round-trips %s through set then get", (id) => {
    setStoredPalette(id);
    expect(getStoredPalette()).toBe(id);
  });

  it("falls back to original for an unrecognized stored value", () => {
    localStorage.setItem("palette", "bogus");
    expect(getStoredPalette()).toBe("original");
  });

  it("falls back to original for the stale legacy 'dark' value", () => {
    localStorage.setItem("palette", "dark");
    expect(getStoredPalette()).toBe("original");
  });
});
