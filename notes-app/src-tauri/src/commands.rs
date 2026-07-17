use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::ai::{self, keys, ChunkSink, RewriteErrorCode, RewriteEvent};
use crate::db::ItemRepository;
use crate::error::{AppError, Result};
use crate::models::{Item, ListFilter, NewItem, Project, ProjectWithCount, UpdateItem};

/// Everything commands are allowed to touch. Note the type: the repository
/// is `dyn ItemRepository` — commands cannot know or care that it's SQLite.
pub struct AppState {
    pub repo: Arc<dyn ItemRepository>,
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
    state.repo.list(&filter.unwrap_or_default()).await
}

#[tauri::command]
pub async fn get_item(state: State<'_, AppState>, id: String) -> Result<Item> {
    state.repo.get(&id).await
}

#[tauri::command]
pub async fn create_item(state: State<'_, AppState>, input: NewItem) -> Result<Item> {
    state.repo.create(input).await
}

#[tauri::command]
pub async fn update_item(
    state: State<'_, AppState>,
    id: String,
    patch: UpdateItem,
) -> Result<Item> {
    state.repo.update(&id, patch).await
}

#[tauri::command]
pub async fn delete_item(state: State<'_, AppState>, id: String) -> Result<()> {
    state.repo.delete(&id).await
}

#[tauri::command]
pub async fn search_items(
    state: State<'_, AppState>,
    query: String,
    filter: Option<ListFilter>,
) -> Result<Vec<Item>> {
    state.repo.search(&query, &filter.unwrap_or_default()).await
}

#[tauri::command]
pub async fn list_projects(state: State<'_, AppState>) -> Result<Vec<ProjectWithCount>> {
    state.repo.list_projects().await
}

#[tauri::command]
pub async fn create_project(state: State<'_, AppState>, name: String) -> Result<Project> {
    state.repo.create_project(&name).await
}

#[tauri::command]
pub async fn rename_project(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Result<Project> {
    state.repo.rename_project(&id, &name).await
}

#[tauri::command]
pub async fn delete_project(state: State<'_, AppState>, id: String) -> Result<()> {
    state.repo.delete_project(&id).await
}

#[tauri::command]
pub async fn list_active_tags(state: State<'_, AppState>) -> Result<Vec<String>> {
    state.repo.list_active_tags().await
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
/// overwrites the user's words.
#[tauri::command]
pub async fn ai_rewrite(state: State<'_, AppState>, req: RewriteRequest) -> Result<String> {
    if req.text.trim().is_empty() {
        return Err(AppError::Invalid("there is no text to rework".into()));
    }
    let provider = ai::provider_for(&req.provider)?;
    provider.rewrite(&state.http, &req.text, &req.instruction).await
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
            Err(err) => RewriteEvent::Error {
                code: error_code_for(&err),
                message: err.to_string(),
            },
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
