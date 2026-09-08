use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::ai::{self, keys, ChunkSink, RewriteErrorCode, RewriteEvent};
use crate::context_menu::MenuSurface;
use crate::error::{AppError, Result};
use crate::jira;
use crate::models::{
    Draft, Item, JiraConfig, ListFilter, NewItem, NewPrompt, ProjectInfo, Prompt,
    PromptListFilter, PromptVersion, TicketMeta, UpdateItem, UpdatePrompt,
};
use crate::projects::ProjectManager;

/// Everything commands are allowed to touch. Commands depend only on the
/// `ProjectManager` (which owns the loaded per-project stores behind the
/// `ItemRepository` trait) — never on a concrete storage impl.
pub struct AppState {
    pub manager: Arc<ProjectManager>,
    pub http: reqwest::Client,
    /// In-flight streaming rewrites, keyed by their request id, so
    /// `ai_rewrite_cancel` can flip the flag the stream loop polls. Entries
    /// are removed on any terminal event so the map can't grow unbounded.
    pub cancellations: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// Plan.16 D4: which kind of field has focus, published by the frontend on
    /// focus changes so the native context-menu hook (`context_menu.rs`) knows
    /// which items to append. The ONE copy — `set_context_menu_surface` writes
    /// it and the hook reads it through the `AppHandle`.
    pub menu_surface: Mutex<MenuSurface>,
}

/// Plan.16 D4: record which kind of field has focus. Allowlisted — anything but
/// `none` | `body` | `scratch` is rejected without touching the stored value
/// (§4 MUST 3). The value is derived from an attribute the app itself renders,
/// never from user text.
#[tauri::command]
pub fn set_context_menu_surface(state: State<'_, AppState>, surface: String) -> Result<()> {
    let parsed = MenuSurface::parse(&surface)
        .ok_or_else(|| AppError::Invalid("unknown context-menu surface".into()))?;
    *state.menu_surface.lock().unwrap() = parsed;
    Ok(())
}

#[tauri::command]
pub async fn list_items(
    state: State<'_, AppState>,
    filter: Option<ListFilter>,
) -> Result<Vec<Item>> {
    state.manager.list_all(&filter.unwrap_or_default()).await
}

#[tauri::command]
pub async fn get_item(state: State<'_, AppState>, id: String) -> Result<Item> {
    state.manager.get(&id).await
}

#[tauri::command]
pub async fn create_item(state: State<'_, AppState>, input: NewItem) -> Result<Item> {
    state.manager.create(input).await
}

#[tauri::command]
pub async fn update_item(
    state: State<'_, AppState>,
    id: String,
    patch: UpdateItem,
) -> Result<Item> {
    state.manager.update(&id, patch).await
}

/// Convert a NOTE into a task (plan.14 F7): id-only input — status/priority
/// are defaulted SERVER-side exactly as `create()` does, and `id`/`createdAt`/
/// `updatedAt`/`schemaVersion` are never accepted from the client (S-8). The
/// one narrow exception to "kind is fixed at creation"; `UpdateItem` still has
/// no `kind` field.
#[tauri::command]
pub async fn convert_note_to_task(state: State<'_, AppState>, id: String) -> Result<Item> {
    state.manager.convert_note_to_task(&id).await
}

#[tauri::command]
pub async fn delete_item(state: State<'_, AppState>, id: String) -> Result<()> {
    state.manager.delete(&id).await
}

#[tauri::command]
pub async fn search_items(
    state: State<'_, AppState>,
    query: String,
    filter: Option<ListFilter>,
) -> Result<Vec<Item>> {
    state.manager.search_all(&query, &filter.unwrap_or_default()).await
}

#[tauri::command]
pub async fn list_active_tags(state: State<'_, AppState>) -> Result<Vec<String>> {
    state.manager.active_tags_union().await
}

