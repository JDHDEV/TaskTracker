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

/// List sort mode. `Updated` is the default; a closed enum so the repository
/// maps each variant to a static SQL fragment (never user text) for ORDER BY.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Sort {
    Updated,
    Created,
    Priority,
    Status,
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
    pub project_id: Option<String>,
    pub jira_url: Option<String>,
}

/// A project: id-referenced so renames don't touch items. Not `Deserialize` —
/// `create_project`/`rename_project` take a plain name, nothing parses a Project.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub created_at: String,
}

/// A project plus how many items reference it (archived included, so the count
/// agrees with the delete guard). Serializes `item_count` as `itemCount`.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ProjectWithCount {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub item_count: i64,
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
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub jira_url: Option<String>,
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
    pub project_id: Option<String>,
    #[serde(default)]
    pub jira_url: Option<String>,
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
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub status: Option<Status>,
    /// OR-matched: an item matches if it carries any of these tags. Empty or
    /// omitted means "no tag filter".
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    /// Defaults to `Sort::Updated` when omitted.
    #[serde(default)]
    pub sort: Option<Sort>,
}
