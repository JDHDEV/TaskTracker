import { describe, it, expect } from "vitest";
import { normalizeTag, addTag, recomputeTagFilter } from "./tags";

describe("normalizeTag", () => {
  it("lowercases and strips a leading '#'", () => {
    expect(normalizeTag("#Foo")).toBe("foo");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeTag("  Bar  ")).toBe("bar");
  });

  it("returns '' for a lone '#'", () => {
    expect(normalizeTag("#")).toBe("");
  });

  it("returns '' for whitespace-only input", () => {
    expect(normalizeTag("   ")).toBe("");
  });
});

describe("addTag", () => {
  it("normalizes and appends a new tag", () => {
    expect(addTag(["a"], "#B")).toEqual(["a", "b"]);
  });

  it("dedupes across case and leading '#'", () => {
    expect(addTag(["platform"], "Platform")).toEqual(["platform"]);
  });

  it("ignores empty input", () => {
    expect(addTag(["a"], "  ")).toEqual(["a"]);
  });
});

describe("recomputeTagFilter", () => {
  it("drops every selected tag when none remain in vocab", () => {
    expect(recomputeTagFilter(["a", "b"], [])).toEqual([]);
  });

  it("keeps the full set unchanged when nothing was dropped", () => {
    expect(recomputeTagFilter(["a", "b"], ["a", "b", "c"])).toEqual(["a", "b"]);
  });

  it("keeps only survivors, preserving original order", () => {
    expect(recomputeTagFilter(["a", "b", "c"], ["c", "a"])).toEqual(["a", "c"]);
  });

  it("re-includes a tag once it reappears in vocab", () => {
    const afterDrop = recomputeTagFilter(["a", "b"], ["a"]);
    expect(afterDrop).toEqual(["a"]);
    const afterReturn = recomputeTagFilter(afterDrop, ["a", "b"]);
    expect(afterReturn).toEqual(["a"]);
  });

  it("returns [] for an empty selected set", () => {
    expect(recomputeTagFilter([], ["a", "b"])).toEqual([]);
  });
});