// --- Prompts (plan.7 / plan.9) ---------------------------------------------
// Thin wrappers over the manager, mirroring the item commands. `list_prompts`
// scopes to one project when its filter carries a `projectId`, else fans REUSABLE
// prompts across all loaded stores (the "All projects" scope) — a projectId-less
// non-reusable filter is rejected by the manager. All prompt/model text reaches
// the frontend as plain strings rendered in text nodes (no HTML — M4).

#[tauri::command]
pub async fn list_prompts(
    state: State<'_, AppState>,
    filter: Option<PromptListFilter>,
) -> Result<Vec<Prompt>> {
    state.manager.list_prompts(&filter.unwrap_or_default()).await
}

#[tauri::command]
pub async fn get_prompt(state: State<'_, AppState>, id: String) -> Result<Prompt> {
    state.manager.get_prompt(&id).await
}

#[tauri::command]
pub async fn create_prompt(state: State<'_, AppState>, input: NewPrompt) -> Result<Prompt> {
    state.manager.create_prompt(input).await
}

/// Patch a prompt. A `title`/`body` change appends a new version (with `source`,
/// defaulting to `"manual"`; the accept-proposal path sends `"aiEnhanced"`); a
/// `reusable`-only change appends no version and does not move `updatedAt`.
#[tauri::command]
pub async fn update_prompt(
    state: State<'_, AppState>,
    id: String,
    patch: UpdatePrompt,
) -> Result<Prompt> {
    state.manager.update_prompt(&id, patch).await
}

/// The full version history for one prompt, newest-first.
#[tauri::command]
pub async fn list_prompt_versions(
    state: State<'_, AppState>,
    prompt_id: String,
) -> Result<Vec<PromptVersion>> {
    state.manager.prompt_versions(&prompt_id).await
}

#[tauri::command]
pub async fn delete_prompt(state: State<'_, AppState>, id: String) -> Result<()> {
    state.manager.delete_prompt(&id).await
}

/// Move a prompt (with its full version history) to another loaded project
/// (plan.8). Thin wrapper: the manager owns the resolve → export → import →
/// verify → delete-source-last ordering and every validation (same-project /
/// unloaded / unknown target). Returns the moved prompt, stamped with the target.
#[tauri::command]
pub async fn move_prompt(
    state: State<'_, AppState>,
    prompt_id: String,
    target_project_id: String,
) -> Result<Prompt> {
    state.manager.move_prompt(&prompt_id, &target_project_id).await
}

// --- Project lifecycle -----------------------------------------------------

/// Every known project (loaded or not) with a loaded flag and a live item count
/// for loaded ones.
#[tauri::command]
pub async fn list_projects(state: State<'_, AppState>) -> Result<Vec<ProjectInfo>> {
    state.manager.list_projects().await
}

/// Create a new project at a user-chosen directory (validated Rust-side) and
/// load it.
#[tauri::command]
pub async fn create_project(
    state: State<'_, AppState>,
    dir: String,
    name: String,
) -> Result<ProjectInfo> {
    state.manager.create_project(&dir, &name).await
}

/// Open (and load) an existing project from a user-chosen directory.
#[tauri::command]
pub async fn open_project(state: State<'_, AppState>, dir: String) -> Result<ProjectInfo> {
    state.manager.open_project(&dir).await
}

/// Load a known project by id. Returns the info plus per-file import warnings
/// (skipped files, degraded values) — the same channel `reload_project` has,
/// so a load-time skip or degrade is never silent (plan.14 S-2).
#[tauri::command]
pub async fn load_project(
    state: State<'_, AppState>,
    id: String,
) -> Result<(ProjectInfo, Vec<String>)> {
    state.manager.load(&id).await
}

/// Unload a loaded project (closes its store; reversible).
#[tauri::command]
pub async fn unload_project(state: State<'_, AppState>, id: String) -> Result<()> {
    state.manager.unload(&id).await
}

