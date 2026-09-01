import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DRAFT_IDLE_MS,
  DRAFT_MAX_WAIT_MS,
  DraftQueue,
  bufferEqualsItem,
  buildItemDraft,
  buildPromptDraft,
  buildScratchDraft,
  classifyPromptRestore,
  classifyRestore,
  classifyScratchRestore,
  contentHash,
  draftIdFromTabKey,
  draftTabKey,
  flushAllDrafts,
  isUuid,
  promptDraftTabKey,
  registerFlushable,
  sanitizeDraft,
  shouldFlush,
  unregisterFlushable,
  type ItemBuffer,
} from "./drafts";
import { toDateInputValue } from "./dueDate";
import { tabKeyId } from "./session";
import type { Draft, Item } from "../types";

// Fixture UUIDs (canonical v4 shape; the values themselves carry no meaning).
const ITEM_ID = "550e8400-e29b-41d4-a716-446655440000";
const PROJECT_ID = "660e8400-e29b-41d4-a716-446655440000";
const OTHER_PROJECT_ID = "990e8400-e29b-41d4-a716-446655440000";
const PROMPT_ID = "770e8400-e29b-41d4-a716-446655440000";
const DRAFT_ID = "880e8400-e29b-41d4-a716-446655440000";

function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: ITEM_ID,
    kind: "task",
    title: "Original title",
    body: "Original body",
    status: "todo",
    priority: "normal",
    dueAt: null,
    tags: ["a", "b"],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    archived: false,
    pinned: false,
    projectId: PROJECT_ID,
    jiraUrl: null,
    schemaVersion: "1.0.0",
    ...overrides,
  };
}

function makeBuffer(overrides: Partial<ItemBuffer> = {}): ItemBuffer {
  return {
    title: "Original title",
    body: "Original body",
    status: "todo",
    priority: "normal",
    dueAt: "",
    tags: ["a", "b"],
    projectId: PROJECT_ID,
    jiraUrl: "",
    ...overrides,
  };
}

function makeItemDraft(overrides: Partial<Draft> = {}): Draft {
  return {
    v: 1,
    draftId: DRAFT_ID,
    surface: "item",
    projectId: PROJECT_ID,
    entityId: ITEM_ID,
    kind: "task",
    baseUpdatedAt: "2026-01-02T00:00:00Z",
    baseHash: "",
    savedAt: "2026-01-02T00:05:00Z",
    title: "Original title",
    status: "todo",
    priority: "normal",
    dueAt: "",
    tags: ["a", "b"],
    jiraUrl: "",
    body: "Original body",
    ...overrides,
  };
}

function makePromptDraft(overrides: Partial<Draft> = {}): Draft {
  return {
    v: 1,
    draftId: DRAFT_ID,
    surface: "prompt",
    projectId: PROJECT_ID,
    entityId: PROMPT_ID,
    kind: null,
    baseUpdatedAt: "2026-01-02T00:00:00Z",
    baseHash: "",
    savedAt: "",
    title: "Prompt title",
    status: null,
    priority: null,
    dueAt: "",
    tags: [],
    jiraUrl: "",
    body: "Prompt body",
    ...overrides,
  };
}

interface PromptFixture {
  id: string;
  title: string;
  body: string;
  updatedAt: string;
  projectId: string | null;
}

function makePromptFixture(overrides: Partial<PromptFixture> = {}): PromptFixture {
  return {
    id: PROMPT_ID,
    title: "Prompt title",
    body: "Prompt body",
    updatedAt: "2026-01-02T00:00:00Z",
    projectId: PROJECT_ID,
    ...overrides,
  };
}

function makeScratchDraft(overrides: Partial<Draft> = {}): Draft {
  return {
    v: 1,
    draftId: PROJECT_ID,
    surface: "scratch",
    projectId: PROJECT_ID,
    entityId: "",
    kind: null,
    baseUpdatedAt: "",
    baseHash: "",
    savedAt: "",
    title: "",
    status: null,
    priority: null,
    dueAt: "",
    tags: [],
    jiraUrl: "",
    body: "",
    ...overrides,
  };
}

/** A manually-controlled promise, for driving fake async ops with precise
 *  ordering (no real timers/IO involved). */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// --- isUuid / tab keys --------------------------------------------------

describe("isUuid", () => {
  it("accepts a canonical 8-4-4-4-12 hex UUID", () => {
    expect(isUuid(ITEM_ID)).toBe(true);
  });

  it("accepts uppercase hex WITH correct 8-4-4-4-12 grouping", () => {
    expect(isUuid(ITEM_ID.toUpperCase())).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(isUuid("")).toBe(false);
  });

  it("rejects a prefixed tab-key form", () => {
    expect(isUuid(`draft-${ITEM_ID}`)).toBe(false);
  });

  it("rejects the same hex with no dashes", () => {
    expect(isUuid("550e8400e29b41d4a716446655440000")).toBe(false);
  });

  it("rejects path-traversal-shaped garbage", () => {
    expect(isUuid("../escape")).toBe(false);
  });

  it("rejects colon-shaped garbage", () => {
    expect(isUuid("a:b")).toBe(false);
  });
});

