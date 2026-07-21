import { describe, it, expect } from "vitest";
import { newDraft, duplicateDraft } from "./draft";
import type { Item } from "../types";

describe("newDraft", () => {
  it("builds a blank task draft with todo/normal defaults", () => {
    const draft = newDraft("task");
    expect(draft.kind).toBe("task");
    expect(draft.status).toBe("todo");
    expect(draft.priority).toBe("normal");
    expect(draft.title).toBe("");
    expect(draft.body).toBe("");
    expect(draft.id).toBe("");
    expect(draft.pinned).toBe(false);
    expect(draft.tags).toEqual([]);
  });

  it("builds a blank note draft with no status/priority", () => {
    const draft = newDraft("note");
    expect(draft.kind).toBe("note");
    expect(draft.status).toBeNull();
    expect(draft.priority).toBeNull();
  });
});

describe("duplicateDraft", () => {
  const source: Item = {
    id: "item-1",
    kind: "task",
    title: "Original title",
    body: "Original body",
    status: "doing",
    priority: "high",
    dueAt: "2026-07-20T00:00:00Z",
    tags: ["platform", "urgent"],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    archived: false,
    pinned: true,
    projectId: "proj-1",
    jiraUrl: "https://acme.atlassian.net/browse/PLAT-142",
    schemaVersion: "1.0.0",
  };

  it("carries over kind, status, priority, projectId, and tags", () => {
    const draft = duplicateDraft(source);
    expect(draft.kind).toBe(source.kind);
    expect(draft.status).toBe(source.status);
    expect(draft.priority).toBe(source.priority);
    expect(draft.projectId).toBe(source.projectId);
    expect(draft.tags).toEqual(source.tags);
  });

  it("empties title/body, clears jiraUrl, unpins, and resets id", () => {
    const draft = duplicateDraft(source);
    expect(draft.title).toBe("");
    expect(draft.body).toBe("");
    expect(draft.jiraUrl).toBeNull();
    expect(draft.pinned).toBe(false);
    expect(draft.id).toBe("");
  });

  it("copies tags into a fresh array not shared with the source", () => {
    const draft = duplicateDraft(source);
    expect(draft.tags).not.toBe(source.tags);

    source.tags.push("mutated");
    expect(draft.tags).toEqual(["platform", "urgent"]);
  });
});
