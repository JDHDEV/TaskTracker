import { Channel, invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ask } from "@tauri-apps/plugin-dialog";
import { isHttpUrl } from "./jira";
import type {
  GenerateTitleRequest,
  Item,
  JiraConfig,
  ListFilter,
  NewItem,
  NewPrompt,
  ProjectInfo,
  Prompt,
  PromptListFilter,
  PromptVersion,
  ProviderId,
  RewriteEvent,
  RewriteRequest,
  RewriteStreamRequest,
  TicketMeta,
  UpdateItem,
  UpdatePrompt,
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

// --- Projects as loadable on-disk stores. A project is a directory the user
// chooses; the backend validates every path server-side. list_projects returns
// the catalog (known projects) with a `loaded` flag and an itemCount for loaded
// ones. ---

export function listProjects(): Promise<ProjectInfo[]> {
  return invoke("list_projects");
}

/** Create a new project at `dir` (validated Rust-side) and load it. */
export function createProject(dir: string, name: string): Promise<ProjectInfo> {
  return invoke("create_project", { dir, name });
}

/** Open (and load) an existing project from `dir`. */
export function openProject(dir: string): Promise<ProjectInfo> {
  return invoke("open_project", { dir });
}

export function loadProject(id: string): Promise<ProjectInfo> {
  return invoke("load_project", { id });
}

export function unloadProject(id: string): Promise<void> {
  return invoke("unload_project", { id });
}

/**
 * Reload a project from its on-disk `items/*.md` files (Stage 2 — after a
 * `git pull`/sync changed them). Resolves to per-file import warnings: a line
 * per file that couldn't be imported (e.g. unresolved git conflict markers),
 * empty when everything imported cleanly.
 */
export function reloadProject(id: string): Promise<string[]> {
  return invoke("reload_project", { id });
}

/** Remove a project from the catalog; its files are left on disk. */
export function forgetProject(id: string): Promise<void> {
  return invoke("forget_project", { id });
}

/** Destructively delete a project's files, then its catalog row. */
export function deleteProjectFiles(id: string): Promise<void> {
  return invoke("delete_project_files", { id });
}

/** Show the native folder picker; resolves to the chosen path or null. */
export function pickProjectFolder(): Promise<string | null> {
  return invoke("pick_project_folder");
}

/** Non-fatal per-project warnings gathered at startup, for a one-time notice. */
export function startupWarnings(): Promise<string[]> {
  return invoke("startup_warnings");
}

export function listActiveTags(): Promise<string[]> {
  return invoke("list_active_tags");
}

// --- Prompts (plan.7). A per-project, versioned prompt library. Prompts are
// viewed one project at a time, so listPrompts requires a projectId in its
// filter. Every content edit is captured as an immutable version; the AI
// "enhance" flow reuses aiRewriteStream and persists an accepted proposal via
// updatePrompt({ body, source: "aiEnhanced" }). ---

export function listPrompts(filter: PromptListFilter): Promise<Prompt[]> {
  return invoke("list_prompts", { filter });
}

export function getPrompt(id: string): Promise<Prompt> {
  return invoke("get_prompt", { id });
}

export function createPrompt(input: NewPrompt): Promise<Prompt> {
  return invoke("create_prompt", { input });
}

export function updatePrompt(id: string, patch: UpdatePrompt): Promise<Prompt> {
  return invoke("update_prompt", { id, patch });
}

/** The full version history for one prompt, newest-first. */
export function listPromptVersions(promptId: string): Promise<PromptVersion[]> {
  return invoke("list_prompt_versions", { promptId });
}

export function deletePrompt(id: string): Promise<void> {
  return invoke("delete_prompt", { id });
}

export function aiRewrite(req: RewriteRequest): Promise<string> {
  return invoke("ai_rewrite", { req });
}

/**
 * Generate a title from `text` (R1 after a rework, R4 on an empty-title save).
 * Rejects with a bare AppError string — callers do `String(err)`. The distinct
 * missing-key copy and the generic "couldn't generate a title — try again"
 * copy both pass through verbatim (the backend scrubs raw vendor bodies).
 */
export function aiGenerateTitle(
  provider: ProviderId,
  text: string,
): Promise<string> {
  const req: GenerateTitleRequest = { provider, text };
  return invoke("ai_generate_title", { req });
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

// --- JIRA enrichment. Enrichment is host-pinned server-side: the backend
// re-extracts the ticket key from jiraUrl and calls only the configured site,
// so the stored URL's host is never a request destination. ---

/** Enrich a stored JIRA URL into ticket title/status. Rejects (bare AppError
 *  string) when the URL has no ticket key, JIRA isn't configured, the token is
 *  missing, or the lookup fails — callers degrade the chip to its plain label. */
export function getJiraTicket(jiraUrl: string): Promise<TicketMeta> {
  return invoke("get_jira_ticket", { jiraUrl });
}

export function getJiraConfig(): Promise<JiraConfig | null> {
  return invoke("get_jira_config");
}

export function setJiraConfig(config: JiraConfig): Promise<void> {
  return invoke("set_jira_config", { config });
}

/** Save (empty string removes) the JIRA API token in the keyring. */
export function setJiraToken(token: string): Promise<void> {
  return invoke("set_jira_token", { token });
}

export function hasJiraToken(): Promise<boolean> {
  return invoke("has_jira_token");
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

/**
 * Native confirmation dialog. The Tauri webview suppresses the browser's
 * synchronous `window.confirm`, so every destructive/consequential prompt
 * (delete, unload, reload, delete-files) routes through the dialog plugin's
 * async `ask` instead. Resolves `true` when the user accepts. Routed through
 * api.ts like `openExternal`, so plugin IPC stays out of components.
 */
export function confirmDialog(message: string, title = "worknotes"): Promise<boolean> {
  return ask(message, { title, kind: "warning" });
}
