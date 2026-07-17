import { Channel, invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isHttpUrl } from "./jira";
import type {
  Item,
  ListFilter,
  NewItem,
  Project,
  ProjectWithCount,
  ProviderId,
  RewriteEvent,
  RewriteRequest,
  RewriteStreamRequest,
  UpdateItem,
} from "../types";

// Every backend capability, in one file. Components import these functions
// and never call invoke() directly, so the IPC surface stays greppable.

export function listItems(filter?: ListFilter): Promise<Item[]> {
  return invoke("list_items", { filter });
}

export function getItem(id: string): Promise<Item> {
  return invoke("get_item", { id });
}

export function createItem(input: NewItem): Promise<Item> {
  return invoke("create_item", { input });
}

export function updateItem(id: string, patch: UpdateItem): Promise<Item> {
  return invoke("update_item", { id, patch });
}

export function deleteItem(id: string): Promise<void> {
  return invoke("delete_item", { id });
}

export function searchItems(query: string, filter?: ListFilter): Promise<Item[]> {
  return invoke("search_items", { query, filter });
}

export function listProjects(): Promise<ProjectWithCount[]> {
  return invoke("list_projects");
}

export function createProject(name: string): Promise<Project> {
  return invoke("create_project", { name });
}

export function renameProject(id: string, name: string): Promise<Project> {
  return invoke("rename_project", { id, name });
}

export function deleteProject(id: string): Promise<void> {
  return invoke("delete_project", { id });
}

export function listActiveTags(): Promise<string[]> {
  return invoke("list_active_tags");
}

export function aiRewrite(req: RewriteRequest): Promise<string> {
  return invoke("ai_rewrite", { req });
}

/**
 * Streaming rewrite. The Tauri `Channel` is constructed and consumed here so
 * components only ever see an `onChunk` callback and a `{ result, cancel }`
 * handle (CC4 — no component touches Channel/invoke directly).
 *
 * `onChunk` fires per text delta. `result` resolves with the full rewrite on
 * the terminal `done` event, and rejects on a terminal `error` (including a
 * cancellation) OR on a preflight rejection of the invoke promise (empty text,
 * unknown provider, missing key) — which arrives before any channel event.
 * `cancel` requests cooperative backend cancellation.
 */
export function aiRewriteStream(
  req: RewriteStreamRequest,
  onChunk: (delta: string) => void,
): { result: Promise<string>; cancel: () => void } {
  const channel = new Channel<RewriteEvent>();
  // Reject with the bare message (not an Error), matching every other error
  // path in the app — callers do `String(err)`, and an Error would add an
  // "Error: " prefix that no other toast has (AppError serializes to a string).
  let settle!: { resolve: (text: string) => void; reject: (err: unknown) => void };
  const result = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });

  channel.onmessage = (event) => {
    switch (event.type) {
      case "chunk":
        onChunk(event.delta);
        break;
      case "done":
        settle.resolve(event.text);
        break;
      case "error":
        settle.reject(event.message);
        break;
    }
  };

  invoke<void>("ai_rewrite_stream", { req, onEvent: channel }).catch((err) => {
    // Preflight rejection: no channel event will arrive, so settle here with
    // the raw invoke rejection (a bare AppError string).
    settle.reject(err);
  });

  return {
    result,
    cancel: () => {
      void invoke("ai_rewrite_cancel", { requestId: req.requestId }).catch(
        () => {},
      );
    },
  };
}

export function setApiKey(provider: ProviderId, key: string): Promise<void> {
  return invoke("set_api_key", { provider, key });
}

export function hasApiKey(provider: ProviderId): Promise<boolean> {
  return invoke("has_api_key", { provider });
}

// The one sanctioned non-invoke IPC touchpoint: the opener plugin invokes
// internally, so routing it through api.ts keeps the OS surface greppable.
// Open-time defense-in-depth (plan §4): parse the URL and require http(s) with
// a non-empty host before handing it to the OS — the host check closes the
// `https:///` gap the Rust write-path validator misses. Never opens otherwise.
export async function openExternal(url: string): Promise<void> {
  if (!isHttpUrl(url)) {
    throw new Error("Refusing to open a non-http(s) URL.");
  }
  await openUrl(url);
}