describe("draftTabKey / promptDraftTabKey", () => {
  it("draftTabKey produces `draft-<id>`", () => {
    expect(draftTabKey(ITEM_ID)).toBe(`draft-${ITEM_ID}`);
  });

  it("promptDraftTabKey produces `prompt-draft-<id>`", () => {
    expect(promptDraftTabKey(ITEM_ID)).toBe(`prompt-draft-${ITEM_ID}`);
  });
});

describe("draftIdFromTabKey", () => {
  it("round-trips a draftTabKey back to the bare id", () => {
    expect(draftIdFromTabKey(draftTabKey(ITEM_ID))).toBe(ITEM_ID);
  });

  it("round-trips a promptDraftTabKey back to the bare id", () => {
    expect(draftIdFromTabKey(promptDraftTabKey(ITEM_ID))).toBe(ITEM_ID);
  });

  it("returns null for a saved-item key (<projectId>:<id>)", () => {
    expect(draftIdFromTabKey(`${PROJECT_ID}:${PROMPT_ID}`)).toBeNull();
  });

  it("returns null for a draft- key whose remainder is not a UUID", () => {
    expect(draftIdFromTabKey("draft-not-a-uuid")).toBeNull();
  });

  it("returns null for a prompt-draft- key with an empty remainder", () => {
    expect(draftIdFromTabKey("prompt-draft-")).toBeNull();
  });

  it("returns null for a bare uuid with no prefix", () => {
    expect(draftIdFromTabKey(ITEM_ID)).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(draftIdFromTabKey("")).toBeNull();
  });
});

describe("cross-check with session.ts tabKeyId (D8: draft keys stay invisible to session persistence)", () => {
  it("tabKeyId never extracts an id out of a draft tab key", () => {
    expect(tabKeyId(draftTabKey(ITEM_ID))).toBeNull();
    expect(tabKeyId(promptDraftTabKey(ITEM_ID))).toBeNull();
  });
});

// --- shouldFlush ---------------------------------------------------------

describe("constants", () => {
  it("DRAFT_IDLE_MS is 1000ms and DRAFT_MAX_WAIT_MS is 5000ms", () => {
    expect(DRAFT_IDLE_MS).toBe(1000);
    expect(DRAFT_MAX_WAIT_MS).toBe(5000);
  });
});

describe("shouldFlush", () => {
  it("never fires when there is nothing new since the last flush, regardless of elapsed time", () => {
    expect(shouldFlush(100, 100, 1_000_000)).toBe(false); // equal timestamps
    expect(shouldFlush(50, 100, 1_000_000)).toBe(false); // edit strictly before the last flush
  });

  // NOTE: the task brief's illustrative numbers for this case ("edit at t=0,
  // flush at t=-10000") would, under the documented OR semantics (confirmed
  // below by the max-wait tests), already satisfy the max-wait branch at
  // now=999 (elapsed-since-flush = 10999ms >= DRAFT_MAX_WAIT_MS), making the
  // "false at 999" expectation self-contradictory. We isolate the idle-only
  // branch instead by keeping the last flush RECENT (just before the edit),
  // so elapsed-since-flush never approaches DRAFT_MAX_WAIT_MS in this test.
  it("is not yet flush-worthy just before the idle threshold", () => {
    expect(shouldFlush(0, -1, DRAFT_IDLE_MS - 1)).toBe(false);
  });

  it("flushes once the buffer has been idle for exactly DRAFT_IDLE_MS", () => {
    expect(shouldFlush(0, -1, DRAFT_IDLE_MS)).toBe(true);
  });

  it("max-wait during continuous typing: does not yet fire just before DRAFT_MAX_WAIT_MS", () => {
    const now = DRAFT_MAX_WAIT_MS - 1;
    expect(shouldFlush(now - 100, 0, now)).toBe(false); // edit 100ms ago: nowhere near idle
  });

  it("max-wait during continuous typing: fires at exactly DRAFT_MAX_WAIT_MS even though never idle", () => {
    const now = DRAFT_MAX_WAIT_MS;
    expect(shouldFlush(now - 100, 0, now)).toBe(true); // still only 100ms since the last edit
  });

  it("does not re-fire immediately after a flush that just updated lastFlushAt to now", () => {
    // The hook's realistic post-flush check: lastFlushAt has caught up to
    // lastEditAt, so there's nothing new yet — same gate as the first test,
    // exercised at the exact call shape the hook would make right after a flush.
    expect(shouldFlush(1000, 1000, 1000)).toBe(false);
  });
});

// --- buildItemDraft / buildPromptDraft / buildScratchDraft ---------------

