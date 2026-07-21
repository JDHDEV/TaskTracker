pub mod sqlite;

pub use sqlite::SqliteRepository;

/// The `PRAGMA application_id` marker stamped into every worknotes project DB
/// (0x574B4E54, "WKNT"). A file whose header carries any other value is refused
/// before migrations run (Section 4.3), so a foreign SQLite database can never
/// be adopted as a project store. Single source of truth: `migrations/0005_meta.sql`
/// sets the same integer literal, and a test asserts the two agree.
pub const WORKNOTES_APPLICATION_ID: i32 = 0x574B_4E54;

use crate::error::Result;
use crate::models::{
    Item, ListFilter, NewItem, NewPrompt, Prompt, PromptListFilter, PromptVersion, UpdateItem,
    UpdatePrompt,
};

/// The per-project storage contract — one instance per loaded project store.
/// Commands never depend on this directly; the `ProjectManager` owns the loaded
/// set, routes writes, and fans reads out across stores. Each impl owns its own
/// SQL — SQLite uses FTS5 for `search`, a Postgres impl would use `tsvector` —
/// and none of that leaks past this trait. Project CRUD and app settings are
/// NOT here: a whole store IS one project (identity lives in its `meta` table
/// and the app-level catalog), and settings live only in the catalog.
#[async_trait::async_trait]
pub trait ItemRepository: Send + Sync {
    async fn list(&self, filter: &ListFilter) -> Result<Vec<Item>>;
    async fn get(&self, id: &str) -> Result<Item>;
    /// Create an item in THIS store. `input.project_id` is the manager's routing
    /// key and is NOT persisted — the row's `project_id` stays NULL and the
    /// manager stamps the owning project's UUID onto the returned item.
    async fn create(&self, input: NewItem) -> Result<Item>;
    async fn update(&self, id: &str, patch: UpdateItem) -> Result<Item>;
    async fn delete(&self, id: &str) -> Result<()>;
    /// Full-text search over title and body, then the same post-filters as
    /// `list` (status/tags). Archived items are always excluded. Empty query
    /// falls back to `list(filter)`.
    async fn search(&self, query: &str, filter: &ListFilter) -> Result<Vec<Item>>;
    /// The derived tag vocabulary for THIS store: every distinct tag carried by
    /// at least one non-archived item that is not a done task, sorted. The
    /// manager unions these across loaded stores.
    async fn list_active_tags(&self) -> Result<Vec<String>>;
    /// Count of non-archived items in this store (for the project item-count
    /// chip) — a cheap `COUNT(*)`, never a full row fetch.
    async fn count_active(&self) -> Result<i64>;
    /// Release the store (SQLite: close the pool, freeing Windows file locks and
    /// WAL sidecars). Called on unload; after it returns the files are deletable.
    async fn close(&self);
}

/// The per-project PROMPT storage contract (plan.7) — implemented by the same
/// `SqliteRepository` that implements `ItemRepository`, over the same pool. Like
/// items, a whole store IS one project: `create`/`list` never persist a
/// `project_id` (the manager stamps ownership on return), and version ids +
/// timestamps are minted server-side (H2 — never client-supplied). Commands
/// depend on the `ProjectManager`, never on this trait directly.
#[async_trait::async_trait]
pub trait PromptRepository: Send + Sync {
    /// Prompts in THIS store (current view: the current version's title/body per
    /// prompt), newest-edited first. `filter.reusable_only` is the only filter;
    /// `filter.project_id` is the manager's routing key, not a per-row predicate.
    async fn list(&self, filter: &PromptListFilter) -> Result<Vec<Prompt>>;
    async fn get(&self, id: &str) -> Result<Prompt>;
    /// Mint a prompt + its first version. `input.project_id` is the routing key
    /// and is NOT persisted; ids/timestamps are backend-owned.
    async fn create(&self, input: NewPrompt) -> Result<Prompt>;
    /// Append a new immutable version iff `title`/`body` changed; rewrite the
    /// prompt head on a `reusable` change (no version, no `updatedAt` move).
    /// Never mutates or deletes an existing version file/row (H2).
    async fn update(&self, id: &str, patch: UpdatePrompt) -> Result<Prompt>;
    /// The full version history for one prompt, newest-first.
    async fn versions(&self, prompt_id: &str) -> Result<Vec<PromptVersion>>;
    /// Remove the prompt and all its versions (files + index rows).
    async fn delete(&self, id: &str) -> Result<()>;
    /// Count of prompts in this store (for the project prompt-count chip) — a
    /// cheap `COUNT(*)` over `prompts`, mirroring `count_active` for items. Counts
    /// prompts, not versions; the reusable flag does not filter it.
    async fn count_prompts(&self) -> Result<i64>;
    /// Import a prompt with its FULL version history VERBATIM (plan.8 move).
    /// Unlike `create` (which mints fresh ids and a single first version), this
    /// preserves the prompt `id`/`reusable`/`created_at`/`schema_version` and EACH
    /// version's `id`/`title`/`body`/`source`/`created_at` (the user chose an
    /// id-preserving move — byte-identical history). `prompt_schema_version` is the
    /// SOURCE head's marker, carried across so a cross-store move never re-stamps
    /// it to the current constant (plan.10 Step 6a). Writes `prompt.md` + one
    /// immutable version file per version into this store, then inserts the index
    /// rows in one transaction (files-then-index, parent-before-child). Modeled on
    /// `insert_item_verbatim`. Callers (`ProjectManager::move_prompt`) verify the
    /// imported history against the source before deleting the source.
    async fn import_prompt(
        &self,
        prompt_id: &str,
        reusable: bool,
        prompt_created_at: &str,
        prompt_schema_version: &str,
        versions: &[PromptVersion],
    ) -> Result<Prompt>;
}
