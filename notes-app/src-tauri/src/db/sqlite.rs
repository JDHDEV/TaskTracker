use std::path::{Path, PathBuf};
use std::str::FromStr;

use sqlx::sqlite::{Sqlite, SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions};
use sqlx::types::Json;
use sqlx::QueryBuilder;

use crate::error::{AppError, Result};
use crate::models::{Item, Kind, ListFilter, NewItem, Priority, Sort, Status, UpdateItem};
use crate::store::itemfile;

use super::ItemRepository;

/// Mint an RFC 3339 timestamp with fixed millisecond precision. `to_rfc3339()`
/// trims trailing fractional zeros (variable digit count), so lexical order only
/// equals chronological order when precision is pinned — a latent hazard masked
/// today by the `rowid` tiebreak (K10). Every timestamp minted here uses the
/// same width, keeping same-second items lexically comparable.
pub(crate) fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, false)
}

/// Largest project DB we will open. A DoS guard: `quick_check` reads every
/// page, so an attacker-supplied multi-gigabyte file must be rejected on size
/// before it is touched. Generous for a personal notes store.
const MAX_PROJECT_DB_BYTES: u64 = 512 * 1024 * 1024;

/// The tables a valid, fully-migrated worknotes project DB may contain.
/// `open_existing` refuses any table outside this set (FTS5 shadow tables
/// `items_fts*` and `sqlite_*` internals are allowed by prefix).
const KNOWN_TABLES: &[&str] = &[
    "items",
    "projects",
    "app_settings",
    "meta",
    "_sqlx_migrations",
    "items_fts",
];

/// The only triggers a worknotes project DB may contain (the FTS sync triggers).
const KNOWN_TRIGGERS: &[&str] = &["items_after_insert", "items_after_delete", "items_after_update"];

#[derive(Debug)]
pub struct SqliteRepository {
    pool: SqlitePool,
    /// When set (a Stage-2 loaded project), every write is mirrored into a
    /// canonical `<items_dir>/<id>.md` file BEFORE the index row is touched, so
    /// the git-tracked files are the source of truth and a crash leaves the file
    /// (rebuilt into the index on next load), never an index row with no file.
    /// `None` for the in-memory test repo, the legacy-migration copy path, and
    /// raw stores opened for hardening checks — those are index-only.
    items_dir: Option<PathBuf>,
}

