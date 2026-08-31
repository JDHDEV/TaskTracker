// Mirrors src-tauri/src/models.rs. If you change one, change the other.

export type Kind = "note" | "task";
export type Status = "todo" | "doing" | "testing" | "done";
export type Priority = "low" | "normal" | "high";
export type Sort = "updated" | "created" | "priority" | "status";

export interface Item {
  id: string;
  kind: Kind;
  title: string;
  body: string;
  status: Status | null;
  priority: Priority | null;
  dueAt: string | null; // RFC 3339
  tags: string[];
  createdAt: string; // RFC 3339
  updatedAt: string; // RFC 3339 — bumped by content edits only, not pin/archive
  archived: boolean;
  pinned: boolean;
  projectId: string | null;
  jiraUrl: string | null;
  /** Backend-owned record-format marker ("1.0.0"). Read-only passthrough — not
   *  on NewItem/UpdateItem; a client can never set it. */
  schemaVersion: string;
}

/** A known project: catalog identity + whether it is loaded, plus live item and
 *  prompt counts for loaded projects only (undefined when unloaded). */
export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  loaded: boolean;
  itemCount?: number;
  promptCount?: number;
}

export interface NewItem {
  kind: Kind;
  title: string;
  body?: string;
  status?: Status;
  priority?: Priority;
  dueAt?: string;
  tags?: string[];
  /** Required: the project this item is created into (the routing target). */
  projectId: string;
  jiraUrl?: string;
}

/** Omitted fields are left unchanged. Send dueAt/jiraUrl: "" to clear them.
 *  No projectId: items do not move between projects in v1. */
export interface UpdateItem {
  title?: string;
  body?: string;
  status?: Status;
  priority?: Priority;
  dueAt?: string;
  tags?: string[];
  jiraUrl?: string;
  archived?: boolean;
  pinned?: boolean;
}

export interface ListFilter {
  kind?: Kind;
  archived?: boolean;
  projectId?: string;
  status?: Status;
  tags?: string[];
  sort?: Sort;
}

// --- Prompts (plan.7): a per-project, versioned prompt library. Mirrors
// src-tauri/src/models.rs. A prompt's title/body are its CURRENT version's;
// updatedAt is the current version's createdAt (derived); every content edit is
// captured as an immutable version, so the original is never lost. ---

export type PromptSource = "manual" | "aiEnhanced";

export interface Prompt {
  id: string;
  title: string;
  body: string;
  reusable: boolean;
  /** Backend-owned record-format marker ("1.0.0") on the prompt head. Read-only
   *  passthrough — not on NewPrompt/UpdatePrompt. */
  schemaVersion: string;
  createdAt: string; // RFC 3339
  updatedAt: string; // RFC 3339 — the current version's createdAt (derived)
  versionCount: number;
  projectId: string | null; // stamped by the manager on return
}

export interface PromptVersion {
  id: string;
  promptId: string;
  title: string;
  body: string;
  source: PromptSource;
  createdAt: string; // RFC 3339
}

export interface NewPrompt {
  /** Required: the project this prompt is created into (the routing target). */
  projectId: string;
  title: string;
  body?: string;
  reusable?: boolean;
  /** Provenance of the first version. Defaults to "manual"; sent as
   *  "aiEnhanced" when a new draft's first persisted content is an accepted AI
   *  enhance proposal, so history labels it correctly. */
  source?: PromptSource;
}

/** Omitted fields are left unchanged. A title/body change appends a version;
 *  a reusable-only change appends none and does not move updatedAt. `source`
 *  defaults to "manual"; the accept-proposal path sends "aiEnhanced". */
export interface UpdatePrompt {
  title?: string;
  body?: string;
  reusable?: boolean;
  source?: PromptSource;
}

/** projectId selects one store. Omit it for the "All projects" scope: the
 *  manager fans REUSABLE prompts out across all loaded stores, stamping each
 *  row's owning project (a projectId-less non-reusable list is rejected).
 *  reusableOnly is the only prompt filter in v1. */
export interface PromptListFilter {
  projectId?: string;
  reusableOnly?: boolean;
}

export type ProviderId = "anthropic" | "openai";

export interface RewriteRequest {
  provider: ProviderId;
  text: string;
  instruction: string;
}

export interface RewriteStreamRequest {
  requestId: string;
  provider: ProviderId;
  text: string;
  instruction: string;
}

export interface GenerateTitleRequest {
  provider: ProviderId;
  text: string;
}

// --- JIRA enrichment (mirrors src-tauri/src/models.rs) ---

/** Atlassian's coarse status bucket — stable across workflows, so the UI maps
 *  it (not the free-text status name) to the status-dot colors. */
export type StatusCategory = "new" | "indeterminate" | "done";

export interface TicketMeta {
  key: string;
  title: string;
  status: string;
  statusCategory: StatusCategory;
  fetchedAt: string; // RFC 3339
}

/** Non-secret JIRA connection. The API token is NOT here — it lives in the
 *  keyring and is never returned to the frontend. */
export interface JiraConfig {
  baseUrl: string;
  email: string;
}

export type RewriteErrorCode = "cancelled" | "network" | "provider" | "invalid";

/** Tagged union mirroring src-tauri/src/ai/mod.rs RewriteEvent. Chunks precede
 *  exactly one terminal Done or Error. */
export type RewriteEvent =
  | { type: "chunk"; delta: string }
  | { type: "done"; text: string }
  | { type: "error"; code: RewriteErrorCode; message: string };
