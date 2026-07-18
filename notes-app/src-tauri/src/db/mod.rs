pub mod sqlite;

pub use sqlite::SqliteRepository;

/// The `PRAGMA application_id` marker stamped into every worknotes project DB
/// (0x574B4E54, "WKNT"). A file whose header carries any other value is refused
/// before migrations run (Section 4.3), so a foreign SQLite database can never
/// be adopted as a project store. Single source of truth: `migrations/0005_meta.sql`
/// sets the same integer literal, and a test asserts the two agree.
pub const WORKNOTES_APPLICATION_ID: i32 = 0x574B_4E54;

use crate::error::Result;
use crate::models::{Item, ListFilter, NewItem, UpdateItem};

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
