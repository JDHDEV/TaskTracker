//! One-time, app-level migration of the pre-projects single `notes.db` into
//! per-project stores (Section 5 Architecture). NOT a sqlx migration — it is a
//! user-data move that runs once at startup, is idempotent via a catalog marker,
//! verifies its item count before committing, and preserves the original as a
//! `.bak`. Per-group failure rolls the whole attempt back so the next startup
//! retries cleanly against the untouched original.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

use crate::db::{ItemRepository, SqliteRepository};
use crate::error::{AppError, Result};
use crate::models::Item;

use super::catalog::Catalog;
use super::{GITIGNORE, LEGACY_DB_FILE};

/// Catalog `app_settings` key marking the legacy migration as done (also set on
/// a fresh install with no legacy DB, so we don't probe the filesystem forever).
const MIGRATED_KEY: &str = "legacy_migrated";

/// Migrate `legacy_db` into per-project stores under `<app_data_dir>/projects/`,
/// once. Safe to call on every startup: a no-op after the first success (or when
/// there is nothing to migrate).
pub async fn migrate_if_needed(
    catalog: &Catalog,
    app_data_dir: &Path,
    legacy_db: &Path,
) -> Result<()> {
    if catalog.get_setting(MIGRATED_KEY).await?.is_some() {
        return Ok(());
    }
    if !legacy_db.exists() {
        // Fresh install: nothing to migrate — mark done so we stop probing.
        catalog.set_setting(MIGRATED_KEY, "1").await?;
        return Ok(());
    }

    // Read the legacy DB (no migrations run against it — we only read).
    let options = SqliteConnectOptions::new()
        .filename(legacy_db)
        .create_if_missing(false);
    let legacy_pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|_| AppError::Invalid("couldn't open the existing notes database to migrate it".into()))?;

    let read_err =
        || AppError::Invalid("couldn't read the existing notes database to migrate it".into());
    // NOTE: reads assume `notes.db` is fully migrated (0001–0004) — true for any
    // DB this app has opened, since it runs migrations at startup. A behind-schema
    // legacy DB fails these reads and rolls back safely (no data loss).
    let items: Vec<Item> = sqlx::query_as::<_, Item>(
        "SELECT id, kind, title, body, status, priority, due_at, tags, \
         created_at, updated_at, archived, pinned, project_id, jira_url FROM items",
    )
    .fetch_all(&legacy_pool)
    .await
    .map_err(|_| read_err())?;
    let projects: Vec<(String, String)> = sqlx::query_as("SELECT id, name FROM projects")
        .fetch_all(&legacy_pool)
        .await
        .map_err(|_| read_err())?;
    let settings: Vec<(String, String)> = sqlx::query_as("SELECT key, value FROM app_settings")
        .fetch_all(&legacy_pool)
        .await
        .map_err(|_| read_err())?;
    legacy_pool.close().await;

    let source_total = items.len();

    // One destination per legacy project row (empty projects included), plus a
    // "Personal" store for items with no project OR an orphaned project_id (an
    // FK pointing at no surviving project row) — so EVERY source item is placed
    // and `copied == source_total` always reconciles for intact source data.
    let known_ids: HashSet<&str> = projects.iter().map(|(id, _)| id.as_str()).collect();
    let personal_name = if projects.iter().any(|(_, n)| n == "Personal") {
        "Personal (unfiled)"
    } else {
        "Personal"
    };
    let mut groups: Vec<(String, Vec<Item>)> = Vec::new();
    for (pid, name) in &projects {
        let group = items
            .iter()
            .filter(|i| i.project_id.as_deref() == Some(pid.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        groups.push((name.clone(), group));
    }
    let personal: Vec<Item> = items
        .iter()
        .filter(|i| match i.project_id.as_deref() {
            None => true,
            Some(pid) => !known_ids.contains(pid),
        })
        .cloned()
        .collect();
    if !personal.is_empty() {
        groups.push((personal_name.to_string(), personal));
    }

    let projects_home = app_data_dir.join("projects");
    std::fs::create_dir_all(&projects_home)
        .map_err(|_| AppError::Invalid("couldn't create the projects folder".into()))?;

    // Build every per-project store FIRST — no catalog writes yet, so a crash or
    // clash mid-build leaves nothing in the catalog to collide with on retry.
    let mut created: Vec<Created> = Vec::new();
    let mut copied = 0usize;
    let mut failure: Option<AppError> = None;
    for (name, group) in &groups {
        match copy_group(&projects_home, name, group).await {
            Ok(rec) => {
                copied += group.len();
                created.push(rec);
            }
            Err(e) => {
                failure = Some(e);
                break;
            }
        }
    }

    // Commit the catalog ATOMICALLY (all project rows + relocated settings + the
    // done-marker in one transaction) only when every item copied; otherwise roll
    // this attempt back (delete the freshly-created dirs) so the next startup
    // retries against the still-intact original with a clean catalog.
    if failure.is_none() && copied == source_total {
        let rows: Vec<(String, String, String)> = created
            .iter()
            .map(|c| (c.id.clone(), c.name.clone(), c.dir.to_string_lossy().to_string()))
            .collect();
        match catalog.commit_migration(&rows, &settings, MIGRATED_KEY).await {
            Ok(()) => {
                let backup_name = format!(
                    "{}.pre-projects.bak",
                    legacy_db.file_name().and_then(|s| s.to_str()).unwrap_or("notes.db")
                );
                // Marker is committed above, so a failed rename can't cause a
                // re-migration — it only leaves the (now-ignored) original in place.
                let _ = std::fs::rename(legacy_db, legacy_db.with_file_name(backup_name));
                return Ok(());
            }
            Err(e) => failure = Some(e),
        }
    }

    for rec in &created {
        let _ = std::fs::remove_dir_all(&rec.dir);
    }
    Err(failure.unwrap_or_else(|| {
        AppError::Invalid("project migration was incomplete; your original notes were left untouched".into())
    }))
}

struct Created {
    id: String,
    name: String,
    dir: PathBuf,
}

/// Create one project store and copy its items verbatim (ids/timestamps intact).
/// No catalog write here — the caller commits the catalog atomically once every
/// group succeeds. Any failure cleans up its own partial files before returning.
async fn copy_group(projects_home: &Path, name: &str, items: &[Item]) -> Result<Created> {
    let dir = unique_dir(projects_home, name);
    std::fs::create_dir_all(&dir)
        .map_err(|_| AppError::Invalid("couldn't write the migrated project files".into()))?;

    let project_id = uuid::Uuid::new_v4().to_string();
    let db_path = dir.join(LEGACY_DB_FILE);
    let repo = match SqliteRepository::create_at(&db_path, &project_id, name).await {
        Ok(repo) => repo,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(e);
        }
    };
    let _ = std::fs::write(dir.join(".gitignore"), GITIGNORE);

    for item in items {
        // Scrub any raw sqlx text (Section 4.6) rather than surfacing it.
        if repo.insert_item_verbatim(item).await.is_err() {
            repo.close().await;
            let _ = std::fs::remove_dir_all(&dir);
            return Err(AppError::Invalid("couldn't copy items while migrating".into()));
        }
    }
    repo.close().await; // startup_load reopens it fresh; keep it unlocked

    Ok(Created { id: project_id, name: name.to_string(), dir })
}