/// Reload a project from its on-disk `items/*.md` files (Stage 2, after a
/// `git pull` changed them). Returns per-file import warnings (e.g. files with
/// unresolved conflict markers) so the UI can report which items were skipped.
#[tauri::command]
pub async fn reload_project(state: State<'_, AppState>, id: String) -> Result<Vec<String>> {
    state.manager.reload(&id).await
}

/// Rename a project. The catalog row, the store's own `meta` marker, and the
/// git-portable `project.json` are updated together so no later reopen can
/// resurrect the old name; the UUID never changes. The project must be loaded,
/// and the new name must be unique across the catalog.
#[tauri::command]
pub async fn rename_project(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Result<ProjectInfo> {
    state.manager.rename(&id, &name).await
}

/// Forget a project (removes it from the catalog; files untouched). Must be
/// unloaded first.
#[tauri::command]
pub async fn forget_project(state: State<'_, AppState>, id: String) -> Result<()> {
    state.manager.forget(&id).await
}

/// Destructively delete a project's files, then its catalog row. Must be
/// unloaded first.
#[tauri::command]
pub async fn delete_project_files(state: State<'_, AppState>, id: String) -> Result<()> {
    state.manager.delete_files(&id).await
}

/// Open a project's folder in the OS file manager (plan.8 §4 H1). SECURITY: the
/// webview passes ONLY the project `id` — never a path. The directory is resolved
/// server-side from the catalog, re-verified to be an existing directory (the
/// `is_dir()` check closes the "open_path on a file executes it" gap should the
/// stored path now point at a file), and handed to the opener plugin's RUST API
/// (`app.opener().open_path`), which is Rust-to-Rust and NOT ACL-gated. No opener
/// path/reveal permission is granted to the webview in `capabilities/default.json`
/// — its OS-open surface stays exactly at the http/https URL grant.
#[tauri::command]
pub async fn reveal_project_folder(
    id: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    let dir = state.manager.project_dir(&id).await?;
    let is_dir = std::fs::metadata(&dir).map(|m| m.is_dir()).unwrap_or(false);
    if !is_dir {
        return Err(AppError::Invalid("that project folder no longer exists".into()));
    }
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|_| AppError::Invalid("couldn't open that folder".into()))
}

/// Non-fatal per-project warnings gathered at startup (moved/corrupt/newer
/// project files), for a one-time frontend notice.
#[tauri::command]
pub fn startup_warnings(state: State<'_, AppState>) -> Vec<String> {
    state.manager.startup_warnings()
}

/// The project's scratch pad (Plan 13): the text of the canonical `scratch.md`
/// at the project root, `""` when absent. The project must be loaded.
#[tauri::command]
pub async fn get_scratch(state: State<'_, AppState>, project_id: String) -> Result<String> {
    state.manager.get_scratch(&project_id).await
}

/// Replace the project's scratch pad (an empty body deletes the file). The
/// project must be loaded; the body is capped server-side at 4 MB.
#[tauri::command]
pub async fn set_scratch(
    state: State<'_, AppState>,
    project_id: String,
    body: String,
) -> Result<()> {
    state.manager.set_scratch(&project_id, &body).await
}

// --- Draft backups (plan.15) -------------------------------------------------
// Thin wrappers over the manager's app-level `DraftStore`. Commands take a
// draft/project UUID, never a path; filenames derive only from `is_uuid`-checked
// ids inside `store::draftfile`; every failure is a fixed generic message. The
// drafts dir is app-private and NOT a compatibility surface.

// All four are `async` like every other file-touching command (post-review
// M4): a sync command runs on the main thread, and `save_draft` fsyncs — one
// disk flush per dirty tab per tick must never ride the UI thread.

/// Persist one unsaved-buffer snapshot. Refuses a project that isn't loaded
/// (like `set_scratch`); a project-less draft (`projectId: ""`) is accepted.
#[tauri::command]
pub async fn save_draft(state: State<'_, AppState>, draft: Draft) -> Result<()> {
    state.manager.save_draft(draft)
}

