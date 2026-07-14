pub mod sqlite;

pub use sqlite::SqliteRepository;

use crate::error::Result;
use crate::models::{Item, ListFilter, NewItem, UpdateItem};

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
    /// Full-text search over title and body. Empty query returns recent items.
    async fn search(&self, query: &str) -> Result<Vec<Item>>;
}
