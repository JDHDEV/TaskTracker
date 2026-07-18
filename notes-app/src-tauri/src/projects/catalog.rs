//! The app-level catalog over `catalog.db` (Decision 2). It knows every project
//! the app has been shown — id, name, directory path, and whether it is loaded —
//! and hosts the relocated non-secret app settings. SQLite (not JSON) for atomic
//! writes and the global UNIQUE(name)/UNIQUE(path) the per-project stores can no
//! longer enforce across files.

use std::path::Path;

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions};

use crate::db::sqlite::now_rfc3339;
use crate::error::{AppError, Result};

/// A known project as recorded in the catalog. Internal to the backend — the
/// IPC-facing shape is `models::ProjectInfo`, assembled by the manager with a
/// live item count for loaded projects.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct CatalogProject {
    pub id: String,
    pub name: String,
    pub path: String,
    pub loaded: bool,
    pub last_opened: Option<String>,
}

pub struct Catalog {
    pool: SqlitePool,
}

impl Catalog {
    /// Open (creating if absent) the catalog and bring its own schema up to
    /// date. Always inside `app_data_dir`, never user-supplied, so it needs
    /// none of the foreign-DB hardening the per-project stores get.
    pub async fn open(db_path: &Path) -> Result<Self> {
        let options = SqliteConnectOptions::new()
            .filename(db_path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await?;
        sqlx::migrate!("./migrations_catalog").run(&pool).await?;
        Ok(Self { pool })
    }

    /// In-memory catalog for tests.
    #[cfg(any(test, feature = "test-support"))]
    pub async fn open_in_memory() -> Result<Self> {
        use std::str::FromStr;
        let options = SqliteConnectOptions::from_str("sqlite::memory:").map_err(sqlx::Error::from)?;
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await?;
        sqlx::migrate!("./migrations_catalog").run(&pool).await?;
        Ok(Self { pool })
    }

    /// Every known project, loaded or not, ordered by name.
    pub async fn list(&self) -> Result<Vec<CatalogProject>> {
        let rows = sqlx::query_as::<_, CatalogProject>(
            "SELECT id, name, path, loaded, last_opened FROM projects ORDER BY name",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    pub async fn get(&self, id: &str) -> Result<Option<CatalogProject>> {
        let row = sqlx::query_as::<_, CatalogProject>(
            "SELECT id, name, path, loaded, last_opened FROM projects WHERE id = ?1",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row)
    }

    /// Insert a new project row (loaded). UNIQUE(name)/UNIQUE(path) violations
    /// map to clean, storage-agnostic messages — no raw SQLite text.
    pub async fn insert(&self, id: &str, name: &str, path: &str) -> Result<()> {
        sqlx::query(
            "INSERT INTO projects (id, name, path, loaded, last_opened) \
             VALUES (?1, ?2, ?3, 1, ?4)",
        )
        .bind(id)
        .bind(name)
        .bind(path)
        .bind(now_rfc3339())
        .execute(&self.pool)
        .await
        .map_err(|e| map_unique(e, name))?;
        Ok(())
    }

    /// Commit a completed legacy migration atomically: insert every migrated
    /// project row, relocate the settings, and set the done-marker — all in ONE
    /// transaction. Either the whole catalog reflects the migration or none of
    /// it does, so a crash or a clash never leaves a partial catalog to collide
    /// with on the next attempt (the only leftovers are orphan dirs). Each
    /// `projects` tuple is `(id, name, path)`.
    pub async fn commit_migration(
        &self,
        projects: &[(String, String, String)],
        settings: &[(String, String)],
        marker_key: &str,
    ) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        for (id, name, path) in projects {
            sqlx::query(
                "INSERT INTO projects (id, name, path, loaded, last_opened) VALUES (?1, ?2, ?3, 1, ?4)",
            )
            .bind(id)
            .bind(name)
            .bind(path)
            .bind(now_rfc3339())
            .execute(&mut *tx)
            .await
            .map_err(|e| map_unique(e, name))?;
        }
        for (key, value) in settings {
            sqlx::query(
                "INSERT INTO app_settings (key, value) VALUES (?1, ?2) \
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            )
            .bind(key)
            .bind(value)
            .execute(&mut *tx)
            .await?;
        }
        sqlx::query(
            "INSERT INTO app_settings (key, value) VALUES (?1, '1') \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind(marker_key)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    /// Reconcile a moved file: point an existing project at a new directory.
    pub async fn set_path(&self, id: &str, path: &str) -> Result<()> {
        sqlx::query("UPDATE projects SET path = ?1 WHERE id = ?2")
            .bind(path)
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|e| map_unique(e, ""))?;
        Ok(())
    }

    /// Flip the loaded flag; stamp `last_opened` when (re)loading.
    pub async fn set_loaded(&self, id: &str, loaded: bool) -> Result<()> {
        if loaded {
            sqlx::query("UPDATE projects SET loaded = 1, last_opened = ?1 WHERE id = ?2")
                .bind(now_rfc3339())
                .bind(id)
                .execute(&self.pool)
                .await?;
        } else {
            sqlx::query("UPDATE projects SET loaded = 0 WHERE id = ?1")
                .bind(id)
                .execute(&self.pool)
                .await?;
        }
        Ok(())
    }

    /// Remove a project row (Forget / after Delete-files). Idempotent-friendly:
    /// a missing id is not an error here — the caller decides NotFound.
    pub async fn remove(&self, id: &str) -> Result<()> {
        sqlx::query("DELETE FROM projects WHERE id = ?1")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn get_setting(&self, key: &str) -> Result<Option<String>> {
        let value = sqlx::query_scalar::<_, String>("SELECT value FROM app_settings WHERE key = ?1")
            .bind(key)
            .fetch_optional(&self.pool)
            .await?;
        Ok(value)
    }

    pub async fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        sqlx::query(
            "INSERT INTO app_settings (key, value) VALUES (?1, ?2) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind(key)
        .bind(value)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

/// Map a UNIQUE-constraint violation to a clean message, distinguishing the
/// name clash from the path clash by inspecting (but never surfacing) the raw
/// constraint text. Any other error passes through.
fn map_unique(err: sqlx::Error, name: &str) -> AppError {
    if let sqlx::Error::Database(db) = &err {
        if db.is_unique_violation() {
            if db.message().contains(".path") {
                return AppError::Invalid("that folder is already a project".into());
            }
            return AppError::Invalid(format!("a project named \"{name}\" already exists"));
        }
    }
    AppError::from(err)
}
