pub mod ai;
mod commands;
pub mod db;
pub mod error;
pub mod jira;
pub mod models;
pub mod projects;
pub mod store;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{Emitter, Manager};

use projects::catalog::Catalog;
use projects::ProjectManager;

/// Plan.15 D10 (the R6 fold-in): whether a window close is already in flight.
/// The `CloseRequested` handler flips it once, emits `flush-drafts`, and arms a
/// timeout; a repeated CloseRequested while the flush runs is a prevented
/// no-op, and the window is destroyed on the frontend's `ack_close` or the
/// timeout — never hung open by a wedged webview.
pub struct CloseState {
    pub closing: AtomicBool,
}

/// How long the close waits for the webview to flush dirty buffers before
/// closing anyway. Generous for a handful of ≤4 MiB local writes.
const CLOSE_FLUSH_TIMEOUT_MS: u64 = 1500;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Plan.15 Phase 6: graceful window close (Alt+F4 / X) flushes every
        // dirty editor buffer to the draft store before the window dies —
        // Rust-side, so no `core:window:allow-close/destroy` capability grant
        // is needed (app commands are not ACL-gated, and this handler never
        // traverses the ACL). The frontend listener (api.onFlushDrafts) runs
        // EditorHandle.flushDraft on every dirty tab — NEVER save(), which
        // would write items/<uuid>.md on every close (violating D2) and can
        // fire an AI call — then acks via the `ack_close` command.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let state = window.state::<CloseState>();
                if state.closing.swap(true, Ordering::SeqCst) {
                    return; // flush already in flight; the ack/timeout closes
                }
                let _ = window.emit("flush-drafts", ());
                // Timeout failsafe: destroy even if the webview never acks. A
                // plain thread (std only) — destroy() is safe cross-thread and
                // a no-op error if the ack won the race.
                let win = window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(CLOSE_FLUSH_TIMEOUT_MS));
                    let _ = win.destroy();
                });
            }
        })
        .setup(|app| {
            // %APPDATA%\<identifier> on Windows.
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;

            // The app-level catalog + the project manager are the only place that
            // knows the app runs on SQLite. A cloud build would swap the stores
            // the manager loads. `run_startup` performs the one-time legacy
            // migration and loads previously-loaded projects, isolating any
            // per-project failure into a warning (never a startup abort).
            let catalog = tauri::async_runtime::block_on(Catalog::open(&data_dir.join("catalog.db")))?;
            let manager = ProjectManager::new(catalog, data_dir.clone());
            tauri::async_runtime::block_on(manager.run_startup(&data_dir.join("notes.db")));

            // Redirects disabled: the AI and JIRA endpoints never legitimately
            // redirect, and following one would let a (trusted, TLS-verified)
            // configured host bounce a request to an internal address — closing
            // the JIRA host-pinning boundary fully (defense-in-depth over the
            // server-side base_url pin). Shared by all HTTP callers.
            let http = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("failed to build HTTP client");

            app.manage(commands::AppState {
                manager: Arc::new(manager),
                http,
                cancellations: Mutex::new(HashMap::new()),
            });
            app.manage(CloseState { closing: AtomicBool::new(false) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_items,
            commands::get_item,
            commands::create_item,
            commands::update_item,
            commands::convert_note_to_task,
            commands::delete_item,
            commands::search_items,
            commands::list_active_tags,
            commands::list_prompts,
            commands::get_prompt,
            commands::create_prompt,
            commands::update_prompt,
            commands::list_prompt_versions,
            commands::delete_prompt,
            commands::move_prompt,
            commands::list_projects,
            commands::create_project,
            commands::open_project,
            commands::load_project,
            commands::unload_project,
            commands::reload_project,
            commands::rename_project,
            commands::forget_project,
            commands::delete_project_files,
            commands::reveal_project_folder,
            commands::pick_project_folder,
            commands::startup_warnings,
            commands::get_scratch,
            commands::set_scratch,
            commands::save_draft,
            commands::list_drafts,
            commands::delete_draft,
            commands::sweep_project_drafts,
            commands::ack_close,
            commands::ai_rewrite,
            commands::ai_generate_title,
            commands::ai_rewrite_stream,
            commands::ai_rewrite_cancel,
            commands::set_api_key,
            commands::has_api_key,
            commands::get_jira_config,
            commands::set_jira_config,
            commands::set_jira_token,
            commands::has_jira_token,
            commands::get_jira_ticket,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