describe("buildItemDraft", () => {
  it("copies every buffer field into the Draft and stamps surface/entity/kind/baseUpdatedAt/placeholders", () => {
    const base = {
      id: ITEM_ID,
      kind: "task" as const,
      updatedAt: "2026-01-02T00:00:00Z",
      title: "Base title",
      body: "Base body",
    };
    const buffer = makeBuffer({
      title: "T",
      body: "B",
      status: "doing",
      priority: "high",
      dueAt: "2026-07-20",
      tags: ["x", "y"],
      projectId: PROJECT_ID,
      jiraUrl: "http://x",
    });

    const draft = buildItemDraft(DRAFT_ID, base, buffer);

    expect(draft.draftId).toBe(DRAFT_ID);
    expect(draft.surface).toBe("item");
    expect(draft.entityId).toBe(base.id);
    expect(draft.kind).toBe(base.kind);
    expect(draft.baseUpdatedAt).toBe(base.updatedAt);
    // Post-review F13: the draft fingerprints the BASE content (title+body),
    // so a hand-edited file whose updated_at was not bumped still conflicts.
    expect(draft.baseHash).toBe(contentHash("Base title\nBase body"));
    expect(draft.v).toBe(1);
    expect(draft.savedAt).toBe("");
    expect(draft.title).toBe(buffer.title);
    expect(draft.body).toBe(buffer.body);
    expect(draft.status).toBe(buffer.status);
    expect(draft.priority).toBe(buffer.priority);
    expect(draft.dueAt).toBe(buffer.dueAt);
    expect(draft.tags).toEqual(buffer.tags);
    expect(draft.projectId).toBe(buffer.projectId);
    expect(draft.jiraUrl).toBe(buffer.jiraUrl);
  });

  it("does not share the tags array reference with the buffer", () => {
    const buffer = makeBuffer({ tags: ["a", "b"] });
    const draft = buildItemDraft(
      DRAFT_ID,
      { id: ITEM_ID, kind: "task", updatedAt: "u", title: "t", body: "b" },
      buffer,
    );

    expect(draft.tags).not.toBe(buffer.tags);
    buffer.tags.push("mutated");
    expect(draft.tags).toEqual(["a", "b"]);
  });

  it("a never-saved base (id '', updatedAt '') flows through as entityId ''/baseUpdatedAt ''/baseHash ''", () => {
    const base = { id: "", kind: "note" as const, updatedAt: "", title: "", body: "" };
    const draft = buildItemDraft(DRAFT_ID, base, makeBuffer());

    expect(draft.entityId).toBe("");
    expect(draft.baseUpdatedAt).toBe("");
    expect(draft.baseHash).toBe(""); // no base, no fingerprint
  });
});

describe("buildPromptDraft", () => {
  it("assembles a prompt-surface draft: kind null, status/priority null, dueAt/jiraUrl '', tags []", () => {
    const base = {
      id: PROMPT_ID,
      updatedAt: "2026-01-02T00:00:00Z",
      title: "Saved title",
      body: "Saved body",
    };
    const buffer = { title: "Prompt title", body: "Prompt body", projectId: PROJECT_ID };

    const draft = buildPromptDraft(DRAFT_ID, base, buffer);

    // The fingerprint is of the BASE (saved) content, not the buffer's (F13).
    expect(draft.baseHash).toBe(contentHash("Saved title\nSaved body"));
    expect(draft.surface).toBe("prompt");
    expect(draft.kind).toBeNull();
    expect(draft.status).toBeNull();
    expect(draft.priority).toBeNull();
    expect(draft.dueAt).toBe("");
    expect(draft.jiraUrl).toBe("");
    expect(draft.tags).toEqual([]);
    expect(draft.entityId).toBe(base.id);
    expect(draft.baseUpdatedAt).toBe(base.updatedAt);
    expect(draft.title).toBe(buffer.title);
    expect(draft.body).toBe(buffer.body);
    expect(draft.projectId).toBe(buffer.projectId);
  });
});

describe("buildScratchDraft", () => {
  it("keys the draft by the project id, with entityId '', title '', and the passed baseHash", () => {
    const draft = buildScratchDraft(PROJECT_ID, "somehash", "pad content");

    expect(draft.draftId).toBe(PROJECT_ID);
    expect(draft.projectId).toBe(PROJECT_ID);
    expect(draft.entityId).toBe("");
    expect(draft.baseHash).toBe("somehash");
    expect(draft.title).toBe("");
    expect(draft.surface).toBe("scratch");
    expect(draft.body).toBe("pad content");
  });
});

// --- bufferEqualsItem (kind-gated) ---------------------------------------

