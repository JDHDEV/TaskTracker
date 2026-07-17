use std::path::Path;
use std::str::FromStr;

use sqlx::sqlite::{Sqlite, SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions};
use sqlx::types::Json;
use sqlx::QueryBuilder;

use crate::error::{AppError, Result};
use crate::models::{
    Item, Kind, ListFilter, NewItem, Priority, Project, ProjectWithCount, Sort, Status, UpdateItem,
};

use super::ItemRepository;

/// Mint an RFC 3339 timestamp with fixed millisecond precision. `to_rfc3339()`
/// trims trailing fractional zeros (variable digit count), so lexical order only
/// equals chronological order when precision is pinned — a latent hazard masked
/// today by the `rowid` tiebreak (K10). Every timestamp minted here uses the
/// same width, keeping same-second items lexically comparable.
fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, false)
}

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

    /// Reject a `project_id` that names no existing project with a clean
    /// `Invalid`, so the raw `FOREIGN KEY constraint failed` DB text never
    /// leaks past the trait (D2a).
    async fn ensure_project_exists(&self, project_id: &str) -> Result<()> {
        let found = sqlx::query_scalar::<_, i64>("SELECT 1 FROM projects WHERE id = ?1")
            .bind(project_id)
            .fetch_optional(&self.pool)
            .await?;
        if found.is_none() {
            return Err(AppError::Invalid("no such project".into()));
        }
        Ok(())
    }
}

/// Test-only seam: force an item's timestamps so the `rowid DESC` tiebreak can
/// be tested against equal timestamps deterministically (production timestamps
/// come from `Utc::now()`). Gated behind the `test-support` feature so it never
/// ships in release builds.
#[cfg(feature = "test-support")]
impl SqliteRepository {
    pub async fn set_timestamps_for_test(
        &self,
        id: &str,
        created_at: &str,
        updated_at: &str,
    ) -> Result<()> {
        sqlx::query("UPDATE items SET created_at = ?1, updated_at = ?2 WHERE id = ?3")
            .bind(created_at)
            .bind(updated_at)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}

/// Append the shared `list`/`search` filter predicates (kind, project, status,
/// OR-matched tags) to a query whose WHERE clause is already open. Deliberately
/// does NOT emit the `archived` predicate — `list()` honors `filter.archived`
/// while `search()` hardcodes `archived = 0` (D5a), so each caller supplies its
/// own. Every value is bound; the tag clause is skipped when the list is empty
/// to avoid the `IN ()` syntax error (D4).
fn push_filters(qb: &mut QueryBuilder<'_, Sqlite>, filter: &ListFilter) {
    if let Some(kind) = filter.kind {
        qb.push(" AND i.kind = ").push_bind(kind);
    }
    if let Some(project_id) = &filter.project_id {
        qb.push(" AND i.project_id = ").push_bind(project_id.clone());
    }
    if let Some(status) = filter.status {
        qb.push(" AND i.status = ").push_bind(status);
    }
    if let Some(tags) = &filter.tags {
        if !tags.is_empty() {
            qb.push(" AND EXISTS (SELECT 1 FROM json_each(i.tags) je WHERE je.value IN (");
            let mut sep = qb.separated(", ");
            for tag in tags {
                sep.push_bind(tag.clone());
            }
            qb.push("))");
        }
    }
}

/// Append the `ORDER BY` for the list sort mode. Sort keys are static SQL
/// literals chosen by a `match` on the closed `Sort` enum — never user text.
/// Frame: `pinned DESC` first, `rowid DESC` last; Priority/Status bucket notes
/// (NULL metric) last before the metric CASE.
fn push_sort(qb: &mut QueryBuilder<'_, Sqlite>, sort: Sort) {
    qb.push(" ORDER BY i.pinned DESC");
    match sort {
        Sort::Updated => {
            qb.push(", i.updated_at DESC");
        }
        Sort::Created => {
            qb.push(", i.created_at DESC");
        }
        Sort::Priority => {
            qb.push(", CASE WHEN i.kind = 'note' THEN 1 ELSE 0 END");
            qb.push(
                ", CASE i.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 \
                 WHEN 'low' THEN 2 ELSE 3 END",
            );
        }
        Sort::Status => {
            qb.push(", CASE WHEN i.kind = 'note' THEN 1 ELSE 0 END");
            qb.push(
                ", CASE i.status WHEN 'doing' THEN 0 WHEN 'todo' THEN 1 \
                 WHEN 'done' THEN 2 ELSE 3 END",
            );
        }
    }
    qb.push(", i.rowid DESC");
}

#[async_trait::async_trait]
impl ItemRepository for SqliteRepository {
    async fn list(&self, filter: &ListFilter) -> Result<Vec<Item>> {
        // list() honors filter.archived (default false); search() will hardcode 0.
        let mut qb = QueryBuilder::new("SELECT i.* FROM items i WHERE i.archived = ");
        qb.push_bind(filter.archived.unwrap_or(false));
        push_filters(&mut qb, filter);
        // rowid tiebreak: two saves in the same instant can produce equal
        // timestamps, and order must never depend on a coin flip.
        push_sort(&mut qb, filter.sort.unwrap_or(Sort::Updated));

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

        // Empty string clears (→ NULL); project_id/jira_url apply to both kinds.
        let project_id = input.project_id.filter(|s| !s.is_empty());
        let jira_url = input.jira_url.filter(|s| !s.is_empty());
        if let Some(url) = &jira_url {
            validate_jira_url(url)?;
        }
        if let Some(pid) = &project_id {
            self.ensure_project_exists(pid).await?;
        }

        let now = now_rfc3339();
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
            project_id,
            jira_url,
        };

