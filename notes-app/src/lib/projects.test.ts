import { describe, it, expect } from "vitest";
import type { Item, ProjectInfo } from "../types";
import {
  itemKey,
  loadedProjects,
  nextToken,
  resolveCreateTarget,
  shouldCommit,
} from "./projects";

function proj(id: string, loaded: boolean): ProjectInfo {
  return { id, name: id.toUpperCase(), path: `/p/${id}`, loaded };
}

describe("loadedProjects", () => {
  it("keeps only loaded projects", () => {
    const known = [proj("a", true), proj("b", false), proj("c", true)];
    expect(loadedProjects(known).map((p) => p.id)).toEqual(["a", "c"]);
  });

  it("returns [] when none are loaded", () => {
    expect(loadedProjects([proj("a", false)])).toEqual([]);
  });
});

describe("itemKey", () => {
  it("keys by project AND id", () => {
    expect(itemKey({ id: "x", projectId: "p1" } as Item)).toBe("p1:x");
  });

  it("does not collapse the same id across two projects", () => {
    const a = itemKey({ id: "dup", projectId: "p1" } as Item);
    const b = itemKey({ id: "dup", projectId: "p2" } as Item);
    expect(a).not.toBe(b);
  });

  it("tolerates a null projectId", () => {
    expect(itemKey({ id: "x", projectId: null } as Item)).toBe(":x");
  });
});

describe("request-token guard", () => {
  it("only commits the latest token; a stale one is dropped", () => {
    let latest = 0;
    const a = latest = nextToken(latest); // load A → token 1
    const b = latest = nextToken(latest); // load B → token 2 (newer)
    // B resolves first, then A — the later-resolving stale A must not commit.
    expect(shouldCommit(b, latest)).toBe(true);
    expect(shouldCommit(a, latest)).toBe(false);
  });

  it("newer wins regardless of resolution order", () => {
    let latest = 0;
    const a = latest = nextToken(latest);
    const b = latest = nextToken(latest);
    // A resolves first (stale), B second (current)
    expect(shouldCommit(a, latest)).toBe(false);
    expect(shouldCommit(b, latest)).toBe(true);
  });
});

describe("resolveCreateTarget", () => {
  const loaded = [proj("p1", true), proj("p2", true)];

  it("uses the rail filter when it names a loaded project", () => {
    expect(resolveCreateTarget("p2", loaded)).toBe("p2");
  });

  it("is empty for the All-projects filter (editor must choose)", () => {
    expect(resolveCreateTarget("", loaded)).toBe("");
  });

  it("is empty when the filtered project is not loaded", () => {
    expect(resolveCreateTarget("gone", loaded)).toBe("");
  });
});