impl SqliteRepository {
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
        Ok(Self { pool, items_dir: None })
    }

    /// Attach a canonical items directory so subsequent writes mirror to files
    /// (Stage 2). The manager calls this after opening/creating the index and
    /// before boxing the store to `dyn ItemRepository`. Consuming builder so the
    /// wrapped `Arc` stays immutable.
    pub(crate) fn with_items_dir(mut self, items_dir: PathBuf) -> Self {
        self.items_dir = Some(items_dir);
        self
    }

    /// Create a brand-new project DB at `path` and stamp its identity into
    /// `meta`. The file-CREATION primitive split out from open (Section 4.2):
    /// it refuses — never truncates or adopts — if a file already exists there.
    /// WAL sidecars spawn beside `path`, so callers must pass a path inside an
    /// already-validated project directory.
    pub async fn create_at(path: &Path, project_id: &str, project_name: &str) -> Result<Self> {
        if path.exists() {
            return Err(AppError::Invalid(
                "a project already exists in that folder".into(),
            ));
        }
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await
            .map_err(scrub_open_error)?;
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .map_err(scrub_migrate_error)?;

        // Stamp identity. schema_version = highest applied migration (read back,
        // so it stays correct as migrations are added) — informational; foreign
        // and newer-version detection use application_id + the sqlx migrator. All
        // four rows commit together so a crash mid-stamp can't leave a
        // half-identified store that later reads as foreign.
        let schema_version: i64 =
            sqlx::query_scalar("SELECT COALESCE(MAX(version), 0) FROM _sqlx_migrations")
                .fetch_one(&pool)
                .await
                .map_err(scrub_open_error)?;
        let mut tx = pool.begin().await.map_err(scrub_open_error)?;
        for (key, value) in [
            ("project_id", project_id.to_string()),
            ("project_name", project_name.to_string()),
            ("schema_version", schema_version.to_string()),
            ("created_at", now_rfc3339()),
        ] {
            sqlx::query("INSERT INTO meta (key, value) VALUES (?1, ?2)")
                .bind(key)
                .bind(value)
                .execute(&mut *tx)
                .await
                .map_err(scrub_open_error)?;
        }
        tx.commit().await.map_err(scrub_open_error)?;
        Ok(Self { pool, items_dir: None })
    }

    /// Open an EXISTING project DB, treating the file as untrusted input (it may
    /// arrive via a shared folder or git clone). Never creates. Before running
    /// any migration (Section 4.3): enforce a size cap, verify the worknotes
    /// `application_id`, run `quick_check`, and refuse any unknown trigger /
    /// view / table — all with `trusted_schema=OFF` and extension loading off
    /// (sqlx default). Only then migrate; a DB from a NEWER app version surfaces
    /// a clean message rather than a raw sqlx error.
    pub async fn open_existing(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Err(AppError::Invalid("no project found in that folder".into()));
        }
        let len = std::fs::metadata(path)
            .map_err(|_| AppError::Invalid("could not read that project file".into()))?
            .len();
        if len > MAX_PROJECT_DB_BYTES {
            return Err(AppError::Invalid(
                "that project file is too large to open".into(),
            ));
        }

        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(false)
            .journal_mode(SqliteJournalMode::Wal)
            .foreign_keys(true)
            .pragma("trusted_schema", "OFF");
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await
            .map_err(scrub_open_error)?;

        // --- Untrusted-input hardening, ALL before migrations ---
        // application_id: reject any file not stamped as a worknotes store. A
        // non-SQLite file typically fails this first query with "file is not a
        // database" — scrubbed to the same clean rejection.
        let app_id = sqlx::query_scalar::<_, i32>("PRAGMA application_id")
            .fetch_one(&pool)
            .await
            .map_err(|_| foreign_db_error())?;
        if app_id != super::WORKNOTES_APPLICATION_ID {
            return Err(foreign_db_error());
        }
        // quick_check: reject a corrupt file before migrations touch it.
        let check: String = sqlx::query_scalar("PRAGMA quick_check")
            .fetch_one(&pool)
            .await
            .map_err(|_| AppError::Invalid("that project file is corrupt".into()))?;
        if check != "ok" {
            return Err(AppError::Invalid("that project file is corrupt".into()));
        }
        // sqlite_master allowlist: refuse unexpected schema objects. FTS5 shadow
        // tables (items_fts*) and sqlite internals are allowed by prefix;
        // indexes are allowed because trusted_schema=OFF neutralizes any
        // schema-defined function they might reference.
        let objects = sqlx::query_as::<_, (String, String)>("SELECT type, name FROM sqlite_master")
            .fetch_all(&pool)
            .await
            .map_err(|_| foreign_db_error())?;
        for (kind, name) in &objects {
            let allowed = match kind.as_str() {
                "table" => {
                    KNOWN_TABLES.contains(&name.as_str())
                        || name.starts_with("items_fts")
                        || name.starts_with("sqlite_")
                }
                "trigger" => KNOWN_TRIGGERS.contains(&name.as_str()),
                "index" => true,
                _ => false, // views (worknotes has none) and anything unknown
            };
            if !allowed {
                return Err(foreign_db_error());
            }
        }

        // Only now migrate. A newer-version DB fails here → clean message.
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .map_err(scrub_migrate_error)?;
        Ok(Self { pool, items_dir: None })
    }

    /// Read the `(project_id, project_name)` the store was stamped with at
    /// creation. The manager calls this right after `open_existing` (before
    /// boxing to `dyn ItemRepository`) to reconcile the catalog by UUID. A
    /// worknotes-shaped file with no identity rows is refused as foreign.
    pub async fn read_meta(&self) -> Result<(String, String)> {
        match (
            self.meta_value("project_id").await?,
            self.meta_value("project_name").await?,
        ) {
            (Some(id), Some(name)) => Ok((id, name)),
            _ => Err(foreign_db_error()),
        }
    }

    async fn meta_value(&self, key: &str) -> Result<Option<String>> {
        let value = sqlx::query_scalar::<_, String>("SELECT value FROM meta WHERE key = ?1")
            .bind(key)
            .fetch_optional(&self.pool)
            .await
            .map_err(scrub_open_error)?;
        Ok(value)
    }

    /// Legacy-migration only: copy an existing row into THIS store with its id
    /// and timestamps intact (unlike `create`, which mints fresh ones).
    /// `project_id` is forced NULL per Decision 4 — an item's owner is the store
    /// it lives in. The FTS index syncs via the same triggers as any insert.
    pub(crate) async fn insert_item_verbatim(&self, item: &Item) -> Result<()> {
        sqlx::query(
            "INSERT INTO items \
             (id, kind, title, body, status, priority, due_at, tags, \
              created_at, updated_at, archived, pinned, project_id, jira_url) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, NULL, ?13)",
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
        .bind(&item.jira_url)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn fetch(&self, id: &str) -> Result<Item> {
        sqlx::query_as::<_, Item>("SELECT * FROM items WHERE id = ?1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or(AppError::NotFound)
    }

    /// Every row in the index, archived included, ordered deterministically —
    /// used by the Stage-1→Stage-2 export to write one canonical file per item.
    pub(crate) async fn all_items(&self) -> Result<Vec<Item>> {
        let items = sqlx::query_as::<_, Item>("SELECT * FROM items ORDER BY created_at, id")
            .fetch_all(&self.pool)
            .await?;
        Ok(items)
    }

    /// Rebuild the index from the canonical files (Stage 2 "scan-then-rebuild"):
    /// clear `items`, re-insert every file that parses, then rebuild the FTS
    /// index — all in one transaction, so a mid-rebuild failure leaves the prior
    /// index intact. Files are the source of truth, so anything on disk wins over
    /// whatever the index held. Returns a `(filename: reason)` warning per file
    /// that could not be imported (malformed / conflict markers / oversized /
    /// duplicate id) — partial success, never an abort (plan.6 step 18).
    pub(crate) async fn rebuild_from_dir(&self, items_dir: &Path) -> Result<Vec<String>> {
        let outcome = itemfile::scan(items_dir);
        let mut warnings: Vec<String> =
            outcome.errors.iter().map(|(name, e)| format!("{name}: {e}")).collect();

        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM items").execute(&mut *tx).await?;

        let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
        for item in &outcome.items {
            // A duplicate id can only arise from a copied file (same id, new
            // path); keep the first and report the rest rather than colliding on
            // the primary key and poisoning the transaction.
            if !seen.insert(item.id.as_str()) {
                warnings.push(format!("{}.md: duplicate item id, skipped", item.id));
                continue;
            }
            sqlx::query(
                "INSERT INTO items \
                 (id, kind, title, body, status, priority, due_at, tags, \
                  created_at, updated_at, archived, pinned, project_id, jira_url) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, NULL, ?13)",
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
            .bind(&item.jira_url)
            .execute(&mut *tx)
            .await?;
        }
        // External-content FTS: the triggers already synced each row above; the
        // explicit rebuild recomputes the whole index from `items` so any prior
        // drift (e.g. a stale sidecar) is repaired too.
        sqlx::query("INSERT INTO items_fts(items_fts) VALUES('rebuild')")
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(warnings)
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

    /// Force an item's id (mirrors `set_timestamps_for_test`) so the manager's
    /// cross-store id-collision behavior can be tested deterministically — two
    /// stores each holding an item with the same forced id. Changing `id` does
    /// not touch `rowid`, so the external-content FTS index stays consistent.
    pub async fn set_id_for_test(&self, old_id: &str, new_id: &str) -> Result<()> {
        sqlx::query("UPDATE items SET id = ?1 WHERE id = ?2")
            .bind(new_id)
            .bind(old_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Read back the DB header's `application_id`, so a test can assert the
    /// migration's stamped literal equals `db::WORKNOTES_APPLICATION_ID`.
    pub async fn application_id_for_test(&self) -> Result<i32> {
        let id = sqlx::query_scalar::<_, i32>("PRAGMA application_id")
            .fetch_one(&self.pool)
            .await?;
        Ok(id)
    }
}

/// Append the shared `list`/`search` filter predicates (kind, status,
/// OR-matched tags) to a query whose WHERE clause is already open. Deliberately
/// does NOT emit the `archived` predicate — `list()` honors `filter.archived`
/// while `search()` hardcodes `archived = 0` (D5a), so each caller supplies its
/// own. `filter.project_id` is NOT a predicate here: a whole store is one
/// project, so project scoping is the manager choosing which stores to query.
/// Every value is bound; the tag clause is skipped when the list is empty to
/// avoid the `IN ()` syntax error (D4).
fn push_filters(qb: &mut QueryBuilder<'_, Sqlite>, filter: &ListFilter) {
    if let Some(kind) = filter.kind {
        qb.push(" AND i.kind = ").push_bind(kind);
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
/// Frame: `pinned DESC` first, then `(created_at DESC, id ASC)` last;
/// Priority/Status bucket notes (NULL metric) last before the metric CASE.
///
/// The final tiebreak is `created_at DESC, id ASC`, NOT `rowid DESC`: rowids
/// collide across per-project files and are reassigned on any future index
/// rebuild, so they cannot order a merged multi-store set. `created_at` is
/// minted at fixed millisecond precision and `id` is a UUID, giving a
/// deterministic, machine-independent total order that the Rust k-way merge
/// comparator reproduces exactly.
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
    qb.push(", i.created_at DESC, i.id ASC");
}

#[async_trait::async_trait]
impl ItemRepository for SqliteRepository {
    async fn list(&self, filter: &ListFilter) -> Result<Vec<Item>> {
        // list() honors filter.archived (default false); search() will hardcode 0.
        let mut qb = QueryBuilder::new("SELECT i.* FROM items i WHERE i.archived = ");
        qb.push_bind(filter.archived.unwrap_or(false));
        push_filters(&mut qb, filter);
        // (created_at, id) tiebreak: two saves in the same instant can produce
        // equal timestamps, and order must never depend on a coin flip.
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

        // Empty string clears jira_url (→ NULL). project_id is NOT persisted:
        // `input.project_id` is the manager's routing key, and per-store rows
        // always store NULL (Decision 4) — the manager stamps the owning UUID.
        let jira_url = input.jira_url.filter(|s| !s.is_empty());
        if let Some(url) = &jira_url {
            validate_jira_url(url)?;
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
            // Always NULL in-store; the manager stamps the owning project UUID.
            project_id: None,
            jira_url,
        };

        // File-then-index (Stage 2): the canonical file is written before the
        // index row, so the git-tracked store is the source of truth.
        if let Some(dir) = &self.items_dir {
            itemfile::write_item(dir, &item).map_err(save_file_error)?;
        }

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
        // jira_url is a content edit on BOTH notes and tasks (D3), so it sits
        // outside the task-only gate above. Empty string clears (→ NULL), a
        // value sets, None leaves unchanged — the due_at template. (project_id
        // is no longer patchable: items do not move between stores in v1.)
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

        // File-then-index (Stage 2): mirror the merged item to its canonical file
        // before updating the index row.
        if let Some(dir) = &self.items_dir {
            itemfile::write_item(dir, &item).map_err(save_file_error)?;
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
        .await?;

        Ok(item)
    }

    async fn delete(&self, id: &str) -> Result<()> {
        // File-then-index (Stage 2): confirm the item exists (so an unknown id is
        // still a clean NotFound), remove its canonical file, then the index row.
        // A crash after the file is gone rebuilds an index without it — the file
        // removal is what "sticks", never a resurrected row.
        if let Some(dir) = &self.items_dir {
            self.fetch(id).await?;
            itemfile::remove_item(dir, id).map_err(save_file_error)?;
        }
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

    async fn count_active(&self) -> Result<i64> {
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM items WHERE archived = 0")
            .fetch_one(&self.pool)
            .await?;
        Ok(count)
    }

    async fn close(&self) {
        // Wait for checked-out connections to finish, then release the file and
        // its WAL sidecars so the store can be deleted (Windows locks the file
        // until every connection is closed).
        self.pool.close().await;
    }
}

/// The single clean rejection for any file that is not a valid worknotes
/// project store — foreign `application_id`, unknown schema object, missing
/// identity, or a non-SQLite file whose first PRAGMA fails. Deliberately says
/// nothing about the internal reason and never echoes the path (Section 4.6).
fn foreign_db_error() -> AppError {
    AppError::Invalid("that file is not a worknotes project".into())
}

/// Scrub a connect/open failure: never echo the raw SQLite text or the
/// filesystem path into the UI (Section 4.6).
fn scrub_open_error(_err: sqlx::Error) -> AppError {
    AppError::Invalid("could not open that project".into())
}

/// Map a canonical-file write/remove failure. `ItemFileError`'s message carries
/// only an `io::ErrorKind` word and field names — never a path or SQLite text —
/// so it is safe to surface (Section 4.6).
fn save_file_error(e: itemfile::ItemFileError) -> AppError {
    AppError::Invalid(format!("couldn't save the item to disk: {e}"))
}

/// Map a migration failure to a clean message. A DB carrying a migration our
/// binary doesn't know (`VersionMissing`) or a modified one (`VersionMismatch`)
/// was written by a newer worknotes; everything else is a generic open failure.
/// Raw sqlx/SQLite text and paths are never surfaced (Section 4.6).
fn scrub_migrate_error(err: sqlx::migrate::MigrateError) -> AppError {
    use sqlx::migrate::MigrateError;
    match err {
        MigrateError::VersionMissing(_) | MigrateError::VersionMismatch(_) => AppError::Invalid(
            "that project was created by a newer version of worknotes".into(),
        ),
        _ => AppError::Invalid("could not open that project".into()),
    }
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
