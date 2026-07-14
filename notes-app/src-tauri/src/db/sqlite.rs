use std::path::Path;
use std::str::FromStr;

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions};
use sqlx::types::Json;
use sqlx::QueryBuilder;

use crate::error::{AppError, Result};
use crate::models::{Item, Kind, ListFilter, NewItem, Priority, Status, UpdateItem};

use super::ItemRepository;

pub struct SqliteRepository {
    pool: SqlitePool,
}

impl SqliteRepository {
    /// Open (or create) the database file and bring the schema up to date.
    pub async fn connect(db_path: &Path) -> Result<Self> {
        let options = SqliteConnectOptions::new()
            .filename(db_path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .foreign_keys(true);

        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await?;

        sqlx::migrate!("./migrations").run(&pool).await?;
        Ok(Self { pool })
    }

    /// In-memory database for tests. One connection only: every `:memory:`
    /// connection is its own database, so a pool of them would be N empty DBs.
    pub async fn connect_in_memory() -> Result<Self> {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .map_err(sqlx::Error::from)?;
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await?;
        sqlx::migrate!("./migrations").run(&pool).await?;
        Ok(Self { pool })
    }

    async fn fetch(&self, id: &str) -> Result<Item> {
        sqlx::query_as::<_, Item>("SELECT * FROM items WHERE id = ?1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or(AppError::NotFound)
    }
}

#[async_trait::async_trait]
impl ItemRepository for SqliteRepository {
    async fn list(&self, filter: &ListFilter) -> Result<Vec<Item>> {
        let mut qb = QueryBuilder::new("SELECT * FROM items WHERE archived = ");
        qb.push_bind(filter.archived.unwrap_or(false));
        if let Some(kind) = filter.kind {
            qb.push(" AND kind = ").push_bind(kind);
        }
        // rowid tiebreak: two saves in the same instant can produce equal
        // timestamps, and order must never depend on a coin flip.
        qb.push(" ORDER BY pinned DESC, updated_at DESC, rowid DESC");

        let items = qb.build_query_as::<Item>().fetch_all(&self.pool).await?;
        Ok(items)
    }

    async fn get(&self, id: &str) -> Result<Item> {
        self.fetch(id).await
    }

    async fn create(&self, input: NewItem) -> Result<Item> {
        let title = input.title.trim();
        if title.is_empty() {
            return Err(AppError::Invalid("title must not be empty".into()));
        }

        let now = chrono::Utc::now().to_rfc3339();
        let item = Item {
            id: uuid::Uuid::new_v4().to_string(),
            kind: input.kind,
            title: title.to_string(),
            body: input.body.unwrap_or_default(),
            // Tasks always carry a status; notes never do.
            status: match input.kind {
                Kind::Task => Some(input.status.unwrap_or(Status::Todo)),
                Kind::Note => None,
            },
            priority: match input.kind {
                Kind::Task => Some(input.priority.unwrap_or(Priority::Normal)),
                Kind::Note => None,
            },
            due_at: input.due_at.filter(|s| !s.is_empty()),
            tags: Json(input.tags.unwrap_or_default()),
            created_at: now.clone(),
            updated_at: now,
            archived: false,
            pinned: false,
        };

        sqlx::query(
            "INSERT INTO items \
             (id, kind, title, body, status, priority, due_at, tags, \
              created_at, updated_at, archived, pinned) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        )
        .bind(&item.id)
        .bind(item.kind)
        .bind(&item.title)
        .bind(&item.body)
        .bind(item.status)
        .bind(item.priority)
        .bind(&item.due_at)
        .bind(&item.tags)
        .bind(&item.created_at)
        .bind(&item.updated_at)
        .bind(item.archived)
        .bind(item.pinned)
        .execute(&self.pool)
        .await?;

        Ok(item)
    }

    async fn update(&self, id: &str, patch: UpdateItem) -> Result<Item> {
        // Read–merge–write keeps this free of dynamic SQL. At single-user
        // desktop scale the extra SELECT is irrelevant.
        let mut item = self.fetch(id).await?;
        // Only content edits refresh updated_at. Pinning and archiving are
        // meta-state — flipping them must not shove the item around the
        // recency order or lie about when it was last edited.
        let mut edited = false;

        if let Some(title) = patch.title {
            let title = title.trim().to_string();
            if title.is_empty() {
                return Err(AppError::Invalid("title must not be empty".into()));
            }
            item.title = title;
            edited = true;
        }
        if let Some(body) = patch.body {
            item.body = body;
            edited = true;
        }
        if item.kind == Kind::Task {
            if let Some(status) = patch.status {
                item.status = Some(status);
                edited = true;
            }
            if let Some(priority) = patch.priority {
                item.priority = Some(priority);
                edited = true;
            }
            if let Some(due) = patch.due_at {
                // Empty string clears the due date; anything else sets it.
                item.due_at = if due.is_empty() { None } else { Some(due) };
                edited = true;
            }
        }
        if let Some(tags) = patch.tags {
            item.tags = Json(tags);
            edited = true;
        }
        if let Some(archived) = patch.archived {
            item.archived = archived;
        }
        if let Some(pinned) = patch.pinned {
            item.pinned = pinned;
        }
        if edited {
            item.updated_at = chrono::Utc::now().to_rfc3339();
        }

        sqlx::query(
            "UPDATE items SET title = ?1, body = ?2, status = ?3, priority = ?4, \
             due_at = ?5, tags = ?6, updated_at = ?7, archived = ?8, pinned = ?9 \
             WHERE id = ?10",
        )
        .bind(&item.title)
        .bind(&item.body)
        .bind(item.status)
        .bind(item.priority)
        .bind(&item.due_at)
        .bind(&item.tags)
        .bind(&item.updated_at)
        .bind(item.archived)
        .bind(item.pinned)
        .bind(&item.id)
        .execute(&self.pool)
        .await?;

        Ok(item)
    }

    async fn delete(&self, id: &str) -> Result<()> {
        let result = sqlx::query("DELETE FROM items WHERE id = ?1")
            .bind(id)
            .execute(&self.pool)
            .await?;
        if result.rows_affected() == 0 {
            return Err(AppError::NotFound);
        }
        Ok(())
    }

    async fn search(&self, query: &str) -> Result<Vec<Item>> {
        let fts = fts_query(query);
        if fts.is_empty() {
            return self.list(&ListFilter::default()).await;
        }

        let items = sqlx::query_as::<_, Item>(
            "SELECT i.* FROM items i \
             JOIN items_fts ON items_fts.rowid = i.rowid \
             WHERE items_fts MATCH ?1 AND i.archived = 0 \
             ORDER BY rank",
        )
        .bind(fts)
        .fetch_all(&self.pool)
        .await?;
        Ok(items)
    }
}

/// Turn raw user input into a safe FTS5 query. Each whitespace-separated
/// term becomes a quoted prefix phrase, so characters that are FTS5 syntax
/// (quotes, `-`, `*`, parentheses) can't cause a query error — the user
/// typing `"` or `(` should never see "fts5: syntax error".
fn fts_query(input: &str) -> String {
    input
        .split_whitespace()
        .map(|term| format!("\"{}\"*", term.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" ")
}