describe("bufferEqualsItem", () => {
  describe("note kind", () => {
    const noteItem = makeItem({
      kind: "note",
      status: null,
      priority: null,
      dueAt: null,
      title: "T",
      body: "B",
      tags: ["x", "y"],
      jiraUrl: null,
      projectId: PROJECT_ID,
    });
    const matchingBuffer = makeBuffer({
      title: "T",
      body: "B",
      tags: ["x", "y"],
      status: null,
      priority: null,
      dueAt: "",
      jiraUrl: "",
      projectId: PROJECT_ID,
    });

    it("identical note buffer vs note item -> true (also: item.jiraUrl null equals buffer jiraUrl '')", () => {
      expect(bufferEqualsItem(matchingBuffer, noteItem)).toBe(true);
    });

    it("differing body -> false", () => {
      expect(bufferEqualsItem({ ...matchingBuffer, body: "different" }, noteItem)).toBe(false);
    });

    it("differing title -> false", () => {
      expect(bufferEqualsItem({ ...matchingBuffer, title: "different" }, noteItem)).toBe(false);
    });

    it("differing tags, same length but a different member -> false", () => {
      expect(bufferEqualsItem({ ...matchingBuffer, tags: ["x", "z"] }, noteItem)).toBe(false);
    });

    it("differing tags, different length -> false", () => {
      expect(bufferEqualsItem({ ...matchingBuffer, tags: ["x", "y", "z"] }, noteItem)).toBe(false);
    });

    it("differing jiraUrl -> false", () => {
      const item = { ...noteItem, jiraUrl: "https://example/A" };
      expect(bufferEqualsItem({ ...matchingBuffer, jiraUrl: "https://example/B" }, item)).toBe(false);
    });

    it("ignores status/priority/dueAt differences entirely (a note has none of its own)", () => {
      const buffer = {
        ...matchingBuffer,
        status: "doing" as const,
        priority: "high" as const,
        dueAt: "2099-12-31",
      };
      expect(bufferEqualsItem(buffer, noteItem)).toBe(true);
    });
  });

  describe("task kind", () => {
    const taskItem = makeItem({
      kind: "task",
      status: "todo",
      priority: "normal",
      dueAt: "2026-07-20T00:00:00.000+00:00",
      title: "T",
      body: "B",
      tags: ["x"],
      jiraUrl: null,
      projectId: PROJECT_ID,
    });
    const matchingBuffer = makeBuffer({
      title: "T",
      body: "B",
      tags: ["x"],
      status: "todo",
      priority: "normal",
      dueAt: "2026-07-20",
      jiraUrl: "",
      projectId: PROJECT_ID,
    });

    it("identical task buffer vs task item -> true", () => {
      expect(bufferEqualsItem(matchingBuffer, taskItem)).toBe(true);
    });

    it("differing status: buffer 'doing' vs item 'todo' -> false", () => {
      expect(bufferEqualsItem({ ...matchingBuffer, status: "doing" }, taskItem)).toBe(false);
    });

    it("item.status null (defensive) equals buffer 'todo' (the editor's seeding default)", () => {
      const item = { ...taskItem, status: null };
      expect(bufferEqualsItem({ ...matchingBuffer, status: "todo" }, item)).toBe(true);
    });

    it("item.priority null (defensive) equals buffer 'normal' (the editor's seeding default)", () => {
      const item = { ...taskItem, priority: null };
      expect(bufferEqualsItem({ ...matchingBuffer, priority: "normal" }, item)).toBe(true);
    });

    it("item.dueAt (RFC 3339) equals buffer.dueAt via toDateInputValue", () => {
      const item = { ...taskItem, dueAt: "2026-07-20T00:00:00.000+00:00" };
      const buffer = { ...matchingBuffer, dueAt: toDateInputValue(item.dueAt) };
      expect(buffer.dueAt).toBe("2026-07-20");
      expect(bufferEqualsItem(buffer, item)).toBe(true);
    });

    it("buffer dueAt '' equals item.dueAt null", () => {
      const item = { ...taskItem, dueAt: null };
      expect(bufferEqualsItem({ ...matchingBuffer, dueAt: "" }, item)).toBe(true);
    });
  });

  describe("projectId (compared regardless of kind)", () => {
    const item = makeItem({ kind: "note", status: null, priority: null, dueAt: null, projectId: null });
    const buffer = makeBuffer({ status: null, priority: null, dueAt: "", projectId: "" });

    it("buffer projectId '' equals item.projectId null", () => {
      expect(bufferEqualsItem(buffer, item)).toBe(true);
    });

    it("differing projectId -> false", () => {
      const other = { ...item, projectId: OTHER_PROJECT_ID };
      expect(bufferEqualsItem({ ...buffer, projectId: PROJECT_ID }, other)).toBe(false);
    });
  });
});

// --- classifyRestore (item surface) --------------------------------------

