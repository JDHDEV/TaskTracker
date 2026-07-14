import { invoke } from "@tauri-apps/api/core";
import type {
  Item,
  ListFilter,
  NewItem,
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

export function searchItems(query: string): Promise<Item[]> {
  return invoke("search_items", { query });
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
