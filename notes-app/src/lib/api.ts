import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ask } from "@tauri-apps/plugin-dialog";
import { isHttpUrl } from "./jira";
import { parseContextMenuAction, type ContextMenuAction, type MenuSurface } from "./contextMenu";
import type {
  Draft,
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

/** Convert a saved NOTE into a task (plan.14 F7) — one-way, same id/tab key.
 *  The backend stamps create()'s task defaults (todo/normal, no due date) and
 *  bumps updatedAt; only the id crosses IPC. */
export function convertNoteToTask(id: string): Promise<Item> {
  return invoke("convert_note_to_task", { id });
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

/** Load a known project. Resolves to the info plus per-file import warnings
 *  (skipped files, degraded values) — mirror of reloadProject's channel. */
export function loadProject(id: string): Promise<[ProjectInfo, string[]]> {
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

/**
 * Rename a project. The backend moves the catalog row, the store's own marker
 * and the git-portable `project.json` together, so the new name survives a
 * reopen, a folder move, and a clone. The project must be loaded, and names are
 * unique across the catalog.
 */
export function renameProject(id: string, name: string): Promise<ProjectInfo> {
  return invoke("rename_project", { id, name });
}

/** Remove a project from the catalog; its files are left on disk. */
export function forgetProject(id: string): Promise<void> {
  return invoke("forget_project", { id });
}

/** Destructively delete a project's files, then its catalog row. */
export function deleteProjectFiles(id: string): Promise<void> {
  return invoke("delete_project_files", { id });
}

/**
 * Open a project's folder in the OS file manager (plan.8). The webview passes
 * ONLY the project id — never a path: the Rust command looks the directory up in
 * the catalog, verifies it is a directory (`is_dir()`), and calls the opener
 * plugin server-side. No `opener:allow-open-path`/`reveal` capability is granted
 * to the webview (a bare path grant is either non-functional or unscoped, and
 * open_path on a file would execute it — plan.8 §4 H1). Rejects if the stored
 * path is now missing or not a directory.
 */
export function revealProjectFolder(id: string): Promise<void> {
  return invoke("reveal_project_folder", { id });
}

/** Show the native folder picker; resolves to the chosen path or null. */
export function pickProjectFolder(): Promise<string | null> {
  return invoke("pick_project_folder");
}

/** Non-fatal per-project warnings gathered at startup, for a one-time notice. */
export function startupWarnings(): Promise<string[]> {
  return invoke("startup_warnings");
}

// --- Scratch pad (Plan 13). One canonical, git-tracked `scratch.md` at the
// project root — plain text, no frontmatter, committed with the project. The
// project must be loaded; an absent file reads as "". Errors are fixed generic
// strings (never a path). ---

export function getScratch(projectId: string): Promise<string> {
  return invoke("get_scratch", { projectId });
}

/** Replace the pad (an empty body deletes `scratch.md`). Capped at 4 MB server-side. */
export function setScratch(projectId: string, body: string): Promise<void> {
  return invoke("set_scratch", { projectId, body });
}

// --- Draft backups (plan.15). App-private snapshots of unsaved editor buffers
// in app_data_dir\drafts (never localStorage, never the project dir). Backup,
// not autosave: nothing here ever writes items/<uuid>.md or scratch.md. Errors
// are fixed generic strings. ---

/** Persist one buffer snapshot. Refused for a project that isn't loaded (a
 *  project-less draft, projectId "", is accepted). Fire-and-forget callers
 *  must swallow rejections — a failed backup never interrupts typing. */
export function saveDraft(draft: Draft): Promise<void> {
  return invoke("save_draft", { draft });
}

/** Every draft backup on disk (all projects), for boot restore. Corrupt files
 *  are skipped server-side — this never fails because one draft is bad. */
export function listDrafts(): Promise<Draft[]> {
  return invoke("list_drafts");
}

/** Delete one draft backup (idempotent) — every buffer-discarding path calls
 *  this: save, discard, item delete. */
export function deleteDraft(draftId: string): Promise<void> {
  return invoke("delete_draft", { draftId });
}

/** Delete every draft of a LOADED project — call BEFORE unload/reload (their
 *  confirms promise "unsaved edits are discarded"). Delete files / Forget
 *  sweep server-side on their own. */
export function sweepProjectDrafts(projectId: string): Promise<void> {
  return invoke("sweep_project_drafts", { projectId });
}

/**
 * Plan.15 Phase 6 (D10): subscribe to the Rust-side `flush-drafts` event, sent
 * when the window's close was intercepted so every dirty buffer can snapshot
 * before the window dies. The IPC-only-through-api.ts rule covers events too —
 * components never touch `listen` directly. Returns an unsubscribe.
 */
export function onFlushDrafts(handler: () => void | Promise<void>): () => void {
  const unlisten = listen("flush-drafts", () => void handler());
  return () => {
    void unlisten.then((un) => un()).catch(() => {});
  };
}

/** Tell Rust the flush is done; it destroys the window (or its ~1.5 s timeout
 *  does — this must never hang the close). */
export function ackClose(): Promise<void> {
  return invoke("ack_close");
}

/**
 * Plan.16 D4: tell Rust which kind of field has focus — `"body"` (an item or
 * prompt body textarea), `"scratch"` (the pad) or `"none"`. The native WebView2
 * context menu is augmented from Rust (`src-tauri/src/context_menu.rs`), and
 * WebView2 exposes no element identity to that hook, so the frontend publishes
 * the surface on focus changes and Rust reads the latest value when a
 * right-click arrives. The value is derived from the app-rendered
 * `data-menu-surface` attribute, never from user text; Rust allowlists it.
 */
export function setContextMenuSurface(surface: MenuSurface): Promise<void> {
  return invoke("set_context_menu_surface", { surface });
}

/**
 * Plan.16 D6: subscribe to the `context-menu-action` event Rust emits when the
 * user picks one of the app's items on the native menu. Mirrors `onFlushDrafts`
 * exactly: the `listen()` promise stays inside and the returned unsubscribe is
 * synchronous, so an editor effect can return it directly. The payload is
 * validated against the static action-id allowlist; anything else is dropped.
 */
export function onContextMenuAction(handler: (action: ContextMenuAction) => void): () => void {
  const unlisten = listen<unknown>("context-menu-action", (e) => {
    const action = parseContextMenuAction(e.payload);
    if (action !== null) handler(action);
  });
  return () => {
    void unlisten.then((un) => un()).catch(() => {});
  };
}

export function listActiveTags(): Promise<string[]> {
  return invoke("list_active_tags");
}

// --- Prompts (plan.7 / plan.9). A per-project, versioned prompt library.
// listPrompts scopes to one project (filter.projectId set) OR fans REUSABLE
// prompts across every loaded store when projectId is omitted (the "All
// projects" scope; a projectId-less non-reusable list is rejected server-side).
// Every content edit is captured as an immutable version; the AI "enhance" flow
// reuses aiRewriteStream and persists an accepted proposal via
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

/** Move a prompt (with its full version history) to another loaded project
 *  (plan.8). Resolves to the moved prompt, stamped with the target project. The
 *  backend copies the full history, verifies it, then deletes the source last. */
export function movePrompt(id: string, targetProjectId: string): Promise<Prompt> {
  return invoke("move_prompt", { promptId: id, targetProjectId });
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

// The app version from tauri.conf.json (the same value the OS/installer reports),
// via the core app plugin. Wrapped here so this non-invoke touchpoint stays
// greppable like openExternal/copyToClipboard.
export function getAppVersion(): Promise<string> {
  return getVersion();
}

/**
 * Copy plain text to the OS clipboard (plan.8). A frontend-only touchpoint (no
 * Tauri command) using the Web `navigator.clipboard` API, which the secure
 * WebView2 context permits from a user click; the CSP (`default-src 'self'`)
 * does not restrict it (a Web API, not a network surface). Routed through api.ts
 * like `openExternal` so the OS surface stays greppable. Plain text only — no
 * rich/HTML format. NOTE (§4 L1): the text lands on the shared OS clipboard,
 * readable by any process and captured by Windows Clipboard History; this is
 * user-initiated and expected. Rejects if the clipboard API is unavailable.
 */
export async function copyToClipboard(text: string): Promise<void> {
  if (!navigator.clipboard) {
    throw new Error("The clipboard is unavailable.");
  }
  await navigator.clipboard.writeText(text);
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