describe("classifyRestore", () => {
  it('"skip" when the owning project is not loaded, even if the item is present', () => {
    const item = makeItem();
    const draft = makeItemDraft({ projectId: PROJECT_ID, entityId: item.id });
    expect(classifyRestore(draft, item, false)).toBe("skip");
  });

  it('a project-less draft (projectId "") proceeds by content even when projectLoaded is false; never-saved -> "restore"', () => {
    const draft = makeItemDraft({ projectId: "", entityId: "", baseUpdatedAt: "" });
    expect(classifyRestore(draft, null, false)).toBe("restore");
  });

  it('a never-saved draft (entityId "") always restores, regardless of item', () => {
    const draft = makeItemDraft({ entityId: "", baseUpdatedAt: "", projectId: PROJECT_ID });
    expect(classifyRestore(draft, null, true)).toBe("restore");
  });

  it('"orphan" when the entity is gone (item null) but the draft names one', () => {
    const draft = makeItemDraft({ entityId: ITEM_ID, projectId: PROJECT_ID });
    expect(classifyRestore(draft, null, true)).toBe("orphan");
  });

  it('"orphan" when the item is found in a DIFFERENT project than the draft (never bind across projects)', () => {
    const item = makeItem({ id: ITEM_ID, projectId: OTHER_PROJECT_ID });
    const draft = makeItemDraft({ entityId: ITEM_ID, projectId: PROJECT_ID });
    expect(classifyRestore(draft, item, true)).toBe("orphan");
  });

  it('"clean" when the draft content equals the item (dueAt compared via the input-string form)', () => {
    const item = makeItem({
      kind: "task",
      title: "Same title",
      body: "Same body",
      status: "doing",
      priority: "high",
      dueAt: "2026-07-20T00:00:00Z",
      tags: ["x", "y"],
      jiraUrl: "https://example/JIRA-1",
      projectId: PROJECT_ID,
      updatedAt: "2026-01-05T00:00:00Z",
    });
    const draft = makeItemDraft({
      entityId: item.id,
      projectId: PROJECT_ID,
      kind: item.kind,
      baseUpdatedAt: item.updatedAt,
      title: item.title,
      body: item.body,
      status: item.status,
      priority: item.priority,
      dueAt: toDateInputValue(item.dueAt),
      tags: [...item.tags],
      jiraUrl: item.jiraUrl ?? "",
    });

    expect(classifyRestore(draft, item, true)).toBe("clean");
  });

  it('"restore" when content differs but baseUpdatedAt still matches the item (safe to auto-restore)', () => {
    const item = makeItem({ updatedAt: "2026-01-05T00:00:00Z" });
    const draft = makeItemDraft({
      entityId: item.id,
      projectId: item.projectId ?? "",
      kind: item.kind,
      baseUpdatedAt: item.updatedAt,
      title: "Edited title, unsaved",
    });
    expect(classifyRestore(draft, item, true)).toBe("restore");
  });

  it('"conflict" when content differs AND baseUpdatedAt no longer matches the item (never auto-restore over changed content)', () => {
    const item = makeItem({ updatedAt: "2026-01-05T00:00:00Z" });
    const draft = makeItemDraft({
      entityId: item.id,
      projectId: item.projectId ?? "",
      kind: item.kind,
      baseUpdatedAt: "2020-01-01T00:00:00Z",
      title: "Edited title, unsaved",
    });
    expect(classifyRestore(draft, item, true)).toBe("conflict");
  });

  it('precedence: "skip" wins over "orphan" — an unloaded project with a gone item still skips', () => {
    const draft = makeItemDraft({ entityId: ITEM_ID, projectId: PROJECT_ID });
    expect(classifyRestore(draft, null, false)).toBe("skip");
  });

  // Post-review F13 (found by the manual smoke, step 8): a hand-edit in
  // Notepad changes the file's content but NOT its updated_at frontmatter, so
  // the timestamp check alone is blind to it. The draft's baseHash (a
  // fingerprint of the base title+body the buffer was seeded from) closes it.
  it('"conflict" when the item content changed but updatedAt did NOT (hand-edited file)', () => {
    const item = makeItem({ body: "Edited in Notepad" }); // updatedAt unchanged
    const draft = makeItemDraft({
      entityId: item.id,
      projectId: item.projectId ?? "",
      kind: item.kind,
      baseUpdatedAt: item.updatedAt, // matches — the old blind spot
      baseHash: contentHash("Original title\nOriginal body"), // the base the buffer saw
      title: "My unsaved edit",
    });
    expect(classifyRestore(draft, item, true)).toBe("conflict");
  });

  it('"restore" when both updatedAt and the content fingerprint still match the item', () => {
    const item = makeItem(); // title "Original title", body "Original body"
    const draft = makeItemDraft({
      entityId: item.id,
      projectId: item.projectId ?? "",
      kind: item.kind,
      baseUpdatedAt: item.updatedAt,
      baseHash: contentHash("Original title\nOriginal body"),
      title: "My unsaved edit",
    });
    expect(classifyRestore(draft, item, true)).toBe("restore");
  });

  it('a record with baseHash "" skips the fingerprint check (restore on matching updatedAt)', () => {
    // Older records predate the fingerprint; drafts are not a compatibility
    // surface, but a missing hash must degrade to the timestamp-only rule
    // rather than misclassify.
    const item = makeItem({ body: "Edited in Notepad" });
    const draft = makeItemDraft({
      entityId: item.id,
      projectId: item.projectId ?? "",
      kind: item.kind,
      baseUpdatedAt: item.updatedAt,
      baseHash: "",
      title: "My unsaved edit",
    });
    expect(classifyRestore(draft, item, true)).toBe("restore");
  });
});

// --- classifyPromptRestore ------------------------------------------------

