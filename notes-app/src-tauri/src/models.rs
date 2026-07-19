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

/// A known project for the frontend: catalog identity (id, name, directory
/// path) plus whether it is currently loaded, and a live item count for loaded
/// projects only (`None` when unloaded — a closed store is not opened just to
/// count). Serialized only (assembled by the `ProjectManager`); the id is the
/// UUID from the store's `meta` table. Mirror in `src/types.ts`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub loaded: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_count: Option<i64>,
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
    /// REQUIRED: the project this item is created into — the manager's routing
    /// key, consumed to pick the target store and never persisted inside it
    /// (per-store rows always store `project_id = NULL`; the manager stamps the
    /// owning UUID onto every returned item). An empty string is rejected.
    pub project_id: String,
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
    // No `project_id`: items do not move between stores in v1 (a future "move
    // item" is a copy-delete across stores with id preservation).
    #[serde(default)]
    pub jira_url: Option<String>,
    #[serde(default)]
    pub archived: Option<bool>,
    #[serde(default)]
    pub pinned: Option<bool>,
}

/// Atlassian's coarse status bucket. The three category keys are stable across
/// every workflow (custom status *names* vary, categories do not), so the UI
/// maps these — not the free-text status name — to the existing status-dot
/// colors. Mirror in `src/types.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StatusCategory {
    New,
    Indeterminate,
    Done,
}

/// Enriched JIRA ticket metadata for the chip. Returned to the frontend only;
/// never persisted. `title`/`status` are remote text and render as React text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketMeta {
    pub key: String,
    pub title: String,
    pub status: String,
    pub status_category: StatusCategory,
    /// RFC 3339, minted server-side when the fetch succeeds — lets the chip
    /// show how fresh the enrichment is.
    pub fetched_at: String,
}

/// Non-secret JIRA connection settings, stored in `app_settings` (NOT the
/// keyring, which refuses read-back). The API token lives in the keyring and is
/// never part of this struct. Mirror in `src/types.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraConfig {
    pub base_url: String,
    pub email: String,
}

// --- Prompts (plan.7): a per-project, versioned prompt library. A prompt is a
// NEW entity (not a third item `kind`), and its history lives in the canonical
// file store. `title`/`body` are the CURRENT version's; `updatedAt` is the
// current version's `createdAt` (derived, so it can never drift); `projectId` is
// stamped by the manager on return, never persisted in-file (like items). ---

/// A prompt as the frontend sees it. Assembled by the repository from the index:
/// the current version (head of `created_at DESC, id ASC`) supplies `title`,
/// `body`, and `updatedAt`; `versionCount` lets a list row show a `vN` badge
/// without a full history fetch. Serialized only. Mirror in `src/types.ts`.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Prompt {
    pub id: String,
    pub title: String,
    pub body: String,
    pub reusable: bool,
    pub created_at: String,
    /// The current version's `created_at` (derived) — not a stored column.
    pub updated_at: String,
    pub version_count: i64,
    /// Stamped by the manager on return (the owning store's UUID); never a
    /// persisted column, so the query omits it and `FromRow` defaults it to None.
    #[sqlx(default)]
    pub project_id: Option<String>,
}

/// One immutable version in a prompt's history. `promptId` is derived from the
/// owning store on scan, not persisted in the version file (same principle as
/// items not storing `project_id`). `source`: `"manual"` | `"aiEnhanced"`.
/// Serialized only. Mirror in `src/types.ts`.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct PromptVersion {
    pub id: String,
    pub prompt_id: String,
    pub title: String,
    pub body: String,
    pub source: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewPrompt {
    /// REQUIRED: the project this prompt is created into — the manager's routing
    /// key, consumed to pick the target store and never persisted in-file. An
    /// empty string is rejected.
    pub project_id: String,
    pub title: String,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub reusable: Option<bool>,
    /// Provenance of the FIRST version. Defaults to `"manual"`; the frontend
    /// sends `"aiEnhanced"` when a brand-new draft's first persisted content is
    /// an accepted AI-enhance proposal (§12), so history labels it correctly.
    /// Any value other than `"aiEnhanced"` normalizes to `"manual"`.
    #[serde(default)]
    pub source: Option<String>,
}

/// Partial update. Omitted fields mean "unchanged". A `title`/`body` change
/// appends a new immutable version (with `source`, defaulting to `"manual"`); a
/// `reusable`-only change rewrites `prompt.md` and appends NO version and does
/// NOT move `updatedAt`. `source` is set to `"aiEnhanced"` by the accept-proposal
/// path; any value other than `"aiEnhanced"` normalizes to `"manual"`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePrompt {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub reusable: Option<bool>,
    #[serde(default)]
    pub source: Option<String>,
}

/// Which prompts to list. `projectId` selects the store (a whole store is one
/// project — the manager routes to it; prompts are viewed one project at a time,
/// so there is no cross-store fan-out). `reusableOnly` is the only prompt filter
/// in v1 — a bound `WHERE reusable = 1`, never raw SQL.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptListFilter {
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub reusable_only: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListFilter {
    #[serde(default)]
    pub kind: Option<Kind>,
    /// Defaults to false: archived items stay out of every list until asked for.
    #[serde(default)]
    pub archived: Option<bool>,
    /// Selects WHICH loaded project to query: the `ProjectManager` restricts the
    /// fan-out to this project's store when set, or all loaded stores when
    /// omitted. It is NOT a per-row SQL predicate — a whole store is one project,
    /// so the per-store query no longer filters on `project_id`.
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