/// A filesystem-safe, collision-free directory under `home` for a project name.
fn unique_dir(home: &Path, name: &str) -> PathBuf {
    let base = safe_dir_name(name);
    let mut dir = home.join(&base);
    let mut n = 2;
    while dir.exists() {
        dir = home.join(format!("{base}-{n}"));
        n += 1;
    }
    dir
}

/// Keep only characters that are safe in a Windows directory name; collapse the
/// rest to `_`. Never derives a store filename from the name (that stays the
/// fixed `project.db`) — this is only the human-friendly containing folder.
fn safe_dir_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.') { c } else { '_' })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        "project".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ListFilter;
    use tempfile::tempdir;

    /// Build a fixture single-DB "legacy" notes.db with two projects (Alpha with
    /// 2 items, Beta with 1), two project-less items, and a JIRA setting.
    async fn seed_legacy(path: &Path) {
        let options = SqliteConnectOptions::new().filename(path).create_if_missing(true);
        let pool = SqlitePoolOptions::new().max_connections(1).connect_with(options).await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();

        for (id, name) in [("pa", "Alpha"), ("pb", "Beta")] {
            sqlx::query("INSERT INTO projects (id, name, created_at) VALUES (?1, ?2, ?3)")
                .bind(id)
                .bind(name)
                .bind("2026-01-01T00:00:00.000+00:00")
                .execute(&pool)
                .await
                .unwrap();
        }
        // (id, title, project_id)
        let rows = [
            ("i1", "alpha one", Some("pa")),
            ("i2", "alpha two", Some("pa")),
            ("i3", "beta one", Some("pb")),
            ("i4", "loose one", None),
            ("i5", "loose two", None),
        ];
        for (id, title, pid) in rows {
            sqlx::query(
                "INSERT INTO items \
                 (id, kind, title, body, status, priority, due_at, tags, created_at, updated_at, \
                  archived, pinned, project_id, jira_url) \
                 VALUES (?1, 'note', ?2, '', NULL, NULL, NULL, '[\"work\"]', \
                 '2026-01-02T00:00:00.000+00:00', '2026-01-02T00:00:00.000+00:00', 0, 0, ?3, NULL)",
            )
            .bind(id)
            .bind(title)
            .bind(pid)
            .execute(&pool)
            .await
            .unwrap();
        }
        sqlx::query("INSERT INTO app_settings (key, value) VALUES ('jira_config', 'cfg-json')")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
    }

    async fn count_items(dir: &Path) -> usize {
        let repo = SqliteRepository::open_existing(&dir.join(LEGACY_DB_FILE)).await.unwrap();
        let n = repo.list(&ListFilter::default()).await.unwrap().len();
        repo.close().await;
        n
    }

    #[tokio::test]
    async fn migrates_splits_counts_settings_and_is_idempotent() {
        let app_data = tempdir().unwrap();
        let legacy = app_data.path().join("notes.db");
        seed_legacy(&legacy).await;

        let catalog = Catalog::open_in_memory().await.unwrap();
        migrate_if_needed(&catalog, app_data.path(), &legacy).await.unwrap();

        // three projects: Alpha, Beta, Personal
        let rows = catalog.list().await.unwrap();
        let names: Vec<&str> = rows.iter().map(|r| r.name.as_str()).collect();
        assert!(names.contains(&"Alpha") && names.contains(&"Beta") && names.contains(&"Personal"));
        assert_eq!(rows.len(), 3);

        // item counts split correctly; NULL-project items land in Personal
        for row in &rows {
            let n = count_items(Path::new(&row.path)).await;
            match row.name.as_str() {
                "Alpha" => assert_eq!(n, 2),
                "Beta" => assert_eq!(n, 1),
                "Personal" => assert_eq!(n, 2),
                other => panic!("unexpected project {other}"),
            }
        }

        // legacy JIRA settings copied into the catalog
        assert_eq!(catalog.get_setting("jira_config").await.unwrap().as_deref(), Some("cfg-json"));

        // original preserved as a backup, source gone
        assert!(!legacy.exists());
        assert!(legacy.with_file_name("notes.db.pre-projects.bak").exists());

        // rerun is a no-op (marker set, source gone) — still exactly three projects
        migrate_if_needed(&catalog, app_data.path(), &legacy).await.unwrap();
        assert_eq!(catalog.list().await.unwrap().len(), 3);
    }

    #[tokio::test]
    async fn fresh_install_marks_done_without_a_legacy_db() {
        let app_data = tempdir().unwrap();
        let catalog = Catalog::open_in_memory().await.unwrap();
        migrate_if_needed(&catalog, app_data.path(), &app_data.path().join("notes.db"))
            .await
            .unwrap();
        assert!(catalog.list().await.unwrap().is_empty());
        // marker set, so a later run stays a no-op
        assert!(catalog.get_setting(MIGRATED_KEY).await.unwrap().is_some());
    }
}