describe("classifyPromptRestore", () => {
  it('"skip" when the owning project is not loaded, even if the prompt is present', () => {
    const prompt = makePromptFixture();
    const draft = makePromptDraft({ projectId: PROJECT_ID, entityId: prompt.id });
    expect(classifyPromptRestore(draft, prompt, false)).toBe("skip");
  });

  it('a never-saved prompt draft (entityId "") always restores', () => {
    const draft = makePromptDraft({ entityId: "", baseUpdatedAt: "", projectId: PROJECT_ID });
    expect(classifyPromptRestore(draft, null, true)).toBe("restore");
  });

  it('"orphan" when the prompt is gone (null) but the draft names one', () => {
    const draft = makePromptDraft({ entityId: PROMPT_ID, projectId: PROJECT_ID });
    expect(classifyPromptRestore(draft, null, true)).toBe("orphan");
  });

  it('"clean" when title+body match the prompt', () => {
    const prompt = makePromptFixture({ title: "Same", body: "Same body", updatedAt: "2026-01-05T00:00:00Z" });
    const draft = makePromptDraft({
      entityId: prompt.id,
      projectId: prompt.projectId ?? "",
      baseUpdatedAt: prompt.updatedAt,
      title: prompt.title,
      body: prompt.body,
    });
    expect(classifyPromptRestore(draft, prompt, true)).toBe("clean");
  });

  it('"restore" when content differs but baseUpdatedAt still matches the prompt', () => {
    const prompt = makePromptFixture({ updatedAt: "2026-01-05T00:00:00Z" });
    const draft = makePromptDraft({
      entityId: prompt.id,
      projectId: prompt.projectId ?? "",
      baseUpdatedAt: prompt.updatedAt,
      title: "Edited, unsaved",
    });
    expect(classifyPromptRestore(draft, prompt, true)).toBe("restore");
  });

  it('"conflict" when content differs and baseUpdatedAt is stale', () => {
    const prompt = makePromptFixture({ updatedAt: "2026-01-05T00:00:00Z" });
    const draft = makePromptDraft({
      entityId: prompt.id,
      projectId: prompt.projectId ?? "",
      baseUpdatedAt: "2020-01-01T00:00:00Z",
      title: "Edited, unsaved",
    });
    expect(classifyPromptRestore(draft, prompt, true)).toBe("conflict");
  });

  it('"orphan" when the prompt is found in a DIFFERENT project than the draft', () => {
    const prompt = makePromptFixture({ projectId: OTHER_PROJECT_ID });
    const draft = makePromptDraft({ entityId: prompt.id, projectId: PROJECT_ID });
    expect(classifyPromptRestore(draft, prompt, true)).toBe("orphan");
  });

  it('"conflict" when the prompt content changed but updatedAt did NOT (hand-edited file — F13)', () => {
    const prompt = makePromptFixture({ body: "Edited in Notepad" }); // updatedAt unchanged
    const draft = makePromptDraft({
      entityId: prompt.id,
      projectId: prompt.projectId ?? "",
      baseUpdatedAt: prompt.updatedAt,
      baseHash: contentHash("Prompt title\nPrompt body"), // the base the buffer saw
      title: "My unsaved edit",
    });
    expect(classifyPromptRestore(draft, prompt, true)).toBe("conflict");
  });
});

// --- classifyScratchRestore -------------------------------------------------

describe("classifyScratchRestore", () => {
  it('"skip" when currentBody is null (pad unreadable), even if the project is loaded', () => {
    const draft = makeScratchDraft({ body: "draft content", baseHash: contentHash("draft content") });
    expect(classifyScratchRestore(draft, null, true)).toBe("skip");
  });

  it('"clean" when the draft body equals the current pad content', () => {
    const draft = makeScratchDraft({ body: "same content" });
    expect(classifyScratchRestore(draft, "same content", true)).toBe("clean");
  });

  it('"restore" when body differs but baseHash matches the current content (nothing changed underneath)', () => {
    const draft = makeScratchDraft({ body: "edited, unsaved", baseHash: contentHash("original content") });
    expect(classifyScratchRestore(draft, "original content", true)).toBe("restore");
  });

  it('"conflict" when body differs and baseHash no longer matches the current content', () => {
    const draft = makeScratchDraft({ body: "edited, unsaved", baseHash: contentHash("original content") });
    expect(classifyScratchRestore(draft, "changed elsewhere", true)).toBe("conflict");
  });

  it('"skip" when the owning project is not loaded', () => {
    const draft = makeScratchDraft({ body: "same content" });
    expect(classifyScratchRestore(draft, "same content", false)).toBe("skip");
  });
});

// --- contentHash ----------------------------------------------------------

describe("contentHash", () => {
  it("is deterministic for the same input", () => {
    expect(contentHash("hello world")).toBe(contentHash("hello world"));
  });

  it("differs between empty and non-empty content", () => {
    expect(contentHash("")).not.toBe(contentHash("a"));
  });

  it("is order-sensitive", () => {
    expect(contentHash("ab")).not.toBe(contentHash("ba"));
  });

  it("differs for strings of different lengths sharing a prefix", () => {
    expect(contentHash("ab")).not.toBe(contentHash("abc"));
  });

  it("hashes multibyte content without throwing", () => {
    expect(() => contentHash("héllo 世界 🎉")).not.toThrow();
    expect(typeof contentHash("héllo 世界 🎉")).toBe("string");
  });
});

