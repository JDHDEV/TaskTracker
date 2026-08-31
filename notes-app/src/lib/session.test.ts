import { beforeEach, describe, expect, it } from "vitest";
import { MAX_SESSION_TABS, readSession, tabKeyId, writeSession, type Session } from "./session";

// Copied verbatim from palettes.test.ts — the node test env has no DOM;
// install a minimal in-memory localStorage (no jsdom by design). A fresh
// store per test keeps them isolated.
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

beforeEach(() => installLocalStorage());

const FULL_SESSION: Omit<Session, "v"> = {
  page: "prompts",
  worknotes: {
    tabKeys: ["proj1:item1", "proj1:item2"],
    activeKey: "proj1:item1",
    filters: {
      kind: "task",
      statusFilter: "doing",
      sort: "priority",
      projectFilter: "proj1",
      tags: ["urgent", "bug"],
    },
  },
  prompts: {
    tabKeys: ["prompt-proj1:p1"],
    activeKey: "prompt-proj1:p1",
    projectId: "proj1",
    reusableOnly: true,
  },
  scratch: {
    projectIds: ["proj1", "proj2"],
    activeProjectId: "proj2",
  },
};

describe("readSession / writeSession round-trip", () => {
  it("writes a full valid shape and reads it back unchanged (normalization is a no-op on valid data)", () => {
    writeSession(FULL_SESSION);
    expect(readSession()).toEqual({ v: 1, ...FULL_SESSION });
  });

  it("merges slices across separate writeSession calls instead of clobbering earlier ones", () => {
    writeSession({ worknotes: FULL_SESSION.worknotes });
    writeSession({ prompts: FULL_SESSION.prompts });

    const result = readSession();
    expect(result?.worknotes).toEqual(FULL_SESSION.worknotes);
    expect(result?.prompts).toEqual(FULL_SESSION.prompts);
  });
});

describe("readSession corruption handling", () => {
  it.each(["not json", "42", "null", "[]"])(
    "returns null for garbage/corrupt JSON: %j",
    (raw) => {
      localStorage.setItem("session", raw);
      expect(readSession()).toBeNull();
    },
  );

  it.each([{ v: 2 }, { v: "1" }, {}])(
    "returns null for an unknown/missing version: %j",
    (bad) => {
      localStorage.setItem("session", JSON.stringify(bad));
      expect(readSession()).toBeNull();
    },
  );

  it("returns null when nothing is stored", () => {
    expect(readSession()).toBeNull();
  });

  it("returns null, never throws, when the storage backend throws on getItem", () => {
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: () => {
        throw new Error("storage disabled");
      },
    } as unknown as Storage;

    expect(() => readSession()).not.toThrow();
    expect(readSession()).toBeNull();
  });
});