/// Every draft backup on disk, for boot restore. Corrupt files are skipped
/// per-file (fail-soft) — a bad draft never blocks the app from starting.
#[tauri::command]
pub async fn list_drafts(state: State<'_, AppState>) -> Result<Vec<Draft>> {
    state.manager.list_drafts()
}

/// Delete one draft backup (idempotent) — called from every buffer-discarding
/// path: save, discard, item delete.
#[tauri::command]
pub async fn delete_draft(state: State<'_, AppState>, draft_id: String) -> Result<()> {
    state.manager.delete_draft(&draft_id)
}

/// Delete every draft of a LOADED project — called before Unload/Reload, whose
/// confirms promise "unsaved edits are discarded". (Delete files / Forget sweep
/// server-side on their own.)
#[tauri::command]
pub async fn sweep_project_drafts(state: State<'_, AppState>, project_id: String) -> Result<()> {
    state.manager.sweep_project_drafts(&project_id)
}

/// Plan.15 Phase 6 (D10): the frontend's "all dirty buffers are flushed" ack —
/// the `CloseRequested` handler in lib.rs prevented the close, emitted
/// `flush-drafts`, and is waiting on this (or its ~1.5 s timeout) to destroy
/// the window. An app command, so no `core:window:allow-close/destroy`
/// capability grant is needed. Honored ONLY while a close is actually in
/// flight (post-review, security M2): a spurious ack from renderer code must
/// not become a "destroy the window without flushing" primitive. destroy()
/// failures are ignored: the timeout thread may have won the race, which is
/// fine — the window is gone either way.
#[tauri::command]
pub fn ack_close(window: tauri::Window) {
    use tauri::Manager;
    let closing = window
        .state::<crate::CloseState>()
        .closing
        .load(Ordering::SeqCst);
    if closing {
        let _ = window.destroy();
    }
}

/// Show the native folder picker and return the chosen directory path (or `None`
/// if cancelled). Thin by design: the OS picker is UX only — the returned path
/// is re-validated server-side in `create_project`/`open_project` before any use.
#[tauri::command]
pub async fn pick_project_folder(app: tauri::AppHandle) -> Result<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let picked =
        tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_folder())
            .await
            .map_err(|_| AppError::Invalid("the folder picker could not be opened".into()))?;
    Ok(picked.map(|folder| folder.to_string()))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RewriteRequest {
    pub provider: String,
    pub text: String,
    pub instruction: String,
}