// --- sanitizeDraft ---------------------------------------------------------

const VALID_RAW = {
  v: 1,
  draftId: "550e8400-e29b-41d4-a716-446655440000",
  surface: "item",
  projectId: "660e8400-e29b-41d4-a716-446655440000",
  entityId: "770e8400-e29b-41d4-a716-446655440000",
  kind: "task",
  baseUpdatedAt: "2026-01-02T00:00:00Z",
  baseHash: "",
  savedAt: "2026-01-02T00:05:00Z",
  title: "Some title",
  status: "doing",
  priority: "high",
  dueAt: "2026-07-20",
  tags: ["alpha", "beta"],
  jiraUrl: "https://example.atlassian.net/browse/JIRA-1",
  body: "Some body",
};

describe("sanitizeDraft", () => {
  it("round-trips a fully valid record unchanged", () => {
    expect(sanitizeDraft(VALID_RAW)).toEqual(VALID_RAW);
  });

  it.each([null, 42, [], ""])("discards a non-record top-level value: %j", (bad) => {
    expect(sanitizeDraft(bad)).toBeNull();
  });

  it.each([0, 2, "1"])("discards an unknown version: %j", (v) => {
    expect(sanitizeDraft({ ...VALID_RAW, v })).toBeNull();
  });

  it("discards a record with a missing version", () => {
    const { v: _drop, ...rest } = VALID_RAW;
    expect(sanitizeDraft(rest)).toBeNull();
  });

  it.each([42, "not-a-uuid", `draft-${VALID_RAW.draftId}`])("discards a bad draftId: %j", (draftId) => {
    expect(sanitizeDraft({ ...VALID_RAW, draftId })).toBeNull();
  });

  it("discards a record with a missing draftId", () => {
    const { draftId: _drop, ...rest } = VALID_RAW;
    expect(sanitizeDraft(rest)).toBeNull();
  });

  it.each(["banana", 42])("discards an unknown surface: %j", (surface) => {
    expect(sanitizeDraft({ ...VALID_RAW, surface })).toBeNull();
  });

  it("discards a record with a missing surface", () => {
    const { surface: _drop, ...rest } = VALID_RAW;
    expect(sanitizeDraft(rest)).toBeNull();
  });

  it.each(["title", "body"] as const)(
    '"%s" is the irreplaceable part: a non-string value discards the WHOLE record (never defaulted)',
    (field) => {
      expect(sanitizeDraft({ ...VALID_RAW, [field]: 42 })).toBeNull();
    },
  );

  it("falls back kind to null (keeping the record) for an unknown kind value", () => {
    const result = sanitizeDraft({ ...VALID_RAW, kind: "banana" });
    expect(result).not.toBeNull();
    expect(result?.kind).toBeNull();
    expect(result?.title).toBe(VALID_RAW.title);
  });

  it("falls back status/priority to null (keeping the record) for unknown values", () => {
    const result = sanitizeDraft({ ...VALID_RAW, status: "banana", priority: "extreme" });
    expect(result).not.toBeNull();
    expect(result?.status).toBeNull();
    expect(result?.priority).toBeNull();
  });

  it.each(["projectId", "entityId", "baseUpdatedAt", "baseHash", "savedAt", "dueAt", "jiraUrl"] as const)(
    'defaults "%s" to "" (keeping the record) when it is not a string',
    (field) => {
      const result = sanitizeDraft({ ...VALID_RAW, [field]: 42 });
      expect(result).not.toBeNull();
      expect((result as unknown as Record<string, unknown>)[field]).toBe("");
    },
  );

  it("defaults tags to [] for a non-array value", () => {
    const result = sanitizeDraft({ ...VALID_RAW, tags: "not-an-array" });
    expect(result?.tags).toEqual([]);
  });

  it("drops non-string tag entries", () => {
    const result = sanitizeDraft({ ...VALID_RAW, tags: ["a", 42, null, "b", { weird: true }] });
    expect(result?.tags).toEqual(["a", "b"]);
  });

  it("dedupes duplicate tags", () => {
    const result = sanitizeDraft({ ...VALID_RAW, tags: ["a", "b", "a"] });
    expect(result?.tags).toEqual(["a", "b"]);
  });
});

// --- DraftQueue ------------------------------------------------------------