describe("readSession field-level fallbacks (never null the whole session for a bad field)", () => {
  it("drops bad enum values to their defaults", () => {
    localStorage.setItem(
      "session",
      JSON.stringify({
        v: 1,
        page: "settings", // not a SessionPage
        worknotes: {
          tabKeys: [],
          activeKey: null,
          filters: { kind: "bogus", statusFilter: 7, sort: null, projectFilter: "", tags: [] },
        },
        prompts: { tabKeys: [], activeKey: null, projectId: "", reusableOnly: false },
        scratch: { projectIds: [], activeProjectId: null },
      }),
    );

    const result = readSession();
    expect(result).not.toBeNull();
    expect(result?.page).toBe("worknotes");
    expect(result?.worknotes.filters.kind).toBe("all");
    expect(result?.worknotes.filters.statusFilter).toBe("all");
    expect(result?.worknotes.filters.sort).toBe("updated");
  });

  it("nulls worknotes.activeKey when it does not name a member of tabKeys", () => {
    localStorage.setItem(
      "session",
      JSON.stringify({
        v: 1,
        page: "worknotes",
        worknotes: { tabKeys: ["a", "b"], activeKey: "c", filters: {} },
        prompts: { tabKeys: [], activeKey: null, projectId: "", reusableOnly: false },
        scratch: { projectIds: [], activeProjectId: null },
      }),
    );

    expect(readSession()?.worknotes.activeKey).toBeNull();
  });

  it("nulls scratch.activeProjectId when it does not name a member of projectIds", () => {
    localStorage.setItem(
      "session",
      JSON.stringify({
        v: 1,
        page: "scratch",
        worknotes: { tabKeys: [], activeKey: null, filters: {} },
        prompts: { tabKeys: [], activeKey: null, projectId: "", reusableOnly: false },
        scratch: { projectIds: ["p1", "p2"], activeProjectId: "p3" },
      }),
    );

    expect(readSession()?.scratch.activeProjectId).toBeNull();
  });

  it("dedupes duplicate tabKeys and silently drops non-string entries", () => {
    localStorage.setItem(
      "session",
      JSON.stringify({
        v: 1,
        page: "worknotes",
        worknotes: {
          tabKeys: ["a", "b", "a", 42, null, "b", { weird: true }],
          activeKey: "b",
          filters: {},
        },
        prompts: { tabKeys: [], activeKey: null, projectId: "", reusableOnly: false },
        scratch: { projectIds: [], activeProjectId: null },
      }),
    );

    expect(readSession()?.worknotes.tabKeys).toEqual(["a", "b"]);
  });

  it(`caps tabKeys at MAX_SESSION_TABS (${MAX_SESSION_TABS})`, () => {
    const many = Array.from({ length: MAX_SESSION_TABS + 5 }, (_, i) => `key-${i}`);
    localStorage.setItem(
      "session",
      JSON.stringify({
        v: 1,
        page: "worknotes",
        worknotes: { tabKeys: many, activeKey: null, filters: {} },
        prompts: { tabKeys: [], activeKey: null, projectId: "", reusableOnly: false },
        scratch: { projectIds: [], activeProjectId: null },
      }),
    );

    const tabKeys = readSession()?.worknotes.tabKeys;
    expect(tabKeys).toHaveLength(MAX_SESSION_TABS);
    expect(tabKeys).toEqual(many.slice(0, MAX_SESSION_TABS));
  });

  it.each(["true", 1, undefined, "false", 0, null])(
    "reads prompts.reusableOnly as false for anything but the literal boolean true: %j",
    (bad) => {
      localStorage.setItem(
        "session",
        JSON.stringify({
          v: 1,
          page: "prompts",
          worknotes: { tabKeys: [], activeKey: null, filters: {} },
          prompts: { tabKeys: [], activeKey: null, projectId: "", reusableOnly: bad },
          scratch: { projectIds: [], activeProjectId: null },
        }),
      );

      expect(readSession()?.prompts.reusableOnly).toBe(false);
    },
  );

  it("reads prompts.reusableOnly as true for the literal boolean true", () => {
    localStorage.setItem(
      "session",
      JSON.stringify({
        v: 1,
        page: "prompts",
        worknotes: { tabKeys: [], activeKey: null, filters: {} },
        prompts: { tabKeys: [], activeKey: null, projectId: "", reusableOnly: true },
        scratch: { projectIds: [], activeProjectId: null },
      }),
    );

    expect(readSession()?.prompts.reusableOnly).toBe(true);
  });
});

describe("tabKeyId", () => {
  it("returns the id after the first colon for a plain <projectId>:<id> key", () => {
    expect(tabKeyId("11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222")).toBe(
      "22222222-2222-2222-2222-222222222222",
    );
  });

  it("returns the id after the first colon for a prompt-<projectId>:<id> key", () => {
    expect(
      tabKeyId("prompt-11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222"),
    ).toBe("22222222-2222-2222-2222-222222222222");
  });

  it("returns null for a draft key with no colon", () => {
    expect(tabKeyId("draft-3")).toBeNull();
  });

  it("returns null for a prompt-draft key with no colon", () => {
    expect(tabKeyId("prompt-draft-4")).toBeNull();
  });

  it("returns null for a colon-only key (empty id)", () => {
    expect(tabKeyId(":")).toBeNull();
  });

  it("returns null for an empty key", () => {
    expect(tabKeyId("")).toBeNull();
  });
});
