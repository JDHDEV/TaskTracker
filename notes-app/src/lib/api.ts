import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isHttpUrl } from "./jira";
import type {
  Item,
  ListFilter,
  NewItem,
  Project,
  ProjectWithCount,
  ProviderId,
  RewriteRequest,
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