describe("DraftQueue", () => {
  it("runs enqueued ops strictly in FIFO order even though a later op could settle first (a snapshot must never land after a delete)", async () => {
    const calls: string[] = [];
    const saveGate = deferred<void>();
    const saveOp = vi.fn(async (_draft: Draft) => {
      calls.push("save-start");
      await saveGate.promise;
      calls.push("save-end");
    });
    const deleteOp = vi.fn(async (_id: string) => {
      calls.push("delete");
    });
    const queue = new DraftQueue(saveOp, deleteOp);

    const savePromise = queue.save(makeItemDraft());
    const deletePromise = queue.delete(ITEM_ID);

    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["save-start"]); // delete must not have run yet
    expect(deleteOp).not.toHaveBeenCalled();

    saveGate.resolve();
    await expect(savePromise).resolves.toBe(true);
    await expect(deletePromise).resolves.toBe(true);
    expect(calls).toEqual(["save-start", "save-end", "delete"]);
  });

  it("resolves true when the underlying save op succeeds", async () => {
    const queue = new DraftQueue(
      async () => {},
      async () => {},
    );
    await expect(queue.save(makeItemDraft())).resolves.toBe(true);
  });

  it("resolves false when the underlying save op rejects, without throwing", async () => {
    const queue = new DraftQueue(
      async () => {
        throw new Error("boom");
      },
      async () => {},
    );
    await expect(queue.save(makeItemDraft())).resolves.toBe(false);
  });

  it("a rejecting save does not break the chain: a subsequent delete still runs", async () => {
    const deleteOp = vi.fn(async (_id: string) => {});
    const queue = new DraftQueue(async () => {
      throw new Error("boom");
    }, deleteOp);

    const savePromise = queue.save(makeItemDraft());
    const deletePromise = queue.delete(ITEM_ID);

    await expect(savePromise).resolves.toBe(false);
    await expect(deletePromise).resolves.toBe(true);
    expect(deleteOp).toHaveBeenCalledTimes(1);
  });

  describe("close()", () => {
    it("skips a save enqueued before close but not yet started: op never called, resolves false", async () => {
      const blocking = deferred<void>();
      const saveOp = vi.fn((_draft: Draft) => blocking.promise);
      const deleteOp = vi.fn(async (_id: string) => {});
      const queue = new DraftQueue(saveOp, deleteOp);

      const save1 = queue.save(makeItemDraft({ draftId: "save-1" }));
      await Promise.resolve(); // let save1 actually start before we close
      expect(saveOp).toHaveBeenCalledTimes(1);

      const save2 = queue.save(makeItemDraft({ draftId: "save-2" })); // queued behind save1
      queue.close();

      blocking.resolve();
      await expect(save1).resolves.toBe(true);
      await expect(save2).resolves.toBe(false);
      expect(saveOp).toHaveBeenCalledTimes(1); // save2's op never invoked
    });

    it("still runs a delete enqueued after close", async () => {
      const deleteOp = vi.fn(async (_id: string) => {});
      const queue = new DraftQueue(async () => {}, deleteOp);

      queue.close();
      await expect(queue.delete(ITEM_ID)).resolves.toBe(true);
      expect(deleteOp).toHaveBeenCalledWith(ITEM_ID);
    });

    it("is idempotent", () => {
      const queue = new DraftQueue(
        async () => {},
        async () => {},
      );
      expect(() => {
        queue.close();
        queue.close();
      }).not.toThrow();
    });
  });

  it("settle() resolves only after everything enqueued so far has settled", async () => {
    const blocking = deferred<void>();
    const saveOp = vi.fn((_draft: Draft) => blocking.promise);
    const deleteOp = vi.fn(async (_id: string) => {});
    const queue = new DraftQueue(saveOp, deleteOp);

    void queue.save(makeItemDraft());
    void queue.delete(ITEM_ID);

    let settled = false;
    const settlePromise = queue.settle().then(() => {
      settled = true;
    });

    expect(settled).toBe(false); // still blocked on the pending save op

    blocking.resolve();
    await settlePromise;
    expect(settled).toBe(true);
  });
});

// --- Flush registry (registerFlushable / unregisterFlushable / flushAllDrafts) --

describe("registerFlushable / unregisterFlushable / flushAllDrafts", () => {
  // Module-level registry: always leave it as we found it so other tests in
  // this file (and other files sharing the module) never see leftover state.
  afterEach(() => {
    unregisterFlushable("test-flush-a");
    unregisterFlushable("test-flush-b");
  });

  it("flushAllDrafts calls every registered flushable and resolves even if one rejects", async () => {
    const flushA = vi.fn(async () => {});
    const flushB = vi.fn(async () => {
      throw new Error("boom");
    });
    registerFlushable("test-flush-a", flushA);
    registerFlushable("test-flush-b", flushB);

    await expect(flushAllDrafts()).resolves.toBeUndefined();
    expect(flushA).toHaveBeenCalledTimes(1);
    expect(flushB).toHaveBeenCalledTimes(1);
  });

  it("unregisterFlushable removes a key so it is not called on the next flush", async () => {
    const flushA = vi.fn(async () => {});
    const flushB = vi.fn(async () => {});
    registerFlushable("test-flush-a", flushA);
    registerFlushable("test-flush-b", flushB);
    unregisterFlushable("test-flush-a");

    await flushAllDrafts();
    expect(flushA).not.toHaveBeenCalled();
    expect(flushB).toHaveBeenCalledTimes(1);
  });

  it("registering the same key twice replaces the flushable (only the latest runs)", async () => {
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    registerFlushable("test-flush-a", first);
    registerFlushable("test-flush-a", second);

    await flushAllDrafts();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
