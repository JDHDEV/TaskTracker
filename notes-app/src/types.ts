// Mirrors src-tauri/src/models.rs. If you change one, change the other.

export type Kind = "note" | "task";
export type Status = "todo" | "doing" | "done";
export type Priority = "low" | "normal" | "high";

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
}

export interface NewItem {
  kind: Kind;
  title: string;
  body?: string;
  status?: Status;
  priority?: Priority;
  dueAt?: string;
  tags?: string[];
}

/** Omitted fields are left unchanged. Send dueAt: "" to clear a due date. */
export interface UpdateItem {
  title?: string;
  body?: string;
  status?: Status;
  priority?: Priority;
  dueAt?: string;
  tags?: string[];
  archived?: boolean;
  pinned?: boolean;
}

export interface ListFilter {
  kind?: Kind;
  archived?: boolean;
}

export type ProviderId = "anthropic" | "openai";

export interface RewriteRequest {
  provider: ProviderId;
  text: string;
  instruction: string;
}
