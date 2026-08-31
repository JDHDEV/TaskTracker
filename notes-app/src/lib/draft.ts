import type { Item, Kind } from "../types";

// A draft is a genuine local-only Item held in App state until its first Save
// (D1). Its id is the empty-string sentinel `""`; title/body are empty, so Save
// stays blocked until a title is typed (matching the backend "title must not be
// empty" invariant). Timestamps are placeholders — a draft never appears in the
// rail list, only in the editor, so they are never rendered.

const EMPTY_TIMESTAMP = "";

/** A blank draft of the given kind, targeting `projectId` (the project it will
 *  be created into — "" when the rail filter is "All projects", so the editor
 *  must ask for a target before Save). Tasks start todo/normal; notes neither.
 *  `body` seeds the body only (Plan 13 "send selection to…": the title stays
 *  empty so R4 generates one on Save). */
export function newDraft(kind: Kind, projectId: string = "", body: string = ""): Item {
  return {
    id: "",
    kind,
    title: "",
    body,
    status: kind === "task" ? "todo" : null,
    priority: kind === "task" ? "normal" : null,
    dueAt: null,
    tags: [],
    createdAt: EMPTY_TIMESTAMP,
    updatedAt: EMPTY_TIMESTAMP,
    archived: false,
    pinned: false,
    projectId: projectId || null,
    jiraUrl: null,
    // Placeholder: the backend mints the real marker on Save (it is not sent).
    schemaVersion: "",
  };
}

/**
 * A draft that carries over kind, status, priority, project, and tags from
 * `source` — but with empty title/body, no JIRA link (it identifies one
 * specific ticket), and unpinned (DESIGN.md:65). Tags are copied into a fresh
 * array so the draft never shares a reference with the source item.
 */
export function duplicateDraft(source: Item): Item {
  return {
    id: "",
    kind: source.kind,
    title: "",
    body: "",
    status: source.status,
    priority: source.priority,
    dueAt: null,
    tags: [...source.tags],
    createdAt: EMPTY_TIMESTAMP,
    updatedAt: EMPTY_TIMESTAMP,
    archived: false,
    pinned: false,
    projectId: source.projectId,
    jiraUrl: null,
    // A duplicate is a fresh record; the backend stamps the current marker on
    // create. Never carry the source's — a placeholder until Save.
    schemaVersion: "",
  };
}
