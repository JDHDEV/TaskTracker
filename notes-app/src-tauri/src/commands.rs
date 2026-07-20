use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::ai::{self, keys, ChunkSink, RewriteErrorCode, RewriteEvent};
use crate::error::{AppError, Result};
use crate::jira;
use crate::models::{
    Item, JiraConfig, ListFilter, NewItem, NewPrompt, ProjectInfo, Prompt, PromptListFilter,
    PromptVersion, TicketMeta, UpdateItem, UpdatePrompt,
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

// --- Prompts (plan.7) ------------------------------------------------------
// Thin wrappers over the manager, mirroring the item commands. Prompts are
// viewed one project at a time, so `list_prompts` requires a `projectId` in its
// filter; the manager rejects an empty/absent one. All prompt/model text reaches
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

/// Load a known project by id.
#[tauri::command]
pub async fn load_project(state: State<'_, AppState>, id: String) -> Result<ProjectInfo> {
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
