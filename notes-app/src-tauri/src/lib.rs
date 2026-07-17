pub mod ai;
mod commands;
pub mod db;
pub mod error;
pub mod jira;
pub mod models;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tauri::Manager;

use db::SqliteRepository;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // %APPDATA%\<identifier> on Windows.
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("notes.db");

            // This is the only line that knows the app runs on SQLite.
            // A cloud build would construct a different ItemRepository here.
            let repo = tauri::async_runtime::block_on(SqliteRepository::connect(&db_path))?;

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
                repo: Arc::new(repo),
                http,
                cancellations: Mutex::new(HashMap::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_items,
            commands::get_item,
            commands::create_item,
            commands::update_item,
            commands::delete_item,
            commands::search_items,
            commands::list_projects,
            commands::create_project,
            commands::rename_project,
            commands::delete_project,
            commands::list_active_tags,
            commands::ai_rewrite,
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
