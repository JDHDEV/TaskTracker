pub mod sqlite;

pub use sqlite::SqliteRepository;

use crate::error::Result;
use crate::models::{Item, ListFilter, NewItem, Project, ProjectWithCount, UpdateItem};

/// The storage swap point. Commands depend on `Arc<dyn ItemRepository>` and
/// nothing else, so moving to a cloud database is: write a second impl
/// (e.g. `PostgresRepository`), construct it in `lib.rs`, done. Each impl
/// owns its own SQL — SQLite uses FTS5 for `search`, a Postgres impl would
/// use `tsvector` — and none of that leaks past this trait.
#[async_trait::async_trait]
pub trait ItemRepository: Send + Sync {
    async fn list(&self, filter: &ListFilter) -> Result<Vec<Item>>;
    async fn get(&self, id: &str) -> Result<Item>;
    async fn create(&self, input: NewItem) -> Result<Item>;
    async fn update(&self, id: &str, patch: UpdateItem) -> Result<Item>;
    async fn delete(&self, id: &str) -> Result<()>;
    /// Full-text search over title and body, then the same post-filters as
    /// `list` (project/status/tags). Archived items are always excluded.
    /// Empty query falls back to `list(filter)`.
    async fn search(&self, query: &str, filter: &ListFilter) -> Result<Vec<Item>>;

    /// All projects with their item counts (archived items included), ordered
    /// by name.
    async fn list_projects(&self) -> Result<Vec<ProjectWithCount>>;
    /// Create a project. Name is trimmed; empty or duplicate names are rejected
    /// with `AppError::Invalid`.
    async fn create_project(&self, name: &str) -> Result<Project>;
    /// Rename a project. Empty/duplicate names → `Invalid`; unknown id →
    /// `NotFound`. Renaming to the project's own current name succeeds.
    async fn rename_project(&self, id: &str, name: &str) -> Result<Project>;
    /// Delete a project. Fails with `Invalid` while any item (archived included)
    /// still references it; unknown id → `NotFound`.
    async fn delete_project(&self, id: &str) -> Result<()>;
    /// The derived tag vocabulary: every distinct tag carried by at least one
    /// non-archived item that is not a done task, sorted.
    async fn list_active_tags(&self) -> Result<Vec<String>>;
}
