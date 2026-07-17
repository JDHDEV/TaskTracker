// Mirrors src-tauri/src/models.rs. If you change one, change the other.

export type Kind = "note" | "task";
export type Status = "todo" | "doing" | "done";
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
}

export interface Project {
  id: string;
  name: string;
  createdAt: string; // RFC 3339
}

export interface ProjectWithCount extends Project {
  itemCount: number;
}

export interface NewItem {
  kind: Kind;
  title: string;
  body?: string;
  status?: Status;
  priority?: Priority;
  dueAt?: string;
  tags?: string[];
  projectId?: string;
  jiraUrl?: string;
}

/** Omitted fields are left unchanged. Send dueAt/jiraUrl: "" to clear them. */
export interface UpdateItem {
  title?: string;
  body?: string;
  status?: Status;
  priority?: Priority;
  dueAt?: string;
  tags?: string[];
  projectId?: string;
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