/// Runs the text through the chosen provider and returns the rewrite.
/// The frontend decides whether to apply it — the backend never silently
/// overwrites the user's words. Provider/HTTP errors are scrubbed (plan.7 M2) so
/// a raw upstream response body never surfaces; only the distinct `MissingKey`
/// case keeps its actionable copy.
#[tauri::command]
pub async fn ai_rewrite(state: State<'_, AppState>, req: RewriteRequest) -> Result<String> {
    if req.text.trim().is_empty() {
        return Err(AppError::Invalid("there is no text to rework".into()));
    }
    let provider = ai::provider_for(&req.provider)?;
    provider
        .rewrite(&state.http, &req.text, &req.instruction)
        .await
        .map_err(|e| ai::scrub_provider_error(e, ai::REWRITE_GENERIC_ERROR))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateTitleRequest {
    pub provider: String,
    pub text: String,
}

/// Generates a title from `text` (R1 after a rework, R4 on an empty-title save).
/// A thin wrapper: it only resolves the provider and delegates to the testable
/// `ai::generate_title` core, which owns the empty-text guard, error mapping,
/// and `sanitize_title` (D13). The frontend accepts the returned title; the
/// backend never persists it.
#[tauri::command]
pub async fn ai_generate_title(
    state: State<'_, AppState>,
    req: GenerateTitleRequest,
) -> Result<String> {
    let provider = ai::provider_for(&req.provider)?;
    ai::generate_title(&*provider, &state.http, &req.text).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RewriteStreamRequest {
    pub request_id: String,
    pub provider: String,
    pub text: String,
    pub instruction: String,
}

/// Bridges the vendor-neutral `ChunkSink` to a request-scoped Tauri channel.
/// The provider never sees the channel — only `send_chunk`/`is_cancelled`.
struct ChannelSink {
    channel: Channel<RewriteEvent>,
    cancelled: Arc<AtomicBool>,
}

impl ChunkSink for ChannelSink {
    fn send_chunk(&self, delta: &str) {
        // A dropped channel (webview navigated away) is not fatal — the next
        // is_cancelled poll or the HTTP body ending stops the loop anyway.
        let _ = self.channel.send(RewriteEvent::Chunk {
            delta: delta.to_string(),
        });
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }
}

fn error_code_for(err: &AppError) -> RewriteErrorCode {
    match err {
        AppError::Http(_) => RewriteErrorCode::Network,
        AppError::Invalid(_) | AppError::MissingKey(_) => RewriteErrorCode::Invalid,
        _ => RewriteErrorCode::Provider,
    }
}

/// Streams a rewrite token-by-token over `on_event`. Preflight failures
/// (empty text, unknown provider, missing key) reject the invoke promise so
/// there is nothing to stream. Once the stream starts, EVERY outcome —
/// success, error, or cancellation — is reported through exactly one terminal
/// channel event and the command itself returns `Ok(())`. One signal, never two.
#[tauri::command]
pub async fn ai_rewrite_stream(
    state: State<'_, AppState>,
    req: RewriteStreamRequest,
    on_event: Channel<RewriteEvent>,
) -> Result<()> {
    // --- Preflight (rejects the promise; nothing has streamed yet) ---
    if req.text.trim().is_empty() {
        return Err(AppError::Invalid("there is no text to rework".into()));
    }
    let provider = ai::provider_for(&req.provider)?; // unknown provider → reject
    if !keys::has_key(&req.provider) {
        return Err(AppError::MissingKey(req.provider.clone()));
    }

    // --- Stream (all outcomes report via a channel terminal) ---
    let cancelled = Arc::new(AtomicBool::new(false));
    state
        .cancellations
        .lock()
        .unwrap()
        .insert(req.request_id.clone(), cancelled.clone());

    let sink = ChannelSink {
        channel: on_event.clone(),
        cancelled: cancelled.clone(),
    };
    let result = provider
        .rewrite_stream(&state.http, &req.text, &req.instruction, &sink)
        .await;

    // Remove the entry on ANY terminal outcome, before emitting the terminal.
    state.cancellations.lock().unwrap().remove(&req.request_id);

    // A cancelled stream is Cancelled even if the provider returned partial
    // text as Ok — the flag wins over the underlying result.
    let terminal = if cancelled.load(Ordering::Relaxed) {
        RewriteEvent::Error {
            code: RewriteErrorCode::Cancelled,
            message: "Rework cancelled".into(),
        }
    } else {
        match result {
            Ok(text) => RewriteEvent::Done { text },
            Err(err) => {
                // Preserve the code semantics (Network vs Provider vs Invalid)
                // from the ORIGINAL error, but scrub the MESSAGE so a raw upstream
                // response body never reaches the toast (plan.7 M2). The distinct
                // MissingKey copy is preserved by the scrubber.
                let code = error_code_for(&err);
                let message = ai::scrub_provider_error(err, ai::REWRITE_GENERIC_ERROR).to_string();
                RewriteEvent::Error { code, message }
            }
        }
    };
    let _ = on_event.send(terminal);
    Ok(())
}

/// Requests cooperative cancellation of an in-flight stream. A missing
/// `requestId` (already finished, or never started) is a silent no-op.
#[tauri::command]
pub fn ai_rewrite_cancel(state: State<'_, AppState>, request_id: String) {
    if let Some(flag) = state.cancellations.lock().unwrap().get(&request_id) {
        flag.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
pub fn set_api_key(provider: String, key: String) -> Result<()> {
    ai::provider_for(&provider)?; // reject unknown provider ids
    keys::set_key(&provider, &key)
}

/// Only reports presence — no command ever returns a stored key.
#[tauri::command]
pub fn has_api_key(provider: String) -> bool {
    keys::has_key(&provider)
}

// --- JIRA enrichment -------------------------------------------------------

/// `app_settings` key holding the JSON-encoded non-secret `JiraConfig`. The
/// token is NOT here — it lives in the keyring under `jira::TOKEN_ID`.
const JIRA_CONFIG_KEY: &str = "jira_config";

/// Shared config read, so `get_jira_ticket` doesn't have to reconstruct a
/// `State`. Settings live ONLY in the catalog (Section 4.5) — never a project
/// store — so this reads through the manager's catalog accessor.
async fn load_jira_config(manager: &ProjectManager) -> Result<Option<JiraConfig>> {
    match manager.get_setting(JIRA_CONFIG_KEY).await? {
        Some(json) => {
            let config = serde_json::from_str::<JiraConfig>(&json)
                .map_err(|e| AppError::Invalid(format!("stored JIRA config is corrupt: {e}")))?;
            Ok(Some(config))
        }
        None => Ok(None),
    }
}

/// The saved non-secret JIRA connection, or `None` if never configured.
#[tauri::command]
pub async fn get_jira_config(state: State<'_, AppState>) -> Result<Option<JiraConfig>> {
    load_jira_config(&state.manager).await
}

/// Save the non-secret JIRA connection. Rejects a non-https site URL and an
/// empty email before persisting.
#[tauri::command]
pub async fn set_jira_config(state: State<'_, AppState>, config: JiraConfig) -> Result<()> {
    jira::validate_base_url(&config.base_url)?;
    if config.email.trim().is_empty() {
        return Err(AppError::Invalid("JIRA email must not be empty".into()));
    }
    let json = serde_json::to_string(&config)
        .map_err(|e| AppError::Invalid(format!("could not encode JIRA config: {e}")))?;
    state.manager.set_setting(JIRA_CONFIG_KEY, &json).await
}

/// Save (or, with an empty value, delete) the JIRA API token in the keyring.
/// Boolean-only presence thereafter — no command ever returns it.
#[tauri::command]
pub fn set_jira_token(token: String) -> Result<()> {
    keys::set_key(jira::TOKEN_ID, &token)
}

#[tauri::command]
pub fn has_jira_token() -> bool {
    keys::has_key(jira::TOKEN_ID)
}

/// Enrich a stored `jira_url` into ticket title/status. SECURITY (the Critical
/// item): the ticket key is re-extracted HERE, server-side, and the request
/// goes only to the configured `base_url` — the host in `jira_url` is never a
/// request destination. Failure order matters: an unparseable/keyless URL is
/// rejected BEFORE any config/token/network work, so a metadata-host URL like
/// `http://169.254.169.254/latest/meta-data/` never triggers a lookup.
#[tauri::command]
pub async fn get_jira_ticket(state: State<'_, AppState>, jira_url: String) -> Result<TicketMeta> {
    let key = jira::extract_ticket_key(&jira_url)
        .ok_or_else(|| AppError::Invalid("no JIRA ticket key in that URL".into()))?;

    let config = load_jira_config(&state.manager)
        .await?
        .ok_or(AppError::NotConfigured)?;
    // Defense-in-depth: re-validate the stored base URL before dialing it.
    jira::validate_base_url(&config.base_url)?;
    let token = keys::get_key(jira::TOKEN_ID)?; // missing → MissingKey

    let provider = jira::jira_provider_for(jira::DEFAULT_PROVIDER)?;
    provider
        .fetch_ticket(&state.http, &config, &token, &key)
        .await
}
