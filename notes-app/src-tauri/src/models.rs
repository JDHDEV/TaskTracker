use serde::{Deserialize, Serialize};
use sqlx::types::Json;

/// Notes and tasks share one shape; `kind` discriminates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "lowercase")]
#[sqlx(rename_all = "lowercase")]
pub enum Kind {
    Note,
    Task,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "lowercase")]
#[sqlx(rename_all = "lowercase")]
pub enum Status {
    Todo,
    Doing,
    Done,
}

/// Task priority. `Normal` is the quiet default; only `Low` and `High`
/// get visual treatment in the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "lowercase")]
#[sqlx(rename_all = "lowercase")]
pub enum Priority {
    Low,
    Normal,
    High,
}

/// The stored record. Timestamps are RFC 3339 strings end to end — SQLite,
/// Rust, and JS all agree on them without any mapping layer.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub kind: Kind,
    pub title: String,
    pub body: String,
    pub status: Option<Status>,
    pub priority: Option<Priority>,
    pub due_at: Option<String>,
    pub tags: Json<Vec<String>>,
    pub created_at: String,
    pub updated_at: String,
    pub archived: bool,
    pub pinned: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewItem {
    pub kind: Kind,
    pub title: String,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub status: Option<Status>,
    #[serde(default)]
    pub priority: Option<Priority>,
    #[serde(default)]
    pub due_at: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
}

/// Partial update: `None` means "leave unchanged". (Clearing an optional
/// field like `dueAt` is done by sending an empty string; see the impl.)
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateItem {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub status: Option<Status>,
    #[serde(default)]
    pub priority: Option<Priority>,
    #[serde(default)]
    pub due_at: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub archived: Option<bool>,
    #[serde(default)]
    pub pinned: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListFilter {
    #[serde(default)]
    pub kind: Option<Kind>,
    /// Defaults to false: archived items stay out of every list until asked for.
    #[serde(default)]
    pub archived: Option<bool>,
}
