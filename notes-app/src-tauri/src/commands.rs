use std::sync::Arc;

use serde::Deserialize;
use tauri::State;

use crate::ai::{self, keys};
use crate::db::ItemRepository;
use crate::error::{AppError, Result};
use crate::models::{Item, ListFilter, NewItem, Project, ProjectWithCount, UpdateItem};

/// Everything commands are allowed to touch. Note the type: the repository
/// is `dyn ItemRepository` — commands cannot know or care that it's SQLite.
pub struct AppState {
    pub repo: Arc<dyn ItemRepository>,
    pub http: reqwest::Client,
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