        sqlx::query(
            "INSERT INTO items \
             (id, kind, title, body, status, priority, due_at, tags, \
              created_at, updated_at, archived, pinned, project_id, jira_url) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
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
        .bind(&item.project_id)
        .bind(&item.jira_url)
        .execute(&self.pool)
        .await
        .map_err(map_fk_violation)?;

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
        // project_id/jira_url are content edits on BOTH notes and tasks (D3), so
        // they sit outside the task-only gate above. Empty string clears (→ NULL),
        // a value sets, None leaves unchanged — the due_at template.
        if let Some(project_id) = patch.project_id {
            let normalized = if project_id.is_empty() {
                None
            } else {
                self.ensure_project_exists(&project_id).await?;
                Some(project_id)
            };
            item.project_id = normalized;
            edited = true;
        }
        if let Some(jira_url) = patch.jira_url {
            item.jira_url = if jira_url.is_empty() {
                None
            } else {
                validate_jira_url(&jira_url)?;
                Some(jira_url)
            };
            edited = true;
        }
        if let Some(archived) = patch.archived {
            item.archived = archived;
        }
        if let Some(pinned) = patch.pinned {
            item.pinned = pinned;
        }
        if edited {
            item.updated_at = now_rfc3339();
        }

        sqlx::query(
            "UPDATE items SET title = ?1, body = ?2, status = ?3, priority = ?4, \
             due_at = ?5, tags = ?6, updated_at = ?7, archived = ?8, pinned = ?9, \
             project_id = ?10, jira_url = ?11 \
             WHERE id = ?12",
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
        .bind(&item.project_id)
        .bind(&item.jira_url)
        .bind(&item.id)
        .execute(&self.pool)
        .await
        .map_err(map_fk_violation)?;

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

    async fn search(&self, query: &str, filter: &ListFilter) -> Result<Vec<Item>> {
        let fts = fts_query(query);
        if fts.is_empty() {
            // A cleared search box still respects an active filter.
            return self.list(filter).await;
        }

        let mut qb = QueryBuilder::new(
            "SELECT i.* FROM items i \
             JOIN items_fts ON items_fts.rowid = i.rowid \
             WHERE items_fts MATCH ",
        );
        qb.push_bind(fts);
        // Search ALWAYS excludes archived, regardless of filter.archived (D5a).
        qb.push(" AND i.archived = 0");
        push_filters(&mut qb, filter);
        // Relevance ordering is the point of search — no pinned/sort frame.
        qb.push(" ORDER BY rank");

        let items = qb.build_query_as::<Item>().fetch_all(&self.pool).await?;
        Ok(items)
    }

    async fn list_projects(&self) -> Result<Vec<ProjectWithCount>> {
        // COUNT(i.id), not COUNT(*): a LEFT JOIN yields one all-NULL row for a
        // zero-item project, which COUNT(*) would miscount as 1 (D7). Archived
        // items are counted too, so this agrees with the delete guard.
        let projects = sqlx::query_as::<_, ProjectWithCount>(
            "SELECT p.id, p.name, p.created_at, COUNT(i.id) AS item_count \
             FROM projects p \
             LEFT JOIN items i ON i.project_id = p.id \
             GROUP BY p.id, p.name, p.created_at \
             ORDER BY p.name",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(projects)
    }

    async fn create_project(&self, name: &str) -> Result<Project> {
        let name = name.trim();
        if name.is_empty() {
            return Err(AppError::Invalid("project name must not be empty".into()));
        }
        // Explicit pre-check for a clean message; the UNIQUE constraint is the
        // backstop and is also mapped to Invalid (D2) so no raw DB text leaks.
        let clash = sqlx::query_scalar::<_, i64>("SELECT 1 FROM projects WHERE name = ?1")
            .bind(name)
            .fetch_optional(&self.pool)
            .await?;
        if clash.is_some() {
            return Err(duplicate_name_error(name));
        }

        let project = Project {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.to_string(),
            created_at: now_rfc3339(),
        };
        sqlx::query("INSERT INTO projects (id, name, created_at) VALUES (?1, ?2, ?3)")
            .bind(&project.id)
            .bind(&project.name)
            .bind(&project.created_at)
            .execute(&self.pool)
            .await
            .map_err(|e| map_unique_violation(e, name))?;
        Ok(project)
    }

    async fn rename_project(&self, id: &str, name: &str) -> Result<Project> {
        let name = name.trim();
        if name.is_empty() {
            return Err(AppError::Invalid("project name must not be empty".into()));
        }
        // Exclude the row being renamed so renaming to its own name is a no-op
        // that succeeds rather than a self-collision (D2).
        let clash = sqlx::query_scalar::<_, i64>(
            "SELECT 1 FROM projects WHERE name = ?1 AND id <> ?2",
        )
        .bind(name)
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        if clash.is_some() {
            return Err(duplicate_name_error(name));
        }

        let result = sqlx::query("UPDATE projects SET name = ?1 WHERE id = ?2")
            .bind(name)
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|e| map_unique_violation(e, name))?;
        if result.rows_affected() == 0 {
            return Err(AppError::NotFound);
        }

        sqlx::query_as::<_, Project>("SELECT id, name, created_at FROM projects WHERE id = ?1")
            .bind(id)
            .fetch_one(&self.pool)
            .await
            .map_err(AppError::from)
    }

    async fn delete_project(&self, id: &str) -> Result<()> {
        // Count-then-delete in one transaction so a concurrent assignment can't
        // slip an item in between (D6). BEGIN IMMEDIATE takes the write lock up
        // front, so the COUNT reads under the same lock the DELETE writes under
        // — no deferred-lock upgrade that could surface as a raw "database is
        // locked" error. The COUNT guard is authoritative (it carries the
        // friendly message); the FK is defense-in-depth.
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        // Archived items still reference the project, so count them too.
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM items WHERE project_id = ?1")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
        if count > 0 {
            // Dropping tx rolls back; nothing was deleted.
            return Err(AppError::Invalid(format!(
                "project still has {count} items assigned"
            )));
        }
        let result = sqlx::query("DELETE FROM projects WHERE id = ?1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        if result.rows_affected() == 0 {
            // Distinguishes "no such project" from "project with 0 items".
            return Err(AppError::NotFound);
        }
        tx.commit().await?;
        Ok(())
    }

    async fn list_active_tags(&self) -> Result<Vec<String>> {
        // A tag is live while ≥1 non-archived, non-done-task item carries it.
        // json_each('[]') yields zero rows, so empty tag arrays contribute
        // nothing. NOT (task AND done) keeps notes (NULL status) under 3-valued
        // logic and drops only done tasks.
        let tags = sqlx::query_scalar::<_, String>(
            "SELECT DISTINCT je.value \
             FROM items i, json_each(i.tags) je \
             WHERE i.archived = 0 AND NOT (i.kind = 'task' AND i.status = 'done') \
             ORDER BY je.value",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(tags)
    }
}

/// Clean, storage-agnostic duplicate-name error (never leaks the raw SQLite
/// `UNIQUE constraint failed: projects.name` text).
fn duplicate_name_error(name: &str) -> AppError {
    AppError::Invalid(format!("a project named \"{name}\" already exists"))
}

/// Map a UNIQUE-constraint DB error to the clean duplicate-name Invalid; pass
/// anything else through unchanged. Backstops the explicit pre-check against a
/// TOCTOU race (D2).
fn map_unique_violation(err: sqlx::Error, name: &str) -> AppError {
    if let sqlx::Error::Database(db) = &err {
        if db.is_unique_violation() {
            return duplicate_name_error(name);
        }
    }
    AppError::from(err)
}

/// Backstop the `ensure_project_exists` pre-check: if a project is deleted
/// between the check and the write, the FK fires — map that to the same clean
/// Invalid rather than leaking raw `FOREIGN KEY constraint failed` (D2a). Pass
/// any other error through unchanged.
fn map_fk_violation(err: sqlx::Error) -> AppError {
    if let sqlx::Error::Database(db) = &err {
        if db.is_foreign_key_violation() {
            return AppError::Invalid("no such project".into());
        }
    }
    AppError::from(err)
}

/// Allowlist for `jira_url`: accept only an absolute `http`/`https` URL, so a
/// `javascript:`/`file:`/`data:` (or scheme-less) value can never reach the DB
/// and, from there, a future opener/enrichment sink. The scheme is matched
/// case-insensitively (RFC 3986 schemes are case-insensitive, so `HTTPS://…`
/// is valid), and at least one character must follow `://` (a bare `https://`
/// with no host is rejected). Callers apply this only to a non-empty value —
/// empty string clears the field over IPC and is exempt.
fn validate_jira_url(url: &str) -> Result<()> {
    let lower = url.to_ascii_lowercase();
    let host = lower
        .strip_prefix("http://")
        .or_else(|| lower.strip_prefix("https://"));
    match host {
        Some(rest) if !rest.is_empty() => Ok(()),
        _ => Err(AppError::Invalid("JIRA link must be an http(s) URL".into())),
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
