//! Integration tests for `ProjectManager` (plan.6, Section 8: "Integration Tests
//! (manager)" + "Unit Tests (creation/opening)"). Real SQLite throughout —
//! `Catalog::open_in_memory()` for the app-level catalog, real on-disk
//! `SqliteRepository` stores in `tempfile` temp dirs for every per-project
//! store (a project IS a directory; its lifecycle can't be tested against
//! `:memory:`).
//!
//! Path-validation containment gotcha: `validate_project_dir` rejects any
//! project directory inside `app_data_dir` except its `projects/` subtree, so
//! every test builds the manager's `app_data_dir` as ONE temp dir and creates
//! each project directory in a SEPARATE temp dir outside it.
//!
//! `paths.rs` already unit-tests path validation itself (UNC/device/`..`/ADS,
//! containment) — not duplicated here.

use std::path::Path;

use notes_app_lib::db::{ItemRepository, SqliteRepository};
use notes_app_lib::error::AppError;
use notes_app_lib::models::{
    Draft, DraftSurface, Kind, ListFilter, NewItem, NewPrompt, Priority, ProjectInfo, PromptListFilter, Sort,
    Status, UpdateItem, UpdatePrompt,
};
use notes_app_lib::projects::catalog::Catalog;
use notes_app_lib::projects::ProjectManager;
use notes_app_lib::store::itemfile;
use notes_app_lib::store::promptfile;

use tempfile::{tempdir, TempDir};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/// A manager with an in-memory catalog and a fresh `app_data_dir`. The
/// returned `TempDir` must be kept alive for the test's duration (it anchors
/// the manager's containment check).
async fn new_manager() -> (ProjectManager, TempDir) {
    let app = tempdir().unwrap();
    let catalog = Catalog::open_in_memory().await.unwrap();
    let mgr = ProjectManager::new(catalog, app.path().to_path_buf());
    (mgr, app)
}

/// Create a loaded project in its own temp dir OUTSIDE the manager's
/// `app_data_dir` (see the module-level path-validation note). The returned
/// `TempDir` must be kept alive as long as the project may be read from disk.
async fn create_project(mgr: &ProjectManager, name: &str) -> (ProjectInfo, TempDir) {
    let dir = tempdir().unwrap();
    let info = mgr.create_project(dir.path().to_str().unwrap(), name).await.unwrap();
    (info, dir)
}

fn new_item(project_id: &str, kind: Kind, title: &str) -> NewItem {
    NewItem {
        kind,
        title: title.into(),
        body: Some(String::new()),
        status: None,
        priority: None,
        due_at: None,
        tags: None,
        project_id: project_id.into(),
        jira_url: None,
    }
}

fn item_with_tags(project_id: &str, kind: Kind, title: &str, tags: &[&str]) -> NewItem {
    NewItem {
        tags: Some(tags.iter().map(|t| t.to_string()).collect()),
        ..new_item(project_id, kind, title)
    }
}

fn new_prompt(project_id: &str, title: &str, body: &str) -> NewPrompt {
    NewPrompt {
        project_id: project_id.into(),
        title: title.into(),
        body: Some(body.into()),
        reusable: None,
        source: None,
    }
}

/// Pin a prompt's DERIVED `updatedAt` (its current version's `created_at`) via a
/// SIDE connection to the project's own `index.db` — same idiom as
/// `secondary_loaded_project_content_edit_bumps_updated_at_but_pin_and_archive_do_not`
/// (~line 615), but for prompt versions: `set_prompt_version_timestamp_for_test`
/// is an inherent method on the concrete `SqliteRepository`, not on the
/// `PromptRepository` trait the manager routes through.
async fn pin_prompt_updated_at(mgr: &ProjectManager, project: &ProjectInfo, prompt_id: &str, ts: &str) {
    let version_id = mgr.prompt_versions(prompt_id).await.unwrap()[0].id.clone();
    let db_path = Path::new(&project.path).join("index.db");
    let side = SqliteRepository::open_existing(&db_path).await.unwrap();
    side.set_prompt_version_timestamp_for_test(&version_id, ts).await.unwrap();
    side.close().await;
}

/// Canonicalize and strip the `\\?\` verbatim prefix, mirroring what
/// `validate_project_dir` stores as a project's catalog path.
fn canonical_string(p: &Path) -> String {
    let c = std::fs::canonicalize(p).unwrap();
    c.to_string_lossy().trim_start_matches(r"\\?\").to_string()
}

/// The transferable store entries: the git-portable `project.json` identity, the
/// SQLite index plus its `-wal`/`-shm` sidecars, and `.gitignore`. The sidecars
/// MUST travel with the index — `pool.close()` does not reliably checkpoint the
/// WAL into the main file, so a copied `index.db` without its `-wal` can be
/// missing even the `application_id` header. But a sidecar may also have been
/// checkpointed away (then legitimately absent, its data already in the main
/// file), so each transfer tolerates a missing/vanished source. The canonical
/// `items/` tree rounds out a full copy.
const STORE_ENTRIES: &[&str] =
    &["project.json", "index.db", "index.db-wal", "index.db-shm", ".gitignore", "scratch.md"];

/// Copy a whole Stage-2 project directory (a project IS a directory) into
/// another — used by the copy/move reconciliation tests.
fn copy_store_files(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for name in STORE_ENTRIES {
        copy_if_present(&from.join(name), &to.join(name));
    }
    let items = from.join("items");
    if items.exists() {
        copy_dir_all(&items, &to.join("items"));
    }
}

fn copy_dir_all(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let src = entry.path();
        let dst = to.join(entry.file_name());
        if src.is_dir() {
            copy_dir_all(&src, &dst);
        } else {
            std::fs::copy(&src, &dst).unwrap();
        }
    }
}

/// Move the store into another dir, simulating the user relocating the project
/// folder. Leaves `from` storeless (its `index.db`/`items/` gone) so the manager
/// reconciles it as a move, not a copy.
fn move_store_files(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for name in STORE_ENTRIES {
        move_if_present(&from.join(name), &to.join(name));
    }
    let items = from.join("items");
    if items.exists() {
        fs_retry(|| std::fs::rename(&items, &to.join("items")));
    }
}

/// Copy `src`→`dst` if present, retrying transient errors; a missing/vanished
/// source is a no-op (a checkpointed-away sidecar's data is already in the main
/// index).
fn copy_if_present(src: &Path, dst: &Path) {
    if !src.exists() {
        return;
    }
    for _ in 0..40 {
        match std::fs::copy(src, dst) {
            Ok(_) => return,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(25)),
        }
    }
    let _ = std::fs::copy(src, dst);
}

/// Rename `src`→`dst` if present, retrying transient errors; a missing/vanished
/// source is a no-op (same sidecar reasoning as `copy_if_present`).
fn move_if_present(src: &Path, dst: &Path) {
    if !src.exists() {
        return;
    }
    for _ in 0..40 {
        match std::fs::rename(src, dst) {
            Ok(()) => return,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(25)),
        }
    }
    let _ = std::fs::rename(src, dst);
}

/// Retry a filesystem op that can transiently fail for a few dozen ms after a
/// SQLite pool closes on Windows (the OS holds a brief handle on the just-closed
/// store — WAL sidecar teardown / an AV or indexer scan). Mirrors the app's own
/// `remove_file_retrying`. Panics with the real error if it never succeeds.
fn fs_retry<F: FnMut() -> std::io::Result<()>>(mut op: F) {
    for _ in 0..40 {
        if op().is_ok() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    op().unwrap();
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

#[tokio::test]
async fn create_project_is_loaded_with_zero_items() {
    let (mgr, _app) = new_manager().await;
    let (info, _dir) = create_project(&mgr, "Alpha").await;

    assert!(info.loaded);
    assert_eq!(info.item_count, Some(0));
    assert_eq!(info.name, "Alpha");

    let listed = mgr.list_projects().await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, info.id);
    assert!(listed[0].loaded);
}

#[tokio::test]
async fn create_second_project_is_independent() {
    let (mgr, _app) = new_manager().await;
    let (a, _dir_a) = create_project(&mgr, "Alpha").await;
    let (b, _dir_b) = create_project(&mgr, "Beta").await;

    assert_ne!(a.id, b.id);
    let listed = mgr.list_projects().await.unwrap();
    assert_eq!(listed.len(), 2);
    // Catalog lists by name ascending.
    assert_eq!(listed[0].name, "Alpha");
    assert_eq!(listed[1].name, "Beta");
}

#[tokio::test]
async fn unload_flips_loaded_flag_and_frees_the_file() {
    let (mgr, _app) = new_manager().await;
    let (info, dir) = create_project(&mgr, "Alpha").await;

    mgr.unload(&info.id).await.unwrap();

    let listed = mgr.list_projects().await.unwrap();
    assert!(!listed[0].loaded);
    assert_eq!(listed[0].item_count, None);

    // The pool is closed on unload, so the store file becomes deletable — within
    // a brief window on Windows (the OS releases its transient handle shortly
    // after the close; see fs_retry).
    fs_retry(|| std::fs::remove_file(dir.path().join("index.db")));
}

#[tokio::test]
async fn unload_not_loaded_is_clean_not_found() {
    let (mgr, _app) = new_manager().await;
    let err = mgr.unload("does-not-exist").await.unwrap_err();
    assert!(matches!(err, AppError::NotFound));
}

#[tokio::test]
async fn double_load_same_folder_is_rejected() {
    let (mgr, _app) = new_manager().await;
    let dir = tempdir().unwrap();
    mgr.create_project(dir.path().to_str().unwrap(), "Alpha").await.unwrap();

    let err = mgr.open_project(dir.path().to_str().unwrap()).await.unwrap_err();
    match err {
        AppError::Invalid(msg) => assert!(msg.contains("already loaded"), "got: {msg}"),
        other => panic!("expected Invalid(\"...already loaded...\"), got {other:?}"),
    }
}

#[tokio::test]
async fn forget_requires_unload_first_then_leaves_files_and_is_reloadable() {
    let (mgr, _app) = new_manager().await;
    let (info, dir) = create_project(&mgr, "Alpha").await;

    let err = mgr.forget(&info.id).await.unwrap_err();
    assert!(matches!(err, AppError::Invalid(_)), "forget while loaded must be rejected");

    mgr.unload(&info.id).await.unwrap();
    mgr.forget(&info.id).await.unwrap();

    assert!(mgr.list_projects().await.unwrap().is_empty());
    assert!(dir.path().join("index.db").exists(), "forget must leave the files on disk");

    // Reloadable: opening the same folder re-adopts the same UUID.
    let reopened = mgr.open_project(dir.path().to_str().unwrap()).await.unwrap();
    assert_eq!(reopened.id, info.id);
    assert!(reopened.loaded);
}

#[tokio::test]
async fn delete_files_requires_unload_first_then_removes_store_and_catalog_row() {
    let (mgr, _app) = new_manager().await;
    let (info, dir) = create_project(&mgr, "Alpha").await;
    assert!(dir.path().join(".gitignore").exists(), "create_project generates a .gitignore");
    // Plan 13 §4 H3/M4: the scratch pad and its leftover temp file have no
    // umbrella directory, so the sweep must name them explicitly.
    mgr.set_scratch(&info.id, "will be swept by delete_files").await.unwrap();
    std::fs::write(dir.path().join(".scratch.md.tmp"), "leftover tmp from a crashed save").unwrap();

    let err = mgr.delete_files(&info.id).await.unwrap_err();
    assert!(matches!(err, AppError::Invalid(_)), "delete_files while loaded must be rejected");

    mgr.unload(&info.id).await.unwrap();
    mgr.delete_files(&info.id).await.unwrap();

    assert!(!dir.path().join("index.db").exists());
    assert!(!dir.path().join("index.db-wal").exists());
    assert!(!dir.path().join("index.db-shm").exists());
    assert!(!dir.path().join("items").exists(), "delete_files removes the canonical items/ dir");
    assert!(!dir.path().join(".gitignore").exists());
    assert!(!dir.path().join("scratch.md").exists(), "delete_files must remove scratch.md");
    assert!(!dir.path().join(".scratch.md.tmp").exists(), "delete_files must remove the leftover scratch tmp file");
    assert!(mgr.list_projects().await.unwrap().is_empty());
}
// ---------------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------------

/// Read a project's own `project_name` marker through a SIDE connection to its
/// `index.db` (the `pin_prompt_updated_at` idiom): `read_meta` is an inherent
/// method on the concrete store, not on the trait the manager routes through.
async fn store_name(project: &ProjectInfo) -> String {
    let db_path = Path::new(&project.path).join("index.db");
    let side = SqliteRepository::open_existing(&db_path).await.unwrap();
    let (_id, name) = side.read_meta().await.unwrap();
    side.close().await;
    name
}

/// The raw git-portable identity file, for asserting on `{id, name}`.
fn identity_text(project: &ProjectInfo) -> String {
    std::fs::read_to_string(Path::new(&project.path).join("project.json")).unwrap()
}

#[tokio::test]
async fn rename_moves_catalog_store_marker_and_identity_file_together() {
    // The whole point of the feature: a name lives in THREE places and they must
    // never drift. Leaving the marker stale is what made an edited project.json
    // look like it "did not take" — the catalog kept winning.
    let (mgr, _app) = new_manager().await;
    let (info, _dir) = create_project(&mgr, "Alpha").await;

    let renamed = mgr.rename(&info.id, "  Renamed  ").await.unwrap();

    assert_eq!(renamed.name, "Renamed", "the name is trimmed, like create_project");
    assert_eq!(renamed.id, info.id, "rename never mints a new identity");
    let listed = mgr.list_projects().await.unwrap();
    assert_eq!(listed[0].name, "Renamed", "the catalog row drives what the UI shows");
    assert_eq!(store_name(&info).await, "Renamed", "the store's own marker moves too");
    let identity = identity_text(&info);
    assert!(identity.contains("\"name\": \"Renamed\""), "project.json carries the new name");
    assert!(
        identity.contains(&format!("\"id\": \"{}\"", info.id)),
        "project.json keeps the ORIGINAL uuid: identity is the id, the name is a label"
    );
}

#[tokio::test]
async fn rename_survives_a_forget_and_reopen() {
    // The reported bug, as a regression test: renaming then forgetting and
    // reopening the folder used to resurrect the old name, because the fresh
    // catalog row was seeded from the store's stale `meta` marker.
    let (mgr, _app) = new_manager().await;
    let (info, dir) = create_project(&mgr, "Alpha").await;
    mgr.rename(&info.id, "Renamed").await.unwrap();
    mgr.unload(&info.id).await.unwrap();
    mgr.forget(&info.id).await.unwrap();

    let reopened = mgr.open_project(dir.path().to_str().unwrap()).await.unwrap();
    assert_eq!(reopened.name, "Renamed", "the rename must outlive the catalog row");
}

#[tokio::test]
async fn rename_survives_a_reopen_from_files_alone() {
    // The move-to-another-machine path: `index.db` is git-ignored and
    // rebuildable, so a folder that arrives without one resolves its name from
    // `project.json`. That file has to carry the rename or the old name comes
    // back on the new machine.
    let (mgr, _app) = new_manager().await;
    let (info, dir) = create_project(&mgr, "Alpha").await;
    mgr.rename(&info.id, "Renamed").await.unwrap();
    mgr.unload(&info.id).await.unwrap();
    mgr.forget(&info.id).await.unwrap();

    fs_retry(|| std::fs::remove_file(dir.path().join("index.db")));
    let _ = std::fs::remove_file(dir.path().join("index.db-wal"));
    let _ = std::fs::remove_file(dir.path().join("index.db-shm"));

    let reopened = mgr.open_project(dir.path().to_str().unwrap()).await.unwrap();
    assert_eq!(reopened.name, "Renamed", "project.json is the surviving name source");
    assert_eq!(reopened.id, info.id, "and the uuid travels with it");
}

#[tokio::test]
async fn rename_keeps_every_item_and_prompt_with_the_project() {
    // Items and prompts are owned by the STORE, not by the name, so a rename is
    // a pure relabel — nothing is reindexed and nothing is orphaned.
    let (mgr, _app) = new_manager().await;
    let (info, _dir) = create_project(&mgr, "Alpha").await;
    let item = mgr.create(new_item(&info.id, Kind::Note, "keep me")).await.unwrap();

    mgr.rename(&info.id, "Renamed").await.unwrap();

    let listed = mgr
        .list_all(&ListFilter { project_id: Some(info.id.clone()), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, item.id, "the item still belongs to the renamed project");
}

#[tokio::test]
async fn rename_to_a_name_another_project_holds_is_refused_and_writes_nothing() {
    // The catalog's global UNIQUE(name) is checked FIRST, so a clash leaves the
    // store marker and project.json untouched rather than half-renamed.
    let (mgr, _app) = new_manager().await;
    let (a, _dir_a) = create_project(&mgr, "Alpha").await;
    let (_b, _dir_b) = create_project(&mgr, "Beta").await;

    let err = mgr.rename(&a.id, "Beta").await.unwrap_err();
    assert!(matches!(err, AppError::Invalid(_)), "a duplicate name must be rejected");

    let listed = mgr.list_projects().await.unwrap();
    let still_a = listed.iter().find(|p| p.id == a.id).unwrap();
    assert_eq!(still_a.name, "Alpha", "the catalog row is unchanged");
    assert_eq!(store_name(&a).await, "Alpha", "the store marker was never touched");
    assert!(identity_text(&a).contains("\"name\": \"Alpha\""), "project.json was never touched");
}

#[tokio::test]
async fn rename_rejects_an_empty_or_whitespace_name() {
    let (mgr, _app) = new_manager().await;
    let (info, _dir) = create_project(&mgr, "Alpha").await;

    for blank in ["", "   "] {
        let err = mgr.rename(&info.id, blank).await.unwrap_err();
        assert!(matches!(err, AppError::Invalid(_)), "{blank:?} must be rejected");
    }
    assert_eq!(mgr.list_projects().await.unwrap()[0].name, "Alpha");
}

#[tokio::test]
async fn rename_requires_the_project_to_be_loaded() {
    // The `meta` write needs the store's open pool; opening a closed store just
    // to relabel it would re-run the foreign-DB hardening gate and take a lock.
    let (mgr, _app) = new_manager().await;
    let (info, _dir) = create_project(&mgr, "Alpha").await;
    mgr.unload(&info.id).await.unwrap();

    let err = mgr.rename(&info.id, "Renamed").await.unwrap_err();
    assert!(matches!(err, AppError::Invalid(_)), "renaming an unloaded project is rejected");
    assert_eq!(mgr.list_projects().await.unwrap()[0].name, "Alpha");
}

#[tokio::test]
async fn rename_to_the_same_name_is_a_no_op() {
    let (mgr, _app) = new_manager().await;
    let (info, _dir) = create_project(&mgr, "Alpha").await;

    let same = mgr.rename(&info.id, "Alpha").await.unwrap();
    assert_eq!(same.name, "Alpha", "renaming to the current name is not a UNIQUE clash");
}

#[tokio::test]
async fn rename_of_an_unknown_project_is_clean_not_found() {
    let (mgr, _app) = new_manager().await;
    let err = mgr.rename("no-such-project", "Renamed").await.unwrap_err();
    assert!(matches!(err, AppError::NotFound));
}


// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

#[tokio::test]
async fn create_lands_only_in_target_store() {
    let (mgr, _app) = new_manager().await;
    let (a, _dir_a) = create_project(&mgr, "Alpha").await;
    let (b, _dir_b) = create_project(&mgr, "Beta").await;

    let item_a = mgr.create(new_item(&a.id, Kind::Note, "in alpha")).await.unwrap();
    assert_eq!(item_a.project_id.as_deref(), Some(a.id.as_str()));

    let only_a = mgr
        .list_all(&ListFilter { project_id: Some(a.id.clone()), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(only_a.len(), 1);
    assert_eq!(only_a[0].id, item_a.id);

    let only_b = mgr
        .list_all(&ListFilter { project_id: Some(b.id.clone()), ..Default::default() })
        .await
        .unwrap();
    assert!(only_b.is_empty(), "an item created into A must never appear when scoped to B");
}

#[tokio::test]
async fn create_with_empty_project_id_is_invalid() {
    let (mgr, _app) = new_manager().await;
    let err = mgr.create(new_item("", Kind::Note, "x")).await.unwrap_err();
    assert!(matches!(err, AppError::Invalid(_)));
}

#[tokio::test]
async fn create_with_unloaded_or_unknown_project_id_is_rejected() {
    let (mgr, _app) = new_manager().await;
    let err = mgr.create(new_item("does-not-exist", Kind::Note, "x")).await.unwrap_err();
    // A not-loaded/unknown target is a clear Invalid("that project isn't
    // loaded"), not the generic item-NotFound.
    assert!(matches!(err, AppError::Invalid(_)), "got {err:?}");
}

#[tokio::test]
async fn get_update_delete_route_across_loaded_stores_by_id() {
    let (mgr, _app) = new_manager().await;
    let (a, _dir_a) = create_project(&mgr, "Alpha").await;
    let (b, _dir_b) = create_project(&mgr, "Beta").await;

    let item_a = mgr.create(new_item(&a.id, Kind::Note, "alpha item")).await.unwrap();
    let item_b = mgr.create(new_item(&b.id, Kind::Note, "beta item")).await.unwrap();

    assert_eq!(mgr.get(&item_a.id).await.unwrap().project_id.as_deref(), Some(a.id.as_str()));
    assert_eq!(mgr.get(&item_b.id).await.unwrap().project_id.as_deref(), Some(b.id.as_str()));

    // update() stamps the owning project id on the returned item.
    let updated = mgr
        .update(&item_b.id, UpdateItem { title: Some("renamed".into()), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(updated.title, "renamed");
    assert_eq!(updated.project_id.as_deref(), Some(b.id.as_str()));

    // delete() only removes from the owning store.
    mgr.delete(&item_a.id).await.unwrap();
    assert!(matches!(mgr.get(&item_a.id).await.unwrap_err(), AppError::NotFound));
    assert!(mgr.get(&item_b.id).await.is_ok());
}

#[tokio::test]
async fn id_in_no_loaded_store_is_not_found() {
    let (mgr, _app) = new_manager().await;
    let (_info, _dir) = create_project(&mgr, "Alpha").await;

    assert!(matches!(mgr.get("nope").await.unwrap_err(), AppError::NotFound));
    assert!(matches!(mgr.update("nope", UpdateItem::default()).await.unwrap_err(), AppError::NotFound));
    assert!(matches!(mgr.delete("nope").await.unwrap_err(), AppError::NotFound));
}

// ---------------------------------------------------------------------------
// Tag union
// ---------------------------------------------------------------------------

#[tokio::test]
async fn tag_union_disjoint_and_shared_are_deduped_and_sorted() {
    let (mgr, _app) = new_manager().await;
    let (a, _dir_a) = create_project(&mgr, "Alpha").await;
    let (b, _dir_b) = create_project(&mgr, "Beta").await;

    mgr.create(item_with_tags(&a.id, Kind::Note, "a1", &["gamma", "common"])).await.unwrap();
    mgr.create(item_with_tags(&b.id, Kind::Note, "b1", &["beta-tag", "common"])).await.unwrap();

    let union = mgr.active_tags_union().await.unwrap();
    assert_eq!(union, vec!["beta-tag".to_string(), "common".into(), "gamma".into()]);
}

#[tokio::test]
async fn tag_survives_when_last_carrier_in_one_project_archives_but_another_project_still_carries_it() {
    // Headline spec scenario (plan.6 Section 8).
    let (mgr, _app) = new_manager().await;
    let (a, _dir_a) = create_project(&mgr, "Alpha").await;
    let (b, _dir_b) = create_project(&mgr, "Beta").await;

    let item_a = mgr.create(item_with_tags(&a.id, Kind::Note, "a1", &["shared"])).await.unwrap();
    mgr.create(item_with_tags(&b.id, Kind::Note, "b1", &["shared"])).await.unwrap();

    mgr.update(&item_a.id, UpdateItem { archived: Some(true), ..Default::default() }).await.unwrap();

    let union = mgr.active_tags_union().await.unwrap();
    assert!(
        union.contains(&"shared".to_string()),
        "tag must survive via project B even though A's only carrier was archived"
    );
}

#[tokio::test]
async fn tag_drops_when_its_last_carrier_everywhere_is_gone() {
    let (mgr, _app) = new_manager().await;
    let (a, _dir_a) = create_project(&mgr, "Alpha").await;
    let (b, _dir_b) = create_project(&mgr, "Beta").await;
    // Keeps the union non-empty so we're testing "this tag drops", not
    // "the whole union collapsed".
    mgr.create(item_with_tags(&a.id, Kind::Note, "a1", &["other"])).await.unwrap();
    let solo = mgr.create(item_with_tags(&b.id, Kind::Note, "solo-carrier", &["onlyme"])).await.unwrap();
    assert!(mgr.active_tags_union().await.unwrap().contains(&"onlyme".to_string()));

    mgr.update(&solo.id, UpdateItem { archived: Some(true), ..Default::default() }).await.unwrap();
    assert!(!mgr.active_tags_union().await.unwrap().contains(&"onlyme".to_string()));
}

#[tokio::test]
async fn unloading_a_project_drops_its_exclusive_tags_and_reloading_restores_them() {
    let (mgr, _app) = new_manager().await;
    let (a, _dir_a) = create_project(&mgr, "Alpha").await;
    let (b, _dir_b) = create_project(&mgr, "Beta").await;
    mgr.create(item_with_tags(&a.id, Kind::Note, "a1", &["alpha-only"])).await.unwrap();
    mgr.create(item_with_tags(&b.id, Kind::Note, "b1", &["beta-only"])).await.unwrap();

    assert!(mgr.active_tags_union().await.unwrap().contains(&"beta-only".to_string()));

    mgr.unload(&b.id).await.unwrap();
    let after_unload = mgr.active_tags_union().await.unwrap();
    assert!(!after_unload.contains(&"beta-only".to_string()), "unloading B must drop its exclusive tag");
    assert!(after_unload.contains(&"alpha-only".to_string()), "A's tag must be unaffected");

    mgr.load(&b.id).await.unwrap();
    assert!(mgr.active_tags_union().await.unwrap().contains(&"beta-only".to_string()), "reloading B restores its tag");
}

#[tokio::test]
async fn zero_loaded_projects_gives_empty_tag_union_not_error() {
    let (mgr, _app) = new_manager().await;
    assert!(mgr.active_tags_union().await.unwrap().is_empty());
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

#[tokio::test]
async fn search_hits_from_both_projects_are_stamped_and_grouped_contiguously() {
    let (mgr, _app) = new_manager().await;
    let (a, _dir_a) = create_project(&mgr, "Alpha").await; // catalog/name order: Alpha, Beta
    let (b, _dir_b) = create_project(&mgr, "Beta").await;

    mgr.create(new_item(&a.id, Kind::Note, "shared keyword one")).await.unwrap();
    mgr.create(new_item(&a.id, Kind::Note, "shared keyword two")).await.unwrap();
    mgr.create(new_item(&b.id, Kind::Note, "shared keyword three")).await.unwrap();

    let hits = mgr.search_all("shared", &ListFilter::default()).await.unwrap();
    assert_eq!(hits.len(), 3);
    // Groups ordered by project name (Alpha before Beta); each item stamped
    // with its owning project and items from one project stay contiguous.
    assert_eq!(hits[0].project_id.as_deref(), Some(a.id.as_str()));
    assert_eq!(hits[1].project_id.as_deref(), Some(a.id.as_str()));
    assert_eq!(hits[2].project_id.as_deref(), Some(b.id.as_str()));
}

#[tokio::test]
async fn search_excludes_archived_items_across_stores() {
    let (mgr, _app) = new_manager().await;
    let (a, _dir_a) = create_project(&mgr, "Alpha").await;
    let (b, _dir_b) = create_project(&mgr, "Beta").await;
    let item_a = mgr.create(new_item(&a.id, Kind::Note, "findme alpha")).await.unwrap();
    mgr.create(new_item(&b.id, Kind::Note, "findme beta")).await.unwrap();
    mgr.update(&item_a.id, UpdateItem { archived: Some(true), ..Default::default() }).await.unwrap();

    let hits = mgr.search_all("findme", &ListFilter::default()).await.unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].project_id.as_deref(), Some(b.id.as_str()));
}

#[tokio::test]
async fn search_status_filter_and_combines_post_merge() {
    let (mgr, _app) = new_manager().await;
    let (a, _dir_a) = create_project(&mgr, "Alpha").await;
    let (b, _dir_b) = create_project(&mgr, "Beta").await;
    let task_a = mgr
        .create(NewItem { status: Some(Status::Doing), ..new_item(&a.id, Kind::Task, "widget alpha") })
        .await
        .unwrap();
    mgr.create(NewItem { status: Some(Status::Todo), ..new_item(&b.id, Kind::Task, "widget beta") })
        .await
        .unwrap();

    let hits = mgr
        .search_all("widget", &ListFilter { status: Some(Status::Doing), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(hits.len(), 1, "status filter must AND-combine with the search term across both stores");
    assert_eq!(hits[0].id, task_a.id);
}

#[tokio::test]
async fn search_fts_hostile_input_does_not_error() {
    let (mgr, _app) = new_manager().await;
    let (a, _dir_a) = create_project(&mgr, "Alpha").await;
    let (b, _dir_b) = create_project(&mgr, "Beta").await;
    mgr.create(new_item(&a.id, Kind::Note, "n")).await.unwrap();
    mgr.create(new_item(&b.id, Kind::Note, "n")).await.unwrap();

    let hits = mgr.search_all("\"unbalanced (syntax -bomb", &ListFilter::default()).await.unwrap();
    assert!(hits.is_empty());
}

#[tokio::test]
async fn unloading_a_project_removes_its_hits_from_search() {
    let (mgr, _app) = new_manager().await;
    let (a, _dir_a) = create_project(&mgr, "Alpha").await;
    let (b, _dir_b) = create_project(&mgr, "Beta").await;
    mgr.create(new_item(&a.id, Kind::Note, "findme alpha")).await.unwrap();
    mgr.create(new_item(&b.id, Kind::Note, "findme beta")).await.unwrap();

    assert_eq!(mgr.search_all("findme", &ListFilter::default()).await.unwrap().len(), 2);
    mgr.unload(&b.id).await.unwrap();
    let hits = mgr.search_all("findme", &ListFilter::default()).await.unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].project_id.as_deref(), Some(a.id.as_str()));
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

#[tokio::test]
async fn list_all_interleaves_recency_globally_across_two_loaded_projects() {
    // Built directly against SqliteRepository (not via the manager) so
    // timestamps can be pinned exactly, per the plan's guidance — this avoids
    // relying on rapid-create timestamp uniqueness across two files.
    let (mgr, _app) = new_manager().await;
    let dir_a = tempdir().unwrap();
    let dir_b = tempdir().unwrap();

    let ts_old = "2026-07-14T00:00:01.000+00:00";
    let ts_mid = "2026-07-14T00:00:02.000+00:00";
    let ts_new = "2026-07-14T00:00:03.000+00:00";

    {
        let repo_a = SqliteRepository::create_at(&dir_a.path().join("project.db"), "proj-a", "Alpha")
            .await
            .unwrap();
        let a_old = repo_a.create(new_item("", Kind::Note, "a-old")).await.unwrap();
        let a_new = repo_a.create(new_item("", Kind::Note, "a-new")).await.unwrap();
        repo_a.set_timestamps_for_test(&a_old.id, ts_old, ts_old).await.unwrap();
        repo_a.set_timestamps_for_test(&a_new.id, ts_new, ts_new).await.unwrap();
        repo_a.close().await;

        let repo_b = SqliteRepository::create_at(&dir_b.path().join("project.db"), "proj-b", "Beta")
            .await
            .unwrap();
        let b_mid = repo_b.create(new_item("", Kind::Note, "b-mid")).await.unwrap();
        repo_b.set_timestamps_for_test(&b_mid.id, ts_mid, ts_mid).await.unwrap();
        repo_b.close().await;
    }

    mgr.open_project(dir_a.path().to_str().unwrap()).await.unwrap();
    mgr.open_project(dir_b.path().to_str().unwrap()).await.unwrap();

    let order: Vec<String> =
        mgr.list_all(&ListFilter::default()).await.unwrap().into_iter().map(|i| i.title).collect();
    // A naive per-store concatenation could never produce this interleave
    // (b-mid sits strictly between a-new and a-old): only a real global
    // k-way merge does.
    assert_eq!(order, vec!["a-new".to_string(), "b-mid".into(), "a-old".into()]);
}

#[tokio::test]
async fn list_all_pinned_item_in_one_project_leads_items_in_the_other() {
    let (mgr, _app) = new_manager().await;
    let (a, _dir_a) = create_project(&mgr, "Alpha").await;
    let (b, _dir_b) = create_project(&mgr, "Beta").await;

    // Created FIRST (older) in B; A's item is created after (newer), so under
    // plain recency ordering A would lead — until B's item is pinned.
    let to_pin = mgr.create(new_item(&b.id, Kind::Note, "beta pinned")).await.unwrap();
    mgr.create(new_item(&a.id, Kind::Note, "alpha newer")).await.unwrap();
    mgr.update(&to_pin.id, UpdateItem { pinned: Some(true), ..Default::default() }).await.unwrap();

    let order = mgr.list_all(&ListFilter::default()).await.unwrap();
    assert_eq!(order[0].id, to_pin.id, "pinned item from project B must lead a more-recent item in A");
}

#[tokio::test]
async fn list_all_status_sort_merges_doing_testing_todo_done_then_notes_across_two_projects() {
    // plan.14 D3, integration-level: the four statuses (plus a note) split
    // across TWO loaded stores, all timestamps forced equal so only
    // `status_rank` differentiates the order — proves the manager's k-way merge
    // reproduces the single-DB CASE order end to end, not just at the pure
    // `k_way_merge` unit-test level (projects::merge_tests).
    let (mgr, _app) = new_manager().await;
    let dir_a = tempdir().unwrap();
    let dir_b = tempdir().unwrap();
    let ts = "2026-07-14T00:00:00.000+00:00";

    {
        let repo_a = SqliteRepository::create_at(&dir_a.path().join("project.db"), "proj-a", "Alpha")
            .await
            .unwrap();
        let doing = repo_a
            .create(NewItem { status: Some(Status::Doing), ..new_item("", Kind::Task, "doing") })
            .await
            .unwrap();
        let done = repo_a
            .create(NewItem { status: Some(Status::Done), ..new_item("", Kind::Task, "done") })
            .await
            .unwrap();
        repo_a.set_timestamps_for_test(&doing.id, ts, ts).await.unwrap();
        repo_a.set_timestamps_for_test(&done.id, ts, ts).await.unwrap();
        repo_a.close().await;

        let repo_b = SqliteRepository::create_at(&dir_b.path().join("project.db"), "proj-b", "Beta")
            .await
            .unwrap();
        let testing = repo_b
            .create(NewItem { status: Some(Status::Testing), ..new_item("", Kind::Task, "testing") })
            .await
            .unwrap();
        let todo = repo_b
            .create(NewItem { status: Some(Status::Todo), ..new_item("", Kind::Task, "todo") })
            .await
            .unwrap();
        let note = repo_b.create(new_item("", Kind::Note, "note")).await.unwrap();
        for id in [&testing.id, &todo.id, &note.id] {
            repo_b.set_timestamps_for_test(id, ts, ts).await.unwrap();
        }
        repo_b.close().await;
    }

    mgr.open_project(dir_a.path().to_str().unwrap()).await.unwrap();
    mgr.open_project(dir_b.path().to_str().unwrap()).await.unwrap();

    let order: Vec<String> = mgr
        .list_all(&ListFilter { sort: Some(Sort::Status), ..Default::default() })
        .await
        .unwrap()
        .into_iter()
        .map(|i| i.title)
        .collect();
    assert_eq!(order, vec!["doing", "testing", "todo", "done", "note"]);
}

// ---------------------------------------------------------------------------
// Per-store invariant regression against a SECONDARY loaded project (proves
// the manager isn't wired only to the first store it loads)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn secondary_loaded_project_content_edit_bumps_updated_at_but_pin_and_archive_do_not() {
    let (mgr, _app) = new_manager().await;
    let (_first, _dir_first) = create_project(&mgr, "Alpha").await;
    let (second, _dir_second) = create_project(&mgr, "Beta").await;

    let item = mgr.create(new_item(&second.id, Kind::Task, "beta task")).await.unwrap();

    // Force a stale baseline directly on the SECOND store's index (a side
    // connection to the same file the manager already has open) so the bump
    // assertion can't tie on same-millisecond clock resolution.
    let db_path = Path::new(&second.path).join("index.db");
    let side = SqliteRepository::open_existing(&db_path).await.unwrap();
    let old = "2000-01-01T00:00:00+00:00";
    side.set_timestamps_for_test(&item.id, old, old).await.unwrap();
    side.close().await;

    let edited = mgr
        .update(&item.id, UpdateItem { title: Some("renamed".into()), ..Default::default() })
        .await
        .unwrap();
    assert!(edited.updated_at > old.to_string(), "a content edit on the SECOND project must bump updated_at");

    let baseline = edited.updated_at.clone();
    let pinned = mgr.update(&item.id, UpdateItem { pinned: Some(true), ..Default::default() }).await.unwrap();
    assert_eq!(pinned.updated_at, baseline, "pin flip on the SECOND project must not bump updated_at");
    let archived =
        mgr.update(&item.id, UpdateItem { archived: Some(true), ..Default::default() }).await.unwrap();
    assert_eq!(archived.updated_at, baseline, "archive flip on the SECOND project must not bump updated_at");

    // Archived items are excluded from list_all on the SECOND project too.
    let listed = mgr
        .list_all(&ListFilter { project_id: Some(second.id.clone()), ..Default::default() })
        .await
        .unwrap();
    assert!(listed.is_empty());
}

#[tokio::test]
async fn secondary_loaded_project_done_task_drops_its_tag_from_the_union() {
    let (mgr, _app) = new_manager().await;
    let (_first, _dir_first) = create_project(&mgr, "Alpha").await;
    let (second, _dir_second) = create_project(&mgr, "Beta").await;

    let task = mgr
        .create(item_with_tags(&second.id, Kind::Task, "beta task", &["beta-solo"]))
        .await
        .unwrap();
    assert!(mgr.active_tags_union().await.unwrap().contains(&"beta-solo".to_string()));

    mgr.update(&task.id, UpdateItem { status: Some(Status::Done), ..Default::default() }).await.unwrap();
    assert!(
        !mgr.active_tags_union().await.unwrap().contains(&"beta-solo".to_string()),
        "a done task's tag must drop even when it lives in a non-primary store"
    );
}

// ---------------------------------------------------------------------------
// Creation/opening hardening (SqliteRepository::create_at / open_existing)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn create_at_fresh_dir_yields_independently_usable_store() {
    let dir = tempdir().unwrap();
    let repo = SqliteRepository::create_at(&dir.path().join("project.db"), "id-1", "Solo").await.unwrap();
    let item = repo.create(new_item("", Kind::Note, "hello")).await.unwrap();
    assert_eq!(repo.get(&item.id).await.unwrap().title, "hello");
    let (pid, pname) = repo.read_meta().await.unwrap();
    assert_eq!(pid, "id-1");
    assert_eq!(pname, "Solo");
    repo.close().await;
}

#[tokio::test]
async fn create_at_where_a_db_already_exists_errors_without_truncating() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("project.db");
    let repo = SqliteRepository::create_at(&path, "id-1", "Solo").await.unwrap();
    let item = repo.create(new_item("", Kind::Note, "keep me")).await.unwrap();
    repo.close().await;

    let err = SqliteRepository::create_at(&path, "id-2", "Other").await.unwrap_err();
    assert!(matches!(err, AppError::Invalid(_)));

    // The original store must be intact — create_at never truncates.
    let reopened = SqliteRepository::open_existing(&path).await.unwrap();
    assert_eq!(reopened.get(&item.id).await.unwrap().title, "keep me");
}

#[tokio::test]
async fn open_existing_on_missing_file_is_clean_error() {
    let dir = tempdir().unwrap();
    let err = SqliteRepository::open_existing(&dir.path().join("nope.db")).await.unwrap_err();
    assert!(matches!(err, AppError::Invalid(_)));
}

#[tokio::test]
async fn open_existing_on_garbage_file_is_scrubbed_and_leaks_nothing() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("project.db");
    std::fs::write(&path, b"not a sqlite file at all, just plain bytes").unwrap();

    let err = SqliteRepository::open_existing(&path).await.unwrap_err();
    match err {
        AppError::Invalid(msg) => {
            assert!(!msg.contains("disk image"), "must not echo raw SQLite text: {msg}");
            assert!(!msg.to_lowercase().contains("sqlite"), "must not echo raw SQLite text: {msg}");
            assert!(!msg.contains(&path.to_string_lossy().to_string()), "must never echo the filesystem path");
        }
        other => panic!("expected a scrubbed Invalid error, got {other:?}"),
    }
}

#[tokio::test]
async fn open_existing_rejects_foreign_application_id() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("project.db");

    // A plain SQLite file with the DEFAULT application_id (0) — never stamped
    // as a worknotes store.
    let options = sqlx::sqlite::SqliteConnectOptions::new().filename(&path).create_if_missing(true);
    let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect_with(options).await.unwrap();
    pool.close().await;

    let err = SqliteRepository::open_existing(&path).await.unwrap_err();
    assert!(matches!(err, AppError::Invalid(_)));
}

#[tokio::test]
async fn open_existing_rejects_an_unknown_trigger() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("project.db");
    let repo = SqliteRepository::create_at(&path, "id-1", "Solo").await.unwrap();
    repo.close().await;

    let options = sqlx::sqlite::SqliteConnectOptions::new().filename(&path).create_if_missing(false);
    let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect_with(options).await.unwrap();
    sqlx::query("CREATE TRIGGER evil_trigger AFTER INSERT ON items BEGIN SELECT 1; END;")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;

    let err = SqliteRepository::open_existing(&path).await.unwrap_err();
    assert!(matches!(err, AppError::Invalid(_)));
}

#[tokio::test]
async fn open_existing_rejects_a_newer_version_db() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("project.db");
    let repo = SqliteRepository::create_at(&path, "id-1", "Solo").await.unwrap();
    repo.close().await;

    let options = sqlx::sqlite::SqliteConnectOptions::new().filename(&path).create_if_missing(false);
    let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect_with(options).await.unwrap();
    // A migration version our binary doesn't know about, higher than any real
    // one — sqlx's Migrator rejects this as VersionMissing.
    sqlx::query(
        "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) \
         VALUES (?1, ?2, 1, ?3, 0)",
    )
    .bind(999_999_999_i64)
    .bind("a migration from the future")
    .bind(Vec::<u8>::new())
    .execute(&pool)
    .await
    .unwrap();
    pool.close().await;

    let err = SqliteRepository::open_existing(&path).await.unwrap_err();
    match err {
        AppError::Invalid(msg) => assert!(msg.contains("newer version"), "got: {msg}"),
        other => panic!("expected Invalid(\"...newer version...\"), got {other:?}"),
    }
}

// The oversized-file rejection (MAX_PROJECT_DB_BYTES in db/sqlite.rs) is NOT
// exercised here: constructing a real >512MB fixture is impractical on this
// disk-constrained machine (see project memory: cargo-test-disk-full-workaround).
// Verified by code inspection instead: open_existing() reads
// std::fs::metadata(path).len() and rejects before touching the file's
// contents whenever len() > MAX_PROJECT_DB_BYTES.
#[tokio::test]
#[ignore = "would require materializing a >512MB fixture file; verified by code inspection instead"]
async fn open_existing_rejects_an_oversized_file() {}

// ---------------------------------------------------------------------------
// WAL persistence
// ---------------------------------------------------------------------------

#[tokio::test]
async fn reopening_after_close_loses_no_committed_writes() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("project.db");
    let repo = SqliteRepository::create_at(&path, "id-1", "Solo").await.unwrap();
    let item = repo.create(new_item("", Kind::Task, "durable")).await.unwrap();
    repo.close().await;

    let reopened = SqliteRepository::open_existing(&path).await.unwrap();
    let fetched = reopened.get(&item.id).await.unwrap();
    assert_eq!(fetched.title, "durable");
    assert_eq!(fetched.id, item.id);
}

// ---------------------------------------------------------------------------
// Duplicate-UUID / moved-file reconciliation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn open_project_refuses_a_copy_while_the_original_still_exists() {
    let (mgr, _app) = new_manager().await;
    let (info, dir_original) = create_project(&mgr, "Alpha").await;
    // Unload so the copy attempt hits the "known at another path" branch
    // rather than the (separately correct) "already loaded" rejection.
    mgr.unload(&info.id).await.unwrap();

    let dir_copy = tempdir().unwrap();
    copy_store_files(dir_original.path(), dir_copy.path());

    let err = mgr.open_project(dir_copy.path().to_str().unwrap()).await.unwrap_err();
    match err {
        AppError::Invalid(msg) => assert!(msg.contains("copy"), "got: {msg}"),
        other => panic!("expected Invalid(\"...copy...\"), got {other:?}"),
    }
    // The original is untouched.
    assert!(dir_original.path().join("index.db").exists());
}

#[tokio::test]
async fn open_project_on_a_moved_directory_reconciles_the_catalog_path() {
    let (mgr, _app) = new_manager().await;
    let (info, dir_original) = create_project(&mgr, "Alpha").await;
    mgr.unload(&info.id).await.unwrap();

    let dir_moved = tempdir().unwrap();
    move_store_files(dir_original.path(), dir_moved.path());

    let reopened = mgr.open_project(dir_moved.path().to_str().unwrap()).await.unwrap();
    assert_eq!(reopened.id, info.id, "a moved file keeps its identity");
    assert!(reopened.loaded);

    let listed = mgr.list_projects().await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].path, canonical_string(dir_moved.path()), "the catalog path must update to the new folder");
}

// ---------------------------------------------------------------------------
// Unload-vs-in-flight-query race + settings isolation (Section 4/8)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn querying_a_store_after_its_pool_is_closed_errors_cleanly_never_panics() {
    // Models the unload-vs-in-flight-query race (plan §5 "Unload"): unload closes
    // the pool; a query that races the close must resolve or surface a clean
    // error — never a panic. Deterministic form: close, then query.
    let dir = tempdir().unwrap();
    let repo = SqliteRepository::create_at(&dir.path().join("project.db"), "id-1", "Solo").await.unwrap();
    repo.close().await;
    assert!(repo.list(&ListFilter::default()).await.is_err(), "list on a closed pool must Err, not panic");
    assert!(repo.get("anything").await.is_err(), "get on a closed pool must Err, not panic");
}

#[tokio::test]
async fn app_settings_inside_a_loaded_project_store_are_never_surfaced() {
    // Section 4.5: settings come ONLY from the catalog, never a loaded project
    // store. Inject a rogue app_settings row into a valid worknotes store, load
    // it, and confirm the manager's (catalog-backed) accessor ignores it.
    let (mgr, _app) = new_manager().await;
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("project.db");
    {
        let repo = SqliteRepository::create_at(&db_path, "id-1", "Rogue").await.unwrap();
        repo.close().await;
    }
    let options = sqlx::sqlite::SqliteConnectOptions::new().filename(&db_path).create_if_missing(false);
    let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect_with(options).await.unwrap();
    sqlx::query("INSERT INTO app_settings (key, value) VALUES ('jira_config', 'ROGUE')")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;

    mgr.open_project(dir.path().to_str().unwrap()).await.unwrap();
    // The catalog is the sole source of settings; the store's rogue row is never read.
    assert_eq!(mgr.get_setting("jira_config").await.unwrap(), None);
}

// ---------------------------------------------------------------------------
// Stage 2: canonical file store, in-place upgrade, git-clone, reload
// ---------------------------------------------------------------------------

/// A minimal valid canonical note file (raw string, as git would deliver it).
fn note_md(id: &str, title: &str) -> String {
    format!(
        "---\nid: {id}\nkind: note\ntitle: \"{title}\"\npinned: false\narchived: false\n\
         tags: []\ncreated_at: 2026-07-14T00:00:00.000+00:00\n\
         updated_at: 2026-07-14T00:00:00.000+00:00\n---\n{title} body\n"
    )
}

fn count_md_files(items_dir: &Path) -> usize {
    std::fs::read_dir(items_dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("md"))
                .count()
        })
        .unwrap_or(0)
}

#[tokio::test]
async fn create_project_uses_the_index_and_items_layout_and_writes_an_item_file() {
    let (mgr, _app) = new_manager().await;
    let (info, dir) = create_project(&mgr, "Alpha").await;

    assert!(dir.path().join("index.db").exists(), "Stage 2 store is index.db");
    assert!(dir.path().join("items").is_dir(), "canonical items/ dir is created");
    assert!(!dir.path().join("project.db").exists(), "no Stage-1 file for a new project");

    let item = mgr.create(new_item(&info.id, Kind::Note, "hello world")).await.unwrap();
    // The write is mirrored to a canonical <id>.md BEFORE the index row.
    let file = dir.path().join("items").join(format!("{}.md", item.id));
    assert!(file.exists(), "creating an item writes its canonical file");
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(text.contains("hello world"), "the file carries the title");
    assert!(!text.contains("project_id"), "an item file never carries project_id");

    // Deleting removes the file too.
    mgr.delete(&item.id).await.unwrap();
    assert!(!file.exists(), "deleting an item removes its canonical file");
}

#[tokio::test]
async fn convert_note_to_task_rewrites_the_canonical_file_and_stamps_project_id() {
    // plan.14 F7 / D8 step 19's on-disk-shape case: repo.rs covers the
    // in-memory-DB behavior; this covers what actually lands in items/<id>.md
    // through the real manager routing (ProjectManager::convert_note_to_task).
    let (mgr, _app) = new_manager().await;
    let (info, dir) = create_project(&mgr, "Alpha").await;

    let note = mgr.create(new_item(&info.id, Kind::Note, "note to convert")).await.unwrap();
    assert_eq!(note.kind, Kind::Note);
    assert_eq!(note.project_id, Some(info.id.clone()));

    let converted = mgr.convert_note_to_task(&note.id).await.unwrap();
    assert_eq!(converted.kind, Kind::Task);
    assert_eq!(converted.status, Some(Status::Todo));
    assert_eq!(converted.priority, Some(Priority::Normal));
    assert_eq!(
        converted.project_id,
        Some(info.id.clone()),
        "the manager stamps the owning project onto a converted item, like update()"
    );

    let file = dir.path().join("items").join(format!("{}.md", note.id));
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(text.contains("kind: task"), "canonical file's kind line is rewritten: {text}");
    assert!(text.contains("status: todo"), "canonical file gains a status line: {text}");
    assert!(text.contains("priority: normal"), "canonical file gains a priority line: {text}");

    let (parsed, warning) = itemfile::parse(&text).unwrap();
    assert!(warning.is_none(), "a freshly-converted file must parse with no degrade warning: {warning:?}");
    assert_eq!(parsed.id, note.id);
    assert_eq!(parsed.kind, Kind::Task);
    assert_eq!(parsed.status, Some(Status::Todo));
    assert_eq!(parsed.priority, Some(Priority::Normal));
}

#[tokio::test]
async fn stage1_project_db_is_upgraded_in_place_preserving_every_item() {
    // The real on-disk scenario: a Stage-1 store (project.db, no items/) is
    // opened and converted once — data preserved, original kept as a .bak.
    let (mgr, _app) = new_manager().await;
    let dir = tempdir().unwrap();
    {
        let repo =
            SqliteRepository::create_at(&dir.path().join("project.db"), "legacy-uuid", "Legacy")
                .await
                .unwrap();
        // Index-only writes (items_dir unset) — exactly a Stage-1 store.
        repo.create(new_item("", Kind::Note, "one")).await.unwrap();
        repo.create(new_item("", Kind::Task, "two")).await.unwrap();
        repo.close().await;
    }

    let info = mgr.open_project(dir.path().to_str().unwrap()).await.unwrap();

    // Data preserved and now served from the rebuilt index.
    let items = mgr
        .list_all(&ListFilter { project_id: Some(info.id.clone()), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(items.len(), 2, "both legacy items survive the upgrade");

    // Layout converted: index.db + one canonical file per item; the original
    // project.db is retired to a .bak (never deleted).
    assert!(dir.path().join("index.db").exists());
    assert_eq!(count_md_files(&dir.path().join("items")), 2);
    assert!(!dir.path().join("project.db").exists(), "the Stage-1 store is renamed away");
    assert!(dir.path().join("project.db.pre-stage2.bak").exists(), "original preserved as backup");
    // Identity is preserved from the Stage-1 store's meta AND published to the
    // git-portable identity file so a future clone keeps it.
    assert_eq!(info.id, "legacy-uuid");
    let identity = std::fs::read_to_string(dir.path().join("project.json")).unwrap();
    assert!(identity.contains("legacy-uuid"), "upgrade writes the git-portable identity file");
}

#[tokio::test]
async fn two_projects_sharing_an_item_id_via_files_refuse_ambiguous_retrieval() {
    // Real UUIDs never collide, but hand-crafted/merged files could put the same
    // id in two DISTINCT projects (each with its own identity). Loaded together,
    // the merged list keeps both, but id-based retrieval must refuse rather than
    // silently route to whichever store enumerated first (owner()'s guard).
    let (mgr, _app) = new_manager().await;
    let shared = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

    let dir_a = tempdir().unwrap();
    let dir_b = tempdir().unwrap();
    for dir in [&dir_a, &dir_b] {
        let items = dir.path().join("items");
        std::fs::create_dir_all(&items).unwrap();
        std::fs::write(items.join(format!("{shared}.md")), note_md(shared, "shared id")).unwrap();
    }

    // No identity files → each folder is adopted as its own project (distinct
    // UUIDs), so both load; their shared item id is what collides.
    let a = mgr.open_project(dir_a.path().to_str().unwrap()).await.unwrap();
    let b = mgr.open_project(dir_b.path().to_str().unwrap()).await.unwrap();
    assert_ne!(a.id, b.id);

    // Merge keeps both copies (one per project).
    assert_eq!(mgr.list_all(&ListFilter::default()).await.unwrap().len(), 2);
    // Ambiguous id → clean Invalid, never a silent wrong-store route.
    match mgr.get(shared).await.unwrap_err() {
        AppError::Invalid(msg) => assert!(msg.contains("more than one"), "got: {msg}"),
        other => panic!("expected an ambiguity Invalid, got {other:?}"),
    }
    assert!(matches!(mgr.update(shared, UpdateItem::default()).await.unwrap_err(), AppError::Invalid(_)));
}

#[tokio::test]
async fn a_clone_carrying_the_identity_of_a_loaded_project_is_refused() {
    // The Stage-2 workflow: items/*.md + project.json are committed to git;
    // index.db is git-ignored. Re-opening a clone of an ALREADY-KNOWN project on
    // the same machine must be refused (its committed identity is recognized),
    // never silently registered as a second project with colliding item ids.
    let (mgr, _app) = new_manager().await;
    let (info, dir) = create_project(&mgr, "Alpha").await;
    mgr.create(new_item(&info.id, Kind::Note, "shared item")).await.unwrap();

    // Simulate `git clone`: copy the tracked files (project.json + items/) but
    // NOT the git-ignored index.db.
    let clone = tempdir().unwrap();
    std::fs::copy(dir.path().join("project.json"), clone.path().join("project.json")).unwrap();
    copy_dir_all(&dir.path().join("items"), &clone.path().join("items"));

    // While the original is loaded: the clone is a duplicate of a loaded project.
    let err = mgr.open_project(clone.path().to_str().unwrap()).await.unwrap_err();
    assert!(matches!(err, AppError::Invalid(_)), "a clone of a loaded project is refused");

    // Even unloaded, the clone is recognized as a copy of a known project (its
    // committed identity matches a catalog row whose original files still exist).
    mgr.unload(&info.id).await.unwrap();
    match mgr.open_project(clone.path().to_str().unwrap()).await.unwrap_err() {
        AppError::Invalid(msg) => assert!(msg.contains("copy"), "got: {msg}"),
        other => panic!("expected a copy rejection, got {other:?}"),
    }
}

#[tokio::test]
async fn a_git_clone_with_only_item_files_builds_a_fresh_index_on_open() {
    // A cloned/synced project dir carries items/*.md but no index.db (git-ignored).
    let (mgr, _app) = new_manager().await;
    let dir = tempdir().unwrap();
    let items_dir = dir.path().join("items");
    std::fs::create_dir_all(&items_dir).unwrap();
    std::fs::write(
        items_dir.join("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.md"),
        note_md("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "cloned one"),
    )
    .unwrap();
    std::fs::write(
        items_dir.join("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.md"),
        note_md("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "cloned two"),
    )
    .unwrap();

    let info = mgr.open_project(dir.path().to_str().unwrap()).await.unwrap();
    assert!(dir.path().join("index.db").exists(), "a fresh index is built from the files");

    let titles: Vec<String> = mgr
        .list_all(&ListFilter { project_id: Some(info.id.clone()), ..Default::default() })
        .await
        .unwrap()
        .into_iter()
        .map(|i| i.title)
        .collect();
    assert_eq!(titles.len(), 2);
    assert!(titles.contains(&"cloned one".to_string()) && titles.contains(&"cloned two".to_string()));
}

#[tokio::test]
async fn reload_picks_up_files_added_and_removed_out_of_band() {
    // Post-git-pull: a file appears and another vanishes; reload rebuilds the
    // index from what's on disk.
    let (mgr, _app) = new_manager().await;
    let (info, dir) = create_project(&mgr, "Alpha").await;
    let items_dir = dir.path().join("items");

    let kept = mgr.create(new_item(&info.id, Kind::Note, "kept")).await.unwrap();
    let removed = mgr.create(new_item(&info.id, Kind::Note, "removed")).await.unwrap();
    assert_eq!(mgr.list_all(&ListFilter::default()).await.unwrap().len(), 2);

    // Simulate a pull: add a new file, delete an existing one.
    std::fs::write(
        items_dir.join("cccccccc-cccc-cccc-cccc-cccccccccccc.md"),
        note_md("cccccccc-cccc-cccc-cccc-cccccccccccc", "pulled in"),
    )
    .unwrap();
    std::fs::remove_file(items_dir.join(format!("{}.md", removed.id))).unwrap();

    let warnings = mgr.reload(&info.id).await.unwrap();
    assert!(warnings.is_empty(), "clean files reload without warnings");

    let titles: Vec<String> =
        mgr.list_all(&ListFilter::default()).await.unwrap().into_iter().map(|i| i.title).collect();
    assert_eq!(titles.len(), 2);
    assert!(titles.contains(&"kept".to_string()), "an untouched item survives reload");
    assert!(titles.contains(&"pulled in".to_string()), "a pulled-in file appears after reload");
    assert!(!titles.contains(&"removed".to_string()), "a deleted file is gone after reload");
    let _ = kept;
}

#[tokio::test]
async fn reload_reports_conflict_marker_files_and_imports_the_rest() {
    // Per-file partial success: a file with unresolved git conflict markers is
    // skipped and reported; the clean files still import.
    let (mgr, _app) = new_manager().await;
    let (info, dir) = create_project(&mgr, "Alpha").await;
    let items_dir = dir.path().join("items");

    mgr.create(new_item(&info.id, Kind::Note, "clean")).await.unwrap();
    let conflicted = "dddddddd-dddd-dddd-dddd-dddddddddddd.md";
    std::fs::write(
        items_dir.join(conflicted),
        "---\nid: dddddddd-dddd-dddd-dddd-dddddddddddd\nkind: note\ntitle: \"x\"\n\
         <<<<<<< HEAD\npinned: false\n=======\npinned: true\n>>>>>>> branch\narchived: false\n\
         tags: []\ncreated_at: 2026-07-14T00:00:00.000+00:00\n\
         updated_at: 2026-07-14T00:00:00.000+00:00\n---\nbody\n",
    )
    .unwrap();

    let warnings = mgr.reload(&info.id).await.unwrap();
    assert_eq!(warnings.len(), 1, "the one conflicted file is reported");
    assert!(warnings[0].contains(conflicted), "the warning names the offending file");
    assert!(warnings[0].contains("conflict"), "the warning explains why");

    // The clean item still imported.
    let titles: Vec<String> =
        mgr.list_all(&ListFilter::default()).await.unwrap().into_iter().map(|i| i.title).collect();
    assert_eq!(titles, vec!["clean".to_string()]);
}

// ---------------------------------------------------------------------------
// schema_version marker (plan.10): back-fill on rebuild is read-only w.r.t.
// the on-disk file, and forward-stamping happens naturally the next time the
// item is edited (write_item always emits the schema_version line).
// ---------------------------------------------------------------------------

#[tokio::test]
async fn reload_backfills_schema_version_for_a_legacy_item_without_rewriting_its_file() {
    // A legacy items/<uuid>.md written before this marker existed carries no
    // `schema_version:` line. Loading it must back-fill "1.0.0" into the INDEX
    // (rebuild_from_dir binds the parser's default verbatim), while the
    // on-disk bytes stay byte-identical — rebuild never rewrites files.
    let (mgr, _app) = new_manager().await;
    let (info, dir) = create_project(&mgr, "Alpha").await;
    let items_dir = dir.path().join("items");

    let legacy_id = "01234567-89ab-cdef-0123-456789abcdef";
    let legacy_text = note_md(legacy_id, "legacy note");
    assert!(!legacy_text.contains("schema_version"), "fixture must genuinely lack the marker");
    std::fs::write(items_dir.join(format!("{legacy_id}.md")), &legacy_text).unwrap();

    mgr.reload(&info.id).await.unwrap();

    let item = mgr.get(legacy_id).await.unwrap();
    assert_eq!(item.schema_version, "1.0.0", "the index back-fills the marker for a legacy file");

    let after = std::fs::read_to_string(items_dir.join(format!("{legacy_id}.md"))).unwrap();
    assert_eq!(after, legacy_text, "rebuild must not rewrite the untouched file on disk");
}

#[tokio::test]
async fn update_on_a_legacy_item_stamps_schema_version_into_the_rewritten_file() {
    // Forward stamping: editing a legacy (no-marker) item rewrites its
    // canonical file via the normal write_item path, which always emits the
    // schema_version line — so the very next edit brings a legacy file's
    // on-disk shape up to date.
    let (mgr, _app) = new_manager().await;
    let (info, dir) = create_project(&mgr, "Alpha").await;
    let items_dir = dir.path().join("items");

    let legacy_id = "76543210-fedc-ba98-7654-3210fedcba98";
    std::fs::write(items_dir.join(format!("{legacy_id}.md")), note_md(legacy_id, "legacy note")).unwrap();
    mgr.reload(&info.id).await.unwrap();

    mgr.update(legacy_id, UpdateItem { title: Some("renamed".into()), ..Default::default() }).await.unwrap();

    let after = std::fs::read_to_string(items_dir.join(format!("{legacy_id}.md"))).unwrap();
    assert!(after.contains("schema_version: 1.0.0"), "the rewritten file now carries the marker: {after}");
}

// ---------------------------------------------------------------------------
// Prompts (plan.7): H1 reopen-after-migrate, routing isolation, reload rebuild
// + full history from files, synthesized head, conflict-marker skip, and the
// Delete-files sweep. Prompt REPOSITORY-level invariants (versioning,
// reusable-toggle, source labeling) live in `tests/repo_prompts.rs`; this
// section is the manager/file-store integration surface, mirroring the item
// tests above.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn reopen_after_migration_to_0006_succeeds() {
    // H1: `open_existing`'s sqlite_master allowlist runs BEFORE `migrate!`, so
    // the FIRST open after upgrading to 0006 applies the migration (adding
    // `prompts`/`prompt_versions`), and the SECOND open sees those new tables.
    // If `KNOWN_TABLES` were not widened, this second open would reject the
    // whole store as foreign — bricking every existing project.
    let (mgr, _app) = new_manager().await;
    let (info, dir) = create_project(&mgr, "Alpha").await;

    mgr.unload(&info.id).await.unwrap();
    let reopened = mgr.open_project(dir.path().to_str().unwrap()).await.unwrap();
    assert_eq!(reopened.id, info.id);
    assert!(reopened.loaded);
}

#[tokio::test]
async fn reopen_after_migration_to_0006_keeps_a_created_prompt() {
    // Same H1 mechanism, but with an actual prompt on disk/in the index —
    // proves both the allowlist widening AND the prompt rebuild survive a real
    // close/reopen cycle end to end.
    let (mgr, _app) = new_manager().await;
    let (info, dir) = create_project(&mgr, "Alpha").await;
    let prompt = mgr.create_prompt(new_prompt(&info.id, "t", "b")).await.unwrap();

    mgr.unload(&info.id).await.unwrap();
    let reopened = mgr.open_project(dir.path().to_str().unwrap()).await.unwrap();
    assert_eq!(reopened.id, info.id);

    let listed = mgr
        .list_prompts(&PromptListFilter { project_id: Some(reopened.id.clone()), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(listed.len(), 1, "the prompt created before unload survives the reopen");
    assert_eq!(listed[0].id, prompt.id);
    assert_eq!(listed[0].title, "t");
}

// ---------------------------------------------------------------------------
// Migration 0008 (plan.14 D4/D5/S-3): drops the status CHECK via a table
// rebuild. `index.db` is not a compat surface (it is dropped/rebuilt from the
// canonical `items/*.md` files on every load), so the real risk isn't losing
// the FILES — it's a migration that bricks opening, or a wrong/missing
// recreated trigger that silently desyncs FTS. These tests simulate an
// EXISTING on-disk store this build has never opened.
// ---------------------------------------------------------------------------

/// Build a fresh index at `path` with ONLY migrations up to (and including)
/// version 7 applied — the schema shape every store had before 0008 dropped
/// the status CHECK — then stamp the `meta` identity rows exactly as
/// `SqliteRepository::create_at` does. `sqlx::migrate::Migrator`'s fields
/// (`migrations`, `ignore_missing`, `locking`, `no_tx`) are public precisely so
/// a caller can build a custom subset like this one.
async fn build_pre_0008_index(path: &Path, project_id: &str, project_name: &str) {
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .foreign_keys(true);
    let pool =
        sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect_with(options).await.unwrap();

    let full = sqlx::migrate!("./migrations");
    let truncated_migrations: Vec<sqlx::migrate::Migration> =
        full.migrations.iter().filter(|m| m.version <= 7).cloned().collect();
    assert!(
        full.migrations.iter().any(|m| m.version == 8),
        "sanity: the full migrator must still carry 0008, or this helper tests nothing"
    );
    let truncated = sqlx::migrate::Migrator {
        migrations: std::borrow::Cow::Owned(truncated_migrations),
        ..full
    };
    truncated.run(&pool).await.unwrap();

    let max_version: i64 =
        sqlx::query_scalar("SELECT COALESCE(MAX(version), 0) FROM _sqlx_migrations")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(max_version, 7, "sanity: exactly migrations 0001..=0007 must be applied");

    // Stamp identity, mirroring create_at's four-row meta commit.
    let mut tx = pool.begin().await.unwrap();
    for (key, value) in [
        ("project_id", project_id.to_string()),
        ("project_name", project_name.to_string()),
        ("schema_version", max_version.to_string()),
        ("created_at", "2026-07-14T00:00:00.000+00:00".to_string()),
    ] {
        sqlx::query("INSERT INTO meta (key, value) VALUES (?1, ?2)")
            .bind(key)
            .bind(value)
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();

    // Sanity: this really is the pre-0008 shape — the CHECK 0008 drops.
    let items_sql: String = sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE name = 'items'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(
        items_sql.contains("status IN"),
        "sanity: the truncated DB must still carry the old status CHECK: {items_sql}"
    );

    pool.close().await;
}

#[tokio::test]
async fn upgrade_0007_store_applies_0008_and_search_survives() {
    // S-3, the highest-value migration test. A REAL existing store this build
    // has never opened: items already on disk as canonical files (pre-0008
    // vocabulary), but its index.db still at migration level 7. Proves the
    // upgrade is lossless end to end: the hardening gate doesn't reject the
    // pre-0008 shape, 0008 applies, every item survives with its status
    // intact, and FTS search still finds them. The rebuild's explicit
    // `items_fts rebuild` command could mask a wrong/missing recreated trigger
    // for these EXISTING items, so a task created AFTER the upgrade — which
    // depends on the LIVE insert trigger, not the rebuild command — is
    // exercised too (D4/S-3's actual failure mode).
    let (mgr, _app) = new_manager().await;
    let (info, dir) = create_project(&mgr, "Legacy").await;

    let todo = mgr
        .create(NewItem {
            status: Some(Status::Todo),
            ..new_item(&info.id, Kind::Task, "renew the lighthouse permit")
        })
        .await
        .unwrap();
    let doing = mgr
        .create(NewItem {
            status: Some(Status::Doing),
            ..new_item(&info.id, Kind::Task, "chart the harbor depth")
        })
        .await
        .unwrap();
    let done = mgr
        .create(NewItem {
            status: Some(Status::Done),
            ..new_item(&info.id, Kind::Task, "paint the buoy marker")
        })
        .await
        .unwrap();

    mgr.unload(&info.id).await.unwrap();

    // Roll the index back to a pre-0008 shape, IN PLACE, on the same directory
    // — the canonical items/*.md files (the actual compat surface) are never
    // touched, only the rebuildable index.
    for suffix in ["", "-wal", "-shm"] {
        let path = dir.path().join(format!("index.db{suffix}"));
        fs_retry(|| match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        });
    }
    build_pre_0008_index(&dir.path().join("index.db"), &info.id, &info.name).await;

    // (1) First reopen: the hardening gate (trigger names unchanged since
    // 0001) passes at level 7, THEN `migrate!` applies 0008, THEN
    // `rebuild_from_dir` repopulates the index from the untouched files.
    let (reopened, warnings) = mgr.load(&info.id).await.unwrap();
    assert_eq!(reopened.id, info.id);
    assert!(warnings.is_empty(), "a clean upgrade must report no per-file warnings: {warnings:?}");

    let items = mgr
        .list_all(&ListFilter { project_id: Some(info.id.clone()), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(items.len(), 3, "every pre-0008 item must survive the upgrade");
    let status_of = |id: &str| items.iter().find(|i| i.id == id).unwrap().status;
    assert_eq!(status_of(&todo.id), Some(Status::Todo));
    assert_eq!(status_of(&doing.id), Some(Status::Doing));
    assert_eq!(status_of(&done.id), Some(Status::Done));

    // FTS must still find each pre-existing item post-upgrade.
    for word in ["lighthouse", "harbor", "buoy"] {
        let hits = mgr.search_all(word, &ListFilter::default()).await.unwrap();
        assert_eq!(hits.len(), 1, "search for {word:?} must find exactly the item that carries it");
    }

    // A NEW task, in the status this migration exists to add, created AFTER
    // the upgrade — exercises the LIVE insert trigger.
    let testing = mgr
        .create(NewItem {
            status: Some(Status::Testing),
            ..new_item(&info.id, Kind::Task, "sea-trial the replacement generator")
        })
        .await
        .unwrap();
    assert_eq!(mgr.get(&testing.id).await.unwrap().status, Some(Status::Testing));
    let testing_hits = mgr.search_all("sea-trial", &ListFilter::default()).await.unwrap();
    assert_eq!(testing_hits.len(), 1, "a post-upgrade item must be searchable via the live insert trigger");

    // (2) Second reopen: the KNOWN_TRIGGERS gate runs BEFORE migrations on
    // every open, so a wrong-named recreated trigger would pass the FIRST
    // reopen (0008 hadn't run yet when the gate checked) and only be rejected
    // as foreign here.
    mgr.unload(&info.id).await.unwrap();
    let (second, second_warnings) = mgr.load(&info.id).await.unwrap();
    assert_eq!(second.id, info.id, "the recreated triggers must not be rejected as a foreign DB");
    assert!(second_warnings.is_empty());

    let survivors = mgr
        .list_all(&ListFilter { project_id: Some(info.id.clone()), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(survivors.len(), 4, "all four items — three pre-upgrade plus the post-upgrade one — persist");
}

#[tokio::test]
async fn migration_0008_preserves_row_count_and_rowids_on_a_raw_pre_0008_db() {
    // Stage-1 safety property (D4): `migrate_db_to_files` runs migrations on an
    // existing project.db BEFORE exporting its rows to files, and the
    // pre-stage2 backup is taken AFTER migration — a truncating rewrite in
    // 0008 would silently and unrecoverably empty such a store. This pins the
    // migration ALONE, applied directly to a DB it did not create, preserving
    // both row COUNT and each row's rowid (items_fts is keyed on rowid).
    let dir = tempdir().unwrap();
    let path = dir.path().join("raw.db");
    build_pre_0008_index(&path, "raw-project", "Raw").await;

    let insert_options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(false)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(insert_options)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO items (id, kind, title, status, created_at, updated_at) \
         VALUES ('row-one', 'task', 'First raw row', 'todo', ?1, ?1)",
    )
    .bind("2026-07-14T00:00:00.000+00:00")
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO items (id, kind, title, created_at, updated_at) \
         VALUES ('row-two', 'note', 'Second raw row needle', ?1, ?1)",
    )
    .bind("2026-07-14T00:00:00.000+00:00")
    .execute(&pool)
    .await
    .unwrap();

    let before: Vec<(i64, String)> = sqlx::query_as("SELECT rowid, id FROM items ORDER BY rowid")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(before.len(), 2, "sanity: both raw rows landed");
    pool.close().await;

    // Run the FULL migrator (through 0008) directly over this raw DB.
    let migrate_options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(false)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(migrate_options)
        .await
        .unwrap();
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();

    let after: Vec<(i64, String)> = sqlx::query_as("SELECT rowid, id FROM items ORDER BY rowid")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(after.len(), before.len(), "row COUNT must be unchanged by the rebuild — never truncated");
    assert_eq!(after, before, "each row's (rowid, id) pair must survive the rebuild identically");

    // items_fts must still find a title word, joined back on rowid — proves
    // the external-content index stayed aligned through the table swap.
    let hit: Option<(i64,)> = sqlx::query_as(
        "SELECT i.rowid FROM items i JOIN items_fts ON items_fts.rowid = i.rowid \
         WHERE items_fts MATCH 'needle'",
    )
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert!(hit.is_some(), "items_fts must still find a title word by rowid after the migration");

    pool.close().await;
}

#[tokio::test]
async fn create_prompt_lands_only_in_target_store() {
    let (mgr, _app) = new_manager().await;
    let (a, _dir_a) = create_project(&mgr, "Alpha").await;
    let (b, _dir_b) = create_project(&mgr, "Beta").await;

    let prompt_a = mgr.create_prompt(new_prompt(&a.id, "in alpha", "body")).await.unwrap();
    assert_eq!(prompt_a.project_id.as_deref(), Some(a.id.as_str()));

    let only_a = mgr
        .list_prompts(&PromptListFilter { project_id: Some(a.id.clone()), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(only_a.len(), 1);
    assert_eq!(only_a[0].id, prompt_a.id);

    let only_b = mgr
        .list_prompts(&PromptListFilter { project_id: Some(b.id.clone()), ..Default::default() })
        .await
        .unwrap();
    assert!(only_b.is_empty(), "a prompt created into A must never appear when scoped to B");
}

#[tokio::test]
async fn list_prompts_without_a_project_id_requires_reusable_only() {
    // Prompts have no cross-store "dump everything" fan-out: a projectId-less
    // request is rejected UNLESS it explicitly asks for the reusable-only union
    // (plan.9 §8) — omitting projectId must never dump every private prompt in
    // every loaded project, but an explicit reusableOnly=true fan-out is fine.
    let (mgr, _app) = new_manager().await;
    let (_a, _dir_a) = create_project(&mgr, "Alpha").await;

    assert!(
        matches!(
            mgr.list_prompts(&PromptListFilter::default()).await.unwrap_err(),
            AppError::Invalid(_)
        ),
        "default filter (reusableOnly unset) with no projectId must be rejected"
    );
    assert!(
        matches!(
            mgr.list_prompts(&PromptListFilter { project_id: Some("   ".into()), ..Default::default() })
                .await
                .unwrap_err(),
            AppError::Invalid(_)
        ),
        "a blank projectId is treated as absent and must be rejected"
    );
    assert!(
        matches!(
            mgr.list_prompts(&PromptListFilter { reusable_only: Some(false), ..Default::default() })
                .await
                .unwrap_err(),
            AppError::Invalid(_)
        ),
        "an explicit non-reusable request with no projectId must still be rejected"
    );

    // But an explicit reusable-only fan-out with no projectId is accepted.
    assert!(
        mgr.list_prompts(&PromptListFilter { reusable_only: Some(true), ..Default::default() })
            .await
            .is_ok(),
        "reusableOnly=true with no projectId must fan out, not error"
    );
}

// ---------------------------------------------------------------------------
// Cross-project reusable-prompt fan-out (plan.9 §8): `list_prompts` with no
// `projectId` and `reusableOnly: true` unions every loaded store's REUSABLE
// prompts, stamped with each prompt's TRUE owning-store UUID, k-way-merged
// newest-first and deduped by id.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn list_prompts_fan_out_stamps_each_prompt_with_its_true_owning_project() {
    let (mgr, _app) = new_manager().await;
    let (a, _dir_a) = create_project(&mgr, "Alpha").await;
    let (b, _dir_b) = create_project(&mgr, "Beta").await;

    let pa = mgr
        .create_prompt(NewPrompt { reusable: Some(true), ..new_prompt(&a.id, "alpha reusable", "body") })
        .await
        .unwrap();
    let pb = mgr
        .create_prompt(NewPrompt { reusable: Some(true), ..new_prompt(&b.id, "beta reusable", "body") })
        .await
        .unwrap();

    let union = mgr
        .list_prompts(&PromptListFilter { reusable_only: Some(true), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(union.len(), 2);
    let owner_of = |id: &str| union.iter().find(|p| p.id == id).and_then(|p| p.project_id.clone());
    assert_eq!(
        owner_of(&pa.id),
        Some(a.id.clone()),
        "alpha's prompt must be stamped with alpha's id, its TRUE owner, not the caller's"
    );
    assert_eq!(owner_of(&pb.id), Some(b.id.clone()), "beta's prompt must be stamped with beta's id");
}

#[tokio::test]
async fn list_prompts_with_project_id_still_returns_only_that_projects_prompts() {
    // Regression for the new fan-out branch: a scoped request must stay
    // single-store even though BOTH projects carry reusable prompts.
    let (mgr, _app) = new_manager().await;
    let (a, _dir_a) = create_project(&mgr, "Alpha").await;
    let (b, _dir_b) = create_project(&mgr, "Beta").await;
    mgr.create_prompt(NewPrompt { reusable: Some(true), ..new_prompt(&a.id, "a", "b") }).await.unwrap();
    mgr.create_prompt(NewPrompt { reusable: Some(true), ..new_prompt(&b.id, "b", "b") }).await.unwrap();

    let only_a = mgr
        .list_prompts(&PromptListFilter { project_id: Some(a.id.clone()), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(only_a.len(), 1, "scoping to A must never pull in B's prompt even though both are reusable");
    assert_eq!(only_a[0].project_id.as_deref(), Some(a.id.as_str()));
}

#[tokio::test]
async fn list_prompts_fan_out_excludes_non_reusable_but_scoped_list_still_sees_it() {
    let (mgr, _app) = new_manager().await;
    let (a, _dir_a) = create_project(&mgr, "Alpha").await;
    let reusable = mgr
        .create_prompt(NewPrompt { reusable: Some(true), ..new_prompt(&a.id, "reusable", "b") })
        .await
        .unwrap();
    let private = mgr.create_prompt(new_prompt(&a.id, "private", "b")).await.unwrap();

    let union = mgr
        .list_prompts(&PromptListFilter { reusable_only: Some(true), ..Default::default() })
        .await
        .unwrap();
    let union_ids: Vec<&str> = union.iter().map(|p| p.id.as_str()).collect();
    assert!(union_ids.contains(&reusable.id.as_str()));
    assert!(
        !union_ids.contains(&private.id.as_str()),
        "a non-reusable prompt must never leak into the omitted-projectId union"
    );

    // But scoped to its own project with no reusable filter, the private prompt
    // IS returned.
    let scoped = mgr
        .list_prompts(&PromptListFilter { project_id: Some(a.id.clone()), reusable_only: None })
        .await
        .unwrap();
    let scoped_ids: Vec<&str> = scoped.iter().map(|p| p.id.as_str()).collect();
    assert!(scoped_ids.contains(&private.id.as_str()), "scoped to A, the private prompt is returned");
    assert!(scoped_ids.contains(&reusable.id.as_str()));
}

#[tokio::test]
async fn list_prompts_fan_out_k_way_merges_by_recency_not_concatenation() {
    let (mgr, _app) = new_manager().await;
    let (a, _dir_a) = create_project(&mgr, "Alpha").await;
    let (b, _dir_b) = create_project(&mgr, "Beta").await;

    let ts_old = "2026-07-14T00:00:01.000+00:00";
    let ts_mid = "2026-07-14T00:00:02.000+00:00";
    let ts_new = "2026-07-14T00:00:03.000+00:00";

    let a_old = mgr
        .create_prompt(NewPrompt { reusable: Some(true), ..new_prompt(&a.id, "a-old", "b") })
        .await
        .unwrap();
    let a_new = mgr
        .create_prompt(NewPrompt { reusable: Some(true), ..new_prompt(&a.id, "a-new", "b") })
        .await
        .unwrap();
    let b_mid = mgr
        .create_prompt(NewPrompt { reusable: Some(true), ..new_prompt(&b.id, "b-mid", "b") })
        .await
        .unwrap();

    pin_prompt_updated_at(&mgr, &a, &a_old.id, ts_old).await;
    pin_prompt_updated_at(&mgr, &a, &a_new.id, ts_new).await;
    pin_prompt_updated_at(&mgr, &b, &b_mid.id, ts_mid).await;

    let union = mgr
        .list_prompts(&PromptListFilter { reusable_only: Some(true), ..Default::default() })
        .await
        .unwrap();
    let ids: Vec<&str> = union.iter().map(|p| p.id.as_str()).collect();
    // A naive per-store concatenation could never produce this interleave
    // (b-mid sits strictly between a-new and a-old): only a real k-way merge does.
    assert_eq!(ids, vec![a_new.id.as_str(), b_mid.id.as_str(), a_old.id.as_str()]);
}

#[tokio::test]
async fn list_prompts_fan_out_tiebreaks_equal_updated_at_by_id_ascending_deterministically() {
    let (mgr, _app) = new_manager().await;
    let (a, _dir_a) = create_project(&mgr, "Alpha").await;
    let (b, _dir_b) = create_project(&mgr, "Beta").await;
    let ts = "2026-07-14T00:00:00.000+00:00";

    let pa = mgr.create_prompt(NewPrompt { reusable: Some(true), ..new_prompt(&a.id, "a", "b") }).await.unwrap();
    let pb = mgr.create_prompt(NewPrompt { reusable: Some(true), ..new_prompt(&b.id, "b", "b") }).await.unwrap();
    pin_prompt_updated_at(&mgr, &a, &pa.id, ts).await;
    pin_prompt_updated_at(&mgr, &b, &pb.id, ts).await;

    let (lo, hi) = if pa.id < pb.id { (pa.id.clone(), pb.id.clone()) } else { (pb.id.clone(), pa.id.clone()) };

    for attempt in 0..3 {
        let union = mgr
            .list_prompts(&PromptListFilter { reusable_only: Some(true), ..Default::default() })
            .await
            .unwrap();
        let ids: Vec<&str> = union.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![lo.as_str(), hi.as_str()],
            "attempt {attempt}: equal updated_at must tiebreak by id ASC, stably across repeated calls"
        );
    }
}

#[tokio::test]
async fn list_prompts_fan_out_returns_both_prompts_sharing_a_title_across_projects() {
    let (mgr, _app) = new_manager().await;
    let (a, _dir_a) = create_project(&mgr, "Alpha").await;
    let (b, _dir_b) = create_project(&mgr, "Beta").await;
    let pa = mgr
        .create_prompt(NewPrompt { reusable: Some(true), ..new_prompt(&a.id, "release email", "a body") })
        .await
        .unwrap();
    let pb = mgr
        .create_prompt(NewPrompt { reusable: Some(true), ..new_prompt(&b.id, "release email", "b body") })
        .await
        .unwrap();

    let union = mgr
        .list_prompts(&PromptListFilter { reusable_only: Some(true), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(union.len(), 2, "same-titled reusable prompts in two projects must both appear");
    let ids: Vec<&str> = union.iter().map(|p| p.id.as_str()).collect();
    assert!(ids.contains(&pa.id.as_str()) && ids.contains(&pb.id.as_str()), "assert on id, not title");
}

#[tokio::test]
async fn list_prompts_fan_out_dedupes_a_pathological_shared_id_across_two_stores() {
    // Real UUIDs never collide across projects; this reachable-only-via-crafted-
    // files scenario proves the manager-level dedup (not just the unit-tested
    // merge in `merge_tests::prompts_same_id_from_two_stores_collapses_to_one`)
    // holds end to end through the file-store rebuild path.
    let (mgr, _app) = new_manager().await;
    let (a, dir_a) = create_project(&mgr, "Alpha").await;
    let (b, dir_b) = create_project(&mgr, "Beta").await;

    let shared_id = "99999999-9999-9999-9999-999999999999";
    let version_id_a = "aaaaaaaa-1111-1111-1111-111111111111";
    let version_id_b = "bbbbbbbb-2222-2222-2222-222222222222";
    let ts = "2026-07-14T00:00:00.000+00:00";

    for (dir, version_id, title) in
        [(dir_a.path(), version_id_a, "from alpha"), (dir_b.path(), version_id_b, "from beta")]
    {
        let prompts_dir = dir.join("prompts");
        promptfile::write_prompt(
            &prompts_dir,
            &promptfile::PromptRecord { id: shared_id.into(), reusable: true, created_at: ts.into(), schema_version: "1.0.0".into() },
        )
        .unwrap();
        promptfile::write_version(
            &prompts_dir,
            &promptfile::PromptVersionRecord {
                id: version_id.into(),
                prompt_id: shared_id.into(),
                title: title.into(),
                body: "body".into(),
                source: "manual".into(),
                created_at: ts.into(),
            },
        )
        .unwrap();
    }

    mgr.reload(&a.id).await.unwrap();
    mgr.reload(&b.id).await.unwrap();

    let union = mgr
        .list_prompts(&PromptListFilter { reusable_only: Some(true), ..Default::default() })
        .await
        .unwrap();
    let matches = union.iter().filter(|p| p.id == shared_id).count();
    assert_eq!(matches, 1, "the same prompt id surfacing from two loaded stores must collapse to one row");
}

#[tokio::test]
async fn list_prompts_fan_out_drops_a_prompt_when_its_owning_project_is_unloaded() {
    let (mgr, _app) = new_manager().await;
    let (a, _dir_a) = create_project(&mgr, "Alpha").await;
    let (b, _dir_b) = create_project(&mgr, "Beta").await;
    let pa = mgr.create_prompt(NewPrompt { reusable: Some(true), ..new_prompt(&a.id, "a", "b") }).await.unwrap();
    let pb = mgr.create_prompt(NewPrompt { reusable: Some(true), ..new_prompt(&b.id, "b", "b") }).await.unwrap();

    assert_eq!(
        mgr.list_prompts(&PromptListFilter { reusable_only: Some(true), ..Default::default() })
            .await
            .unwrap()
            .len(),
        2
    );

    mgr.unload(&a.id).await.unwrap();

    let union = mgr
        .list_prompts(&PromptListFilter { reusable_only: Some(true), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(union.len(), 1, "unloading alpha must drop its reusable prompt from the union");
    assert_eq!(union[0].id, pb.id, "beta's prompt remains");
    let ids: Vec<&str> = union.iter().map(|p| p.id.as_str()).collect();
    assert!(!ids.contains(&pa.id.as_str()));
}

#[tokio::test]
async fn list_prompts_fan_out_with_zero_loaded_projects_is_empty_not_an_error() {
    let (mgr, _app) = new_manager().await;
    let union = mgr
        .list_prompts(&PromptListFilter { reusable_only: Some(true), ..Default::default() })
        .await
        .unwrap();
    assert!(union.is_empty(), "zero loaded projects must yield an empty Ok, not an error");
}

#[tokio::test]
async fn list_prompts_fan_out_with_a_single_loaded_project_matches_scoping_to_it() {
    let (mgr, _app) = new_manager().await;
    let (a, _dir_a) = create_project(&mgr, "Alpha").await;
    mgr.create_prompt(NewPrompt { reusable: Some(true), ..new_prompt(&a.id, "one", "b") }).await.unwrap();
    mgr.create_prompt(NewPrompt { reusable: Some(true), ..new_prompt(&a.id, "two", "b") }).await.unwrap();
    mgr.create_prompt(new_prompt(&a.id, "private", "b")).await.unwrap(); // non-reusable — must not appear either way

    let fanned = mgr
        .list_prompts(&PromptListFilter { reusable_only: Some(true), ..Default::default() })
        .await
        .unwrap();
    let scoped = mgr
        .list_prompts(&PromptListFilter { project_id: Some(a.id.clone()), reusable_only: Some(true) })
        .await
        .unwrap();
    let fanned_ids: Vec<&str> = fanned.iter().map(|p| p.id.as_str()).collect();
    let scoped_ids: Vec<&str> = scoped.iter().map(|p| p.id.as_str()).collect();
    assert_eq!(
        fanned_ids, scoped_ids,
        "with only one loaded project, the omitted-projectId fan-out must degenerate to that \
         project's reusable prompts, in the same order as scoping to it"
    );
    assert_eq!(fanned_ids.len(), 2);
}

#[tokio::test]
async fn list_prompts_fan_out_reflects_a_reload_mid_session_not_stale_data() {
    let (mgr, _app) = new_manager().await;
    let (a, dir_a) = create_project(&mgr, "Alpha").await;
    let (b, _dir_b) = create_project(&mgr, "Beta").await;
    mgr.create_prompt(NewPrompt { reusable: Some(true), ..new_prompt(&b.id, "beta reusable", "b") })
        .await
        .unwrap();

    assert_eq!(
        mgr.list_prompts(&PromptListFilter { reusable_only: Some(true), ..Default::default() })
            .await
            .unwrap()
            .len(),
        1
    );

    // A reusable prompt appears directly on A's disk (simulating a git pull) —
    // invisible until A is reloaded.
    let pulled_id = "12121212-1212-1212-1212-121212121212";
    let pulled_version_id = "34343434-3434-3434-3434-343434343434";
    let ts = "2026-07-14T00:00:00.000+00:00";
    let prompts_dir = dir_a.path().join("prompts");
    promptfile::write_prompt(
        &prompts_dir,
        &promptfile::PromptRecord { id: pulled_id.into(), reusable: true, created_at: ts.into(), schema_version: "1.0.0".into() },
    )
    .unwrap();
    promptfile::write_version(
        &prompts_dir,
        &promptfile::PromptVersionRecord {
            id: pulled_version_id.into(),
            prompt_id: pulled_id.into(),
            title: "pulled reusable".into(),
            body: "body".into(),
            source: "manual".into(),
            created_at: ts.into(),
        },
    )
    .unwrap();

    let before_reload = mgr
        .list_prompts(&PromptListFilter { reusable_only: Some(true), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(before_reload.len(), 1, "the pulled-in file is invisible until A is reloaded");

    mgr.reload(&a.id).await.unwrap();

    let after_reload = mgr
        .list_prompts(&PromptListFilter { reusable_only: Some(true), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(after_reload.len(), 2, "reload must pick up the new reusable prompt into the union");
    let ids: Vec<&str> = after_reload.iter().map(|p| p.id.as_str()).collect();
    assert!(ids.contains(&pulled_id));
}

#[tokio::test]
async fn reload_rebuilds_prompts_and_full_history_from_files_out_of_band() {
    // Post-`git pull` for prompts (H3): a new prompt's files appear, another
    // prompt's directory vanishes; reload rebuilds the prompt index — WITH
    // full version history — from what's on disk. Mirrors
    // `reload_picks_up_files_added_and_removed_out_of_band` for items.
    let (mgr, _app) = new_manager().await;
    let (info, dir) = create_project(&mgr, "Alpha").await;
    let prompts_dir = dir.path().join("prompts");

    let kept = mgr.create_prompt(new_prompt(&info.id, "kept", "v1 body")).await.unwrap();
    mgr.update_prompt(&kept.id, UpdatePrompt { body: Some("v2 body".into()), ..Default::default() })
        .await
        .unwrap();
    let removed = mgr.create_prompt(new_prompt(&info.id, "removed", "bye")).await.unwrap();

    // Simulate a pull: a new prompt's files appear directly on disk...
    let pulled_id = "11111111-1111-1111-1111-111111111111";
    let pulled_version_id = "22222222-2222-2222-2222-222222222222";
    let ts = "2026-07-14T00:00:00.000+00:00";
    promptfile::write_prompt(
        &prompts_dir,
        &promptfile::PromptRecord { id: pulled_id.into(), reusable: false, created_at: ts.into(), schema_version: "1.0.0".into() },
    )
    .unwrap();
    promptfile::write_version(
        &prompts_dir,
        &promptfile::PromptVersionRecord {
            id: pulled_version_id.into(),
            prompt_id: pulled_id.into(),
            title: "pulled in".into(),
            body: "pulled body".into(),
            source: "manual".into(),
            created_at: ts.into(),
        },
    )
    .unwrap();
    // ...and a prompt's directory is removed (deleted on another clone).
    std::fs::remove_dir_all(prompts_dir.join(removed.id.as_str())).unwrap();

    let warnings = mgr.reload(&info.id).await.unwrap();
    assert!(warnings.is_empty(), "clean files reload without warnings: {warnings:?}");

    let listed = mgr
        .list_prompts(&PromptListFilter { project_id: Some(info.id.clone()), ..Default::default() })
        .await
        .unwrap();
    let titles: Vec<&str> = listed.iter().map(|p| p.title.as_str()).collect();
    assert_eq!(listed.len(), 2, "removed prompt is gone; kept + pulled-in remain");
    assert!(titles.contains(&"kept"), "an untouched prompt survives reload");
    assert!(titles.contains(&"pulled in"), "a pulled-in prompt appears after reload");
    assert!(!titles.contains(&"removed"), "a deleted prompt dir is gone after reload");

    // The kept prompt's FULL two-version history survives the rebuild.
    let hist = mgr.prompt_versions(&kept.id).await.unwrap();
    assert_eq!(hist.len(), 2, "the multi-version prompt's full history survives the rebuild");
    let bodies: Vec<&str> = hist.iter().map(|v| v.body.as_str()).collect();
    assert!(bodies.contains(&"v1 body") && bodies.contains(&"v2 body"));
}

#[tokio::test]
async fn missing_prompt_md_is_synthesized_with_all_versions_intact() {
    // A prompt dir carrying version files but no `prompt.md` is synthesized on
    // scan (reusable=false) rather than dropped — versions must never be
    // orphaned (H2/plan.7 Section 5). Mirrors
    // `a_git_clone_with_only_item_files_builds_a_fresh_index_on_open` for items.
    let (mgr, _app) = new_manager().await;
    let dir = tempdir().unwrap();
    let items_dir = dir.path().join("items");
    std::fs::create_dir_all(&items_dir).unwrap();
    std::fs::write(
        items_dir.join("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.md"),
        note_md("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "an item"),
    )
    .unwrap();

    let prompts_dir = dir.path().join("prompts");
    let pid = "33333333-3333-3333-3333-333333333333";
    let v1 = "44444444-4444-4444-4444-444444444444";
    let v2 = "55555555-5555-5555-5555-555555555555";
    let ts1 = "2026-07-14T00:00:00.000+00:00";
    let ts2 = "2026-07-14T01:00:00.000+00:00";
    promptfile::write_version(
        &prompts_dir,
        &promptfile::PromptVersionRecord {
            id: v1.into(),
            prompt_id: pid.into(),
            title: "orphan v1".into(),
            body: "b1".into(),
            source: "manual".into(),
            created_at: ts1.into(),
        },
    )
    .unwrap();
    promptfile::write_version(
        &prompts_dir,
        &promptfile::PromptVersionRecord {
            id: v2.into(),
            prompt_id: pid.into(),
            title: "orphan v2".into(),
            body: "b2".into(),
            source: "manual".into(),
            created_at: ts2.into(),
        },
    )
    .unwrap();
    // No prompt.md written at all — an orphaned-version case.

    let info = mgr.open_project(dir.path().to_str().unwrap()).await.unwrap();

    let listed = mgr
        .list_prompts(&PromptListFilter { project_id: Some(info.id.clone()), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(listed.len(), 1, "the version-only prompt dir is synthesized into a prompt row");
    assert_eq!(listed[0].id, pid);
    assert!(!listed[0].reusable, "a synthesized prompt defaults to reusable=false");
    assert_eq!(listed[0].title, "orphan v2", "current version = newest by created_at");

    let hist = mgr.prompt_versions(pid).await.unwrap();
    assert_eq!(hist.len(), 2, "both versions are intact under the synthesized prompt");
}

#[tokio::test]
async fn reload_reports_a_conflict_marker_prompt_version_and_imports_the_rest() {
    // Per-file partial success for prompt versions: a file with unresolved git
    // conflict markers is skipped and reported; its clean sibling version
    // (same prompt) and an unrelated clean prompt still import. Mirrors
    // `reload_reports_conflict_marker_files_and_imports_the_rest` for items.
    let (mgr, _app) = new_manager().await;
    let (info, dir) = create_project(&mgr, "Alpha").await;
    let prompts_dir = dir.path().join("prompts");

    mgr.create_prompt(new_prompt(&info.id, "clean prompt", "body")).await.unwrap();

    let pid2 = "66666666-6666-6666-6666-666666666666";
    let good_version = "77777777-7777-7777-7777-777777777777";
    let bad_version = "88888888-8888-8888-8888-888888888888";
    let ts = "2026-07-14T00:00:00.000+00:00";
    promptfile::write_prompt(
        &prompts_dir,
        &promptfile::PromptRecord { id: pid2.into(), reusable: false, created_at: ts.into(), schema_version: "1.0.0".into() },
    )
    .unwrap();
    promptfile::write_version(
        &prompts_dir,
        &promptfile::PromptVersionRecord {
            id: good_version.into(),
            prompt_id: pid2.into(),
            title: "surviving version".into(),
            body: "b".into(),
            source: "manual".into(),
            created_at: ts.into(),
        },
    )
    .unwrap();
    let bad_file_name = format!("{bad_version}.md");
    std::fs::write(
        prompts_dir.join(pid2).join(&bad_file_name),
        format!(
            "---\nid: {bad_version}\nsource: manual\ncreated_at: {ts}\ntitle: \"x\"\n\
             <<<<<<< HEAD\nfoo\n=======\nbar\n>>>>>>> branch\n---\nbody\n"
        ),
    )
    .unwrap();

    let warnings = mgr.reload(&info.id).await.unwrap();
    assert_eq!(warnings.len(), 1, "the one conflicted version file is reported: {warnings:?}");
    assert!(warnings[0].contains(&bad_file_name), "the warning names the offending file");
    assert!(warnings[0].to_lowercase().contains("conflict"), "the warning explains why");

    let listed = mgr
        .list_prompts(&PromptListFilter { project_id: Some(info.id.clone()), ..Default::default() })
        .await
        .unwrap();
    let titles: Vec<&str> = listed.iter().map(|p| p.title.as_str()).collect();
    assert_eq!(listed.len(), 2, "the clean prompt AND the prompt with a surviving version both import");
    assert!(titles.contains(&"clean prompt"));
    assert!(titles.contains(&"surviving version"), "the non-conflicted sibling version imports");
}

#[tokio::test]
async fn delete_files_also_removes_the_prompts_directory() {
    // H3: destructive Delete-files must sweep prompts/ too, or sensitive prompt
    // bodies would remain on disk after the user asked for them gone.
    let (mgr, _app) = new_manager().await;
    let (info, dir) = create_project(&mgr, "Alpha").await;
    mgr.create_prompt(new_prompt(&info.id, "t", "b")).await.unwrap();
    assert!(dir.path().join("prompts").is_dir(), "creating a prompt makes the prompts/ dir");

    mgr.unload(&info.id).await.unwrap();
    mgr.delete_files(&info.id).await.unwrap();

    assert!(!dir.path().join("prompts").exists(), "delete_files removes the canonical prompts/ dir");
}

// ---------------------------------------------------------------------------
// Move a prompt between projects (plan.8) — the app's first cross-store
// mutation. The user chose the ID-PRESERVING move, so these assert id EQUALITY
// (target id == source id) and full content/provenance preservation. Ordering
// (copy-all → verify → delete-source-last) is exercised end to end against real
// on-disk stores.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn move_prompt_relocates_the_prompt_with_full_history_preserved() {
    let (mgr, _app) = new_manager().await;
    let (a, dir_a) = create_project(&mgr, "Alpha").await;
    let (b, dir_b) = create_project(&mgr, "Beta").await;

    // A prompt in A with two versions of different provenance.
    let p = mgr.create_prompt(new_prompt(&a.id, "release email", "v1 body")).await.unwrap();
    mgr.update_prompt(
        &p.id,
        UpdatePrompt { body: Some("v2 body".into()), source: Some("aiEnhanced".into()), ..Default::default() },
    )
    .await
    .unwrap();
    let before = mgr.prompt_versions(&p.id).await.unwrap();
    assert_eq!(before.len(), 2);

    let moved = mgr.move_prompt(&p.id, &b.id).await.unwrap();

    // The id is PRESERVED (id-preserving move) and stamped with the target.
    assert_eq!(moved.id, p.id, "the prompt id is preserved across the move");
    assert_eq!(moved.project_id.as_deref(), Some(b.id.as_str()));

    // Source subtree gone; target has the same-id subtree with prompt.md + one
    // immutable file per version.
    assert!(!dir_a.path().join("prompts").join(&p.id).exists(), "the source prompt dir is gone");
    let tgt_dir = dir_b.path().join("prompts").join(&p.id);
    assert!(tgt_dir.join("prompt.md").is_file(), "the target has prompt.md");
    let version_files = std::fs::read_dir(&tgt_dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| {
            let name = e.file_name();
            let name = name.to_string_lossy();
            name.ends_with(".md") && name != "prompt.md"
        })
        .count();
    assert_eq!(version_files, 2, "one immutable version file per source version");

    // Full history preserved (content + provenance + order), re-read from target.
    let after = mgr.prompt_versions(&p.id).await.unwrap();
    assert_eq!(after.len(), before.len());
    for (x, y) in before.iter().zip(after.iter()) {
        assert_eq!(x.id, y.id, "version id preserved");
        assert_eq!(x.title, y.title);
        assert_eq!(x.body, y.body);
        assert_eq!(x.source, y.source, "provenance preserved");
        assert_eq!(x.created_at, y.created_at);
    }

    // get routes to the target now (prompt_owner sees a single owner — no error);
    // list scoping reflects the move.
    assert_eq!(mgr.get_prompt(&p.id).await.unwrap().project_id.as_deref(), Some(b.id.as_str()));
    let in_a = mgr
        .list_prompts(&PromptListFilter { project_id: Some(a.id.clone()), ..Default::default() })
        .await
        .unwrap();
    assert!(in_a.is_empty(), "the source project no longer lists the prompt");
    let in_b = mgr
        .list_prompts(&PromptListFilter { project_id: Some(b.id.clone()), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(in_b.len(), 1);
    assert_eq!(in_b[0].id, p.id);
}

#[tokio::test]
async fn move_prompt_survives_reload_of_both_projects() {
    // Proves the FILES (not just the index) reflect the move: after reload, the
    // rebuilt index of both projects matches — source empty, target full history.
    let (mgr, _app) = new_manager().await;
    let (a, _dir_a) = create_project(&mgr, "Alpha").await;
    let (b, _dir_b) = create_project(&mgr, "Beta").await;
    let p = mgr.create_prompt(new_prompt(&a.id, "t", "v1")).await.unwrap();
    mgr.update_prompt(&p.id, UpdatePrompt { body: Some("v2".into()), ..Default::default() }).await.unwrap();
    mgr.move_prompt(&p.id, &b.id).await.unwrap();

    mgr.reload(&a.id).await.unwrap();
    mgr.reload(&b.id).await.unwrap();

    let in_a = mgr
        .list_prompts(&PromptListFilter { project_id: Some(a.id.clone()), ..Default::default() })
        .await
        .unwrap();
    assert!(in_a.is_empty(), "after reload the source has no prompt files → empty");
    let in_b = mgr
        .list_prompts(&PromptListFilter { project_id: Some(b.id.clone()), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(in_b.len(), 1);
    let hist = mgr.prompt_versions(&p.id).await.unwrap();
    assert_eq!(hist.len(), 2, "the full history rebuilds from the target's files");
}

#[tokio::test]
async fn move_prompt_to_same_project_is_rejected_and_leaves_the_source_unchanged() {
    let (mgr, _app) = new_manager().await;
    let (a, _dir_a) = create_project(&mgr, "Alpha").await;
    let p = mgr.create_prompt(new_prompt(&a.id, "t", "b")).await.unwrap();
    assert!(matches!(mgr.move_prompt(&p.id, &a.id).await.unwrap_err(), AppError::Invalid(_)));
    // Still exactly one copy, untouched.
    let in_a = mgr
        .list_prompts(&PromptListFilter { project_id: Some(a.id.clone()), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(in_a.len(), 1);
    assert_eq!(mgr.get_prompt(&p.id).await.unwrap().id, p.id);
}

#[tokio::test]
async fn move_prompt_requires_a_loaded_target_and_an_existing_prompt() {
    let (mgr, _app) = new_manager().await;
    let (a, _dir_a) = create_project(&mgr, "Alpha").await;
    let (b, _dir_b) = create_project(&mgr, "Beta").await;
    let p = mgr.create_prompt(new_prompt(&a.id, "t", "b")).await.unwrap();

    // Unknown target id → Invalid (not loaded); empty target → Invalid.
    assert!(matches!(mgr.move_prompt(&p.id, "no-such-project").await.unwrap_err(), AppError::Invalid(_)));
    assert!(matches!(mgr.move_prompt(&p.id, "   ").await.unwrap_err(), AppError::Invalid(_)));

    // Unload B → a move to B is Invalid (target not loaded), NOT a panic.
    mgr.unload(&b.id).await.unwrap();
    assert!(matches!(mgr.move_prompt(&p.id, &b.id).await.unwrap_err(), AppError::Invalid(_)));

    // The source is untouched after every failed move.
    assert_eq!(mgr.get_prompt(&p.id).await.unwrap().id, p.id);

    // An unknown prompt id → NotFound.
    assert!(matches!(mgr.move_prompt("no-such-prompt", &a.id).await.unwrap_err(), AppError::NotFound));
}

#[tokio::test]
async fn move_prompt_preserves_reusable_updated_at_and_version_count() {
    // The test most likely to catch a naive delete+recreate that re-stamps
    // timestamps: the derived updatedAt (= newest version created_at) must be
    // byte-identical after the move, and the reusable head must travel.
    let (mgr, _app) = new_manager().await;
    let (a, _dir_a) = create_project(&mgr, "Alpha").await;
    let (b, _dir_b) = create_project(&mgr, "Beta").await;
    let p = mgr
        .create_prompt(NewPrompt { reusable: Some(true), ..new_prompt(&a.id, "t", "v1") })
        .await
        .unwrap();
    mgr.update_prompt(&p.id, UpdatePrompt { body: Some("v2".into()), ..Default::default() }).await.unwrap();
    let before = mgr.get_prompt(&p.id).await.unwrap();

    let moved = mgr.move_prompt(&p.id, &b.id).await.unwrap();
    assert!(moved.reusable, "the reusable flag travels with the prompt head");
    assert_eq!(moved.version_count, before.version_count, "the version count is unchanged");
    assert_eq!(moved.updated_at, before.updated_at, "the derived updatedAt is preserved (not re-stamped)");
    assert_eq!(moved.created_at, before.created_at, "the prompt created_at is preserved");
}

#[tokio::test]
async fn move_prompt_updates_the_prompt_count_on_both_projects() {
    // Also exercises prompt_count end to end (loaded-only, M3).
    let (mgr, _app) = new_manager().await;
    let (a, _dir_a) = create_project(&mgr, "Alpha").await;
    let (b, _dir_b) = create_project(&mgr, "Beta").await;
    let p = mgr.create_prompt(new_prompt(&a.id, "t", "b")).await.unwrap();
    mgr.create_prompt(new_prompt(&a.id, "t2", "b2")).await.unwrap();

    let before = mgr.list_projects().await.unwrap();
    assert_eq!(before.iter().find(|i| i.id == a.id).unwrap().prompt_count, Some(2));
    assert_eq!(before.iter().find(|i| i.id == b.id).unwrap().prompt_count, Some(0));

    mgr.move_prompt(&p.id, &b.id).await.unwrap();

    let after = mgr.list_projects().await.unwrap();
    assert_eq!(after.iter().find(|i| i.id == a.id).unwrap().prompt_count, Some(1), "source count −1");
    assert_eq!(after.iter().find(|i| i.id == b.id).unwrap().prompt_count, Some(1), "target count +1");
}

#[tokio::test]
async fn deleting_source_files_after_a_move_does_not_touch_the_target_copy() {
    let (mgr, _app) = new_manager().await;
    let (a, _dir_a) = create_project(&mgr, "Alpha").await;
    let (b, dir_b) = create_project(&mgr, "Beta").await;
    let p = mgr.create_prompt(new_prompt(&a.id, "t", "b")).await.unwrap();
    mgr.move_prompt(&p.id, &b.id).await.unwrap();

    // Delete the SOURCE project's files entirely; the target's copy is unaffected.
    mgr.unload(&a.id).await.unwrap();
    mgr.delete_files(&a.id).await.unwrap();

    let in_b = mgr
        .list_prompts(&PromptListFilter { project_id: Some(b.id.clone()), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(in_b.len(), 1, "the moved prompt survives deleting the source project");
    assert!(dir_b.path().join("prompts").join(&p.id).is_dir());

    // Deleting the TARGET files removes it (H3 sweep correct post-move).
    mgr.unload(&b.id).await.unwrap();
    mgr.delete_files(&b.id).await.unwrap();
    assert!(!dir_b.path().join("prompts").join(&p.id).exists());
}

// ---------------------------------------------------------------------------
// schema_version marker (plan.10, Step 6a): cross-project move and the
// reusable-only update branch must PRESERVE the prompt head's marker, never
// re-stamp it to CURRENT_SCHEMA_VERSION. Only observable with a marker that
// DIFFERS from the constant, so these write the head directly via
// promptfile::write_prompt (bypassing create(), which always mints the
// constant) and reload it into a loaded project.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn move_prompt_preserves_the_source_schema_version_not_the_current_constant() {
    let (mgr, _app) = new_manager().await;
    let (a, dir_a) = create_project(&mgr, "Alpha").await;
    let (b, _dir_b) = create_project(&mgr, "Beta").await;

    let prompt_id = "13131313-1313-1313-1313-131313131313";
    let version_id = "24242424-2424-2424-2424-242424242424";
    let ts = "2026-07-14T00:00:00.000+00:00";
    let prompts_dir = dir_a.path().join("prompts");
    promptfile::write_prompt(
        &prompts_dir,
        &promptfile::PromptRecord {
            id: prompt_id.into(),
            reusable: false,
            created_at: ts.into(),
            schema_version: "0.9.0".into(),
        },
    )
    .unwrap();
    promptfile::write_version(
        &prompts_dir,
        &promptfile::PromptVersionRecord {
            id: version_id.into(),
            prompt_id: prompt_id.into(),
            title: "old-format prompt".into(),
            body: "body".into(),
            source: "manual".into(),
            created_at: ts.into(),
        },
    )
    .unwrap();
    mgr.reload(&a.id).await.unwrap();
    assert_eq!(
        mgr.get_prompt(prompt_id).await.unwrap().schema_version,
        "0.9.0",
        "reload preserves the on-disk marker verbatim"
    );

    let moved = mgr.move_prompt(prompt_id, &b.id).await.unwrap();
    assert_eq!(
        moved.schema_version, "0.9.0",
        "move preserves the source marker rather than re-stamping to the current constant"
    );
}

#[tokio::test]
async fn reusable_toggle_on_a_legacy_prompt_preserves_its_marker_not_the_current_constant() {
    let (mgr, _app) = new_manager().await;
    let (info, dir) = create_project(&mgr, "Alpha").await;

    let prompt_id = "35353535-3535-3535-3535-353535353535";
    let version_id = "46464646-4646-4646-4646-464646464646";
    let ts = "2026-07-14T00:00:00.000+00:00";
    let prompts_dir = dir.path().join("prompts");
    promptfile::write_prompt(
        &prompts_dir,
        &promptfile::PromptRecord {
            id: prompt_id.into(),
            reusable: false,
            created_at: ts.into(),
            schema_version: "0.9.0".into(),
        },
    )
    .unwrap();
    promptfile::write_version(
        &prompts_dir,
        &promptfile::PromptVersionRecord {
            id: version_id.into(),
            prompt_id: prompt_id.into(),
            title: "old-format prompt".into(),
            body: "body".into(),
            source: "manual".into(),
            created_at: ts.into(),
        },
    )
    .unwrap();
    mgr.reload(&info.id).await.unwrap();

    let toggled = mgr
        .update_prompt(prompt_id, UpdatePrompt { reusable: Some(true), ..Default::default() })
        .await
        .unwrap();
    assert!(toggled.reusable);
    assert_eq!(
        toggled.schema_version, "0.9.0",
        "a reusable-only toggle must preserve the existing marker, not re-stamp it"
    );

    // The rewritten prompt.md on disk also carries the preserved marker.
    let head_text = std::fs::read_to_string(prompts_dir.join(prompt_id).join("prompt.md")).unwrap();
    assert!(
        head_text.contains("schema_version: 0.9.0"),
        "the rewritten head file preserves the marker: {head_text}"
    );
}

#[tokio::test]
#[ignore = "code-inspection (plan.8 §8/§12): a failed move never leaves an orphan in the target. \
            (a) import_prompt is atomic — on ANY failure (partial file write, failed commit, or the \
            post-commit read) discard_partial_import removes the files AND any committed rows, so the \
            move_prompt `?` returns Err with the source untouched and nothing phantom in the target. \
            (b) If the post-import verify (target.versions count == source count) fails OR errors, \
            move_prompt rolls back via target.delete and aborts, source untouched. Both paths need I/O \
            fault injection the public API does not expose; covered by reading the assertions."]
async fn move_prompt_rollback_leaves_source_untouched_on_import_or_verify_failure() {}

#[tokio::test]
#[ignore = "code-inspection (plan.8 §8): move_prompt never uses a cross-store fs::rename. import_prompt \
            writes each target file with promptfile::write_version (same-dir temp-then-rename inside the \
            target prompts_dir, same volume), and the source is deleted only after the target import \
            verifies — so the move is correct across arbitrary volumes without a cross-volume rename. A \
            true multi-volume harness isn't available in CI."]
async fn move_prompt_never_relies_on_a_cross_volume_rename() {}

// ---------------------------------------------------------------------------
// Capability-guard regression (plan.8 §4 H1): the webview must never be granted
// an opener path/reveal permission. "Open folder" is a Rust command keyed by id.
// ---------------------------------------------------------------------------

#[test]
fn capabilities_default_grants_no_opener_path_or_reveal_permission() {
    let capabilities = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("capabilities")
            .join("default.json"),
    )
    .expect("capabilities/default.json is readable");
    for forbidden in [
        "opener:allow-open-path",
        "opener:allow-reveal-item-in-dir",
        "allow-open-path",
        "allow-reveal-item-in-dir",
    ] {
        assert!(
            !capabilities.contains(forbidden),
            "capabilities/default.json must never grant `{forbidden}` — that would hand the webview an \
             OS-open surface that can execute a file or reveal an unscoped path (plan.8 §4 H1)"
        );
    }
}

// ---------------------------------------------------------------------------
// Scratch pad (Plan 13)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn get_scratch_on_a_freshly_created_project_is_empty_and_creates_no_file() {
    let (mgr, _app) = new_manager().await;
    let (info, dir) = create_project(&mgr, "Alpha").await;

    assert_eq!(mgr.get_scratch(&info.id).await.unwrap(), "");
    assert!(!dir.path().join("scratch.md").exists(), "a read-only get must never create the file");
}

#[tokio::test]
async fn set_scratch_then_get_scratch_round_trips_and_writes_scratch_md_at_the_project_root() {
    let (mgr, _app) = new_manager().await;
    let (info, dir) = create_project(&mgr, "Alpha").await;

    mgr.set_scratch(&info.id, "quick capture\nsecond line").await.unwrap();

    assert_eq!(mgr.get_scratch(&info.id).await.unwrap(), "quick capture\nsecond line");
    let path = dir.path().join("scratch.md");
    assert!(path.exists(), "scratch.md must live at the project root");
    assert!(!dir.path().join("items").join("scratch.md").exists(), "never written inside items/");
    let bytes = std::fs::read(&path).unwrap();
    assert_eq!(bytes, b"quick capture\nsecond line", "bytes on disk must equal the body exactly");
}

#[tokio::test]
async fn get_scratch_and_set_scratch_on_an_unloaded_project_are_rejected_as_invalid() {
    let (mgr, _app) = new_manager().await;
    let (info, dir) = create_project(&mgr, "Alpha").await;
    mgr.set_scratch(&info.id, "before unload").await.unwrap();
    mgr.unload(&info.id).await.unwrap();

    match mgr.get_scratch(&info.id).await.unwrap_err() {
        AppError::Invalid(msg) => assert!(msg.contains("isn't loaded"), "got: {msg}"),
        other => panic!("expected Invalid(\"...isn't loaded...\"), got {other:?}"),
    }
    match mgr.set_scratch(&info.id, "after unload").await.unwrap_err() {
        AppError::Invalid(msg) => assert!(msg.contains("isn't loaded"), "got: {msg}"),
        other => panic!("expected Invalid(\"...isn't loaded...\"), got {other:?}"),
    }

    let on_disk = std::fs::read_to_string(dir.path().join("scratch.md")).unwrap();
    assert_eq!(on_disk, "before unload", "a rejected write on an unloaded project must not touch the file");
}

#[tokio::test]
async fn get_scratch_and_set_scratch_of_an_unknown_project_id_are_rejected_cleanly_never_panic() {
    // Naming deviation from the plan's proposed
    // `get_scratch_and_set_scratch_of_an_unknown_project_id_are_clean_not_found`:
    // both methods (`projects/mod.rs` ~453/468) check `is_loaded` FIRST, and an
    // unknown id is trivially "not loaded" — so the ACTUAL behaviour is a clean
    // `AppError::Invalid("that project isn't loaded")`, never `AppError::NotFound`.
    // This test pins the real behaviour under a name that says so.
    let (mgr, _app) = new_manager().await;

    match mgr.get_scratch("does-not-exist").await.unwrap_err() {
        AppError::Invalid(msg) => assert!(msg.contains("isn't loaded"), "got: {msg}"),
        other => panic!("expected a clean Invalid(\"...isn't loaded...\"), got {other:?}"),
    }
    match mgr.set_scratch("does-not-exist", "x").await.unwrap_err() {
        AppError::Invalid(msg) => assert!(msg.contains("isn't loaded"), "got: {msg}"),
        other => panic!("expected a clean Invalid(\"...isn't loaded...\"), got {other:?}"),
    }
}

#[tokio::test]
async fn set_scratch_rejects_an_oversized_body_and_leaves_prior_content_untouched() {
    let (mgr, _app) = new_manager().await;
    let (info, _dir) = create_project(&mgr, "Alpha").await;
    mgr.set_scratch(&info.id, "the prior content").await.unwrap();

    let oversized = "a".repeat(4 * 1024 * 1024 + 1);
    match mgr.set_scratch(&info.id, &oversized).await.unwrap_err() {
        AppError::Invalid(msg) => assert!(msg.contains("too large to save"), "got: {msg}"),
        other => panic!("expected Invalid(\"...too large to save...\"), got {other:?}"),
    }

    assert_eq!(mgr.get_scratch(&info.id).await.unwrap(), "the prior content");
}

#[tokio::test]
async fn set_scratch_does_not_bump_any_item_updated_at_or_reorder_the_list() {
    let (mgr, _app) = new_manager().await;
    let (info, _dir) = create_project(&mgr, "Alpha").await;
    mgr.create(new_item(&info.id, Kind::Note, "first")).await.unwrap();
    mgr.create(new_item(&info.id, Kind::Note, "second")).await.unwrap();

    let before: Vec<(String, String)> = mgr
        .list_all(&ListFilter::default())
        .await
        .unwrap()
        .into_iter()
        .map(|i| (i.id, i.updated_at))
        .collect();

    mgr.set_scratch(&info.id, "unrelated pad content").await.unwrap();

    let after: Vec<(String, String)> = mgr
        .list_all(&ListFilter::default())
        .await
        .unwrap()
        .into_iter()
        .map(|i| (i.id, i.updated_at))
        .collect();

    assert_eq!(before, after, "set_scratch must not touch any item's updated_at or the list order");
}

#[tokio::test]
async fn scratch_survives_unload_and_load() {
    let (mgr, _app) = new_manager().await;
    let (info, dir) = create_project(&mgr, "Alpha").await;
    mgr.set_scratch(&info.id, "persisted across unload").await.unwrap();

    mgr.unload(&info.id).await.unwrap();
    // "Load" here is `open_project` on the same folder — reads from disk, not a
    // cache; `ProjectManager` caches nothing about scratch content in memory.
    let reopened = mgr.open_project(dir.path().to_str().unwrap()).await.unwrap();

    assert_eq!(mgr.get_scratch(&reopened.id).await.unwrap(), "persisted across unload");
}

#[tokio::test]
async fn reload_project_keeps_scratch_content() {
    let (mgr, _app) = new_manager().await;
    let (info, _dir) = create_project(&mgr, "Alpha").await;
    mgr.set_scratch(&info.id, "still here after reload").await.unwrap();

    mgr.reload(&info.id).await.unwrap();

    assert_eq!(mgr.get_scratch(&info.id).await.unwrap(), "still here after reload");
}

#[tokio::test]
async fn rename_project_does_not_touch_scratch_md() {
    let (mgr, _app) = new_manager().await;
    let (info, dir) = create_project(&mgr, "Alpha").await;
    mgr.set_scratch(&info.id, "unrelated to the project's name").await.unwrap();
    let before = std::fs::read(dir.path().join("scratch.md")).unwrap();

    mgr.rename(&info.id, "Renamed").await.unwrap();

    let after = std::fs::read(dir.path().join("scratch.md")).unwrap();
    assert_eq!(before, after, "rename must not touch scratch.md's bytes");
}

#[tokio::test]
async fn forget_project_leaves_scratch_md_on_disk() {
    let (mgr, _app) = new_manager().await;
    let (info, dir) = create_project(&mgr, "Alpha").await;
    mgr.set_scratch(&info.id, "forget must not touch this").await.unwrap();

    mgr.unload(&info.id).await.unwrap();
    mgr.forget(&info.id).await.unwrap();

    assert!(dir.path().join("scratch.md").exists(), "forget only drops the catalog row");
    assert_eq!(
        std::fs::read_to_string(dir.path().join("scratch.md")).unwrap(),
        "forget must not touch this"
    );
}

#[tokio::test]
async fn scratch_is_isolated_per_project() {
    let (mgr, _app) = new_manager().await;
    let (a, _dir_a) = create_project(&mgr, "Alpha").await;
    let (b, _dir_b) = create_project(&mgr, "Beta").await;

    mgr.set_scratch(&a.id, "alpha's pad").await.unwrap();
    mgr.set_scratch(&b.id, "beta's pad").await.unwrap();

    assert_eq!(mgr.get_scratch(&a.id).await.unwrap(), "alpha's pad");
    assert_eq!(mgr.get_scratch(&b.id).await.unwrap(), "beta's pad");

    mgr.set_scratch(&a.id, "alpha's pad, edited").await.unwrap();
    assert_eq!(mgr.get_scratch(&a.id).await.unwrap(), "alpha's pad, edited");
    assert_eq!(mgr.get_scratch(&b.id).await.unwrap(), "beta's pad", "editing one pad must not touch the other");
}

#[tokio::test]
async fn open_project_on_a_moved_directory_serves_the_moved_scratch() {
    let (mgr, _app) = new_manager().await;
    let (info, dir_original) = create_project(&mgr, "Alpha").await;
    mgr.set_scratch(&info.id, "moved with the project").await.unwrap();
    mgr.unload(&info.id).await.unwrap();

    let dir_moved = tempdir().unwrap();
    move_store_files(dir_original.path(), dir_moved.path());

    let reopened = mgr.open_project(dir_moved.path().to_str().unwrap()).await.unwrap();
    assert_eq!(mgr.get_scratch(&reopened.id).await.unwrap(), "moved with the project");
}

#[tokio::test]
async fn opening_a_pre_feature_project_directory_with_no_scratch_md_loads_all_items_and_reads_empty_scratch() {
    // Models an older-build project directory: it never wrote scratch.md, so
    // this build must open it with no data loss and an empty pad (the
    // older-build direction of the compatibility rule).
    let (mgr, _app) = new_manager().await;
    let (info, dir) = create_project(&mgr, "Alpha").await;
    mgr.create(new_item(&info.id, Kind::Note, "pre-existing note")).await.unwrap();
    mgr.create(new_item(&info.id, Kind::Task, "pre-existing task")).await.unwrap();
    mgr.unload(&info.id).await.unwrap();

    // Defensive: no build in this test ever wrote scratch.md here, but make the
    // "no scratch.md" premise explicit and true regardless.
    let _ = std::fs::remove_file(dir.path().join("scratch.md"));

    let reopened = mgr.open_project(dir.path().to_str().unwrap()).await.unwrap();

    let listed = mgr
        .list_all(&ListFilter { project_id: Some(reopened.id.clone()), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(listed.len(), 2, "both pre-feature items must still be listed");
    assert_eq!(mgr.get_scratch(&reopened.id).await.unwrap(), "");
}

#[tokio::test]
async fn opening_a_directory_with_a_hand_written_scratch_md_next_to_items_loads_items_with_zero_skips_and_reads_the_scratch(
) {
    let (mgr, _app) = new_manager().await;
    let (info, dir) = create_project(&mgr, "Alpha").await;
    mgr.create(new_item(&info.id, Kind::Note, "one")).await.unwrap();
    mgr.create(new_item(&info.id, Kind::Note, "two")).await.unwrap();

    std::fs::write(dir.path().join("scratch.md"), "hand-written, not through the app").unwrap();

    // `open_project` discards its internal scan warnings (`projects/mod.rs`
    // `let (repo, pid, pname, _warnings) = open_store(...)`), so `reload` — which
    // runs the identical `items/`-scan path and DOES return its warnings — is
    // used here as the equivalent "zero skips" probe for a hand-planted root file.
    let warnings = mgr.reload(&info.id).await.unwrap();
    assert!(
        warnings.is_empty(),
        "a root-level scratch.md must never be treated as a malformed item: {warnings:?}"
    );

    let listed = mgr.list_all(&ListFilter::default()).await.unwrap();
    assert_eq!(listed.len(), 2, "item count is unchanged by a hand-written scratch.md");
    assert_eq!(mgr.get_scratch(&info.id).await.unwrap(), "hand-written, not through the app");
}

#[tokio::test]
async fn a_scratch_md_containing_git_conflict_markers_is_returned_verbatim() {
    // Policy pin (Plan 13 §4 M2): unlike items/prompts, a single always-present
    // pad has no siblings to protect, so conflict markers are surfaced raw
    // rather than rejected.
    let (mgr, _app) = new_manager().await;
    let (info, dir) = create_project(&mgr, "Alpha").await;
    let conflicted = "<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> branch\n";
    std::fs::write(dir.path().join("scratch.md"), conflicted).unwrap();

    assert_eq!(mgr.get_scratch(&info.id).await.unwrap(), conflicted);
}

#[tokio::test]
async fn create_project_rollback_leaves_a_pre_existing_scratch_md_untouched() {
    // Post-review F1: `remove_store_files` doubles as `create_project`'s
    // unattended rollback. A folder that is not yet a store may already hold a
    // user's own `scratch.md` (the pad is created lazily, so the app never wrote
    // it); a failed create must roll back only what the app created.
    let (mgr, _app) = new_manager().await;
    let (_alpha, _alpha_dir) = create_project(&mgr, "Alpha").await;

    let dir = tempdir().unwrap();
    let mine = "my own notes, written before this folder was a project";
    std::fs::write(dir.path().join("scratch.md"), mine).unwrap();

    // Same name → the catalog's UNIQUE(name) rejects AFTER the store files were
    // written, so the rollback path runs.
    let err = mgr.create_project(dir.path().to_str().unwrap(), "Alpha").await.unwrap_err();
    assert!(matches!(err, AppError::Invalid(_)), "a duplicate name is rejected: {err:?}");
    assert!(!dir.path().join("index.db").exists(), "the rollback removed what the app created");
    assert_eq!(
        std::fs::read_to_string(dir.path().join("scratch.md")).unwrap(),
        mine,
        "the rollback must never delete a scratch.md the app did not create"
    );
}

// ---------------------------------------------------------------------------
// plan.15 draft sweeps: `delete_files`/`forget` each sweep their OWN project's
// draft backups (app_data_dir\drafts\*.md, outside the project folder) and
// must never touch another loaded project's drafts. `store::draftfile`'s
// bodies are `todo!("plan.15 phase 1")` as of this writing, so these are
// EXPECTED to fail with that panic until phase 1 lands (RED before GREEN).
// ---------------------------------------------------------------------------

/// A fully-populated `Draft` for `project_id`, with fresh random `draftId`/
/// `entityId` — the content itself is irrelevant to these sweep tests, only
/// which project a draft is attributed to.
fn plan15_sample_draft(project_id: &str) -> Draft {
    Draft {
        v: 0,
        draft_id: uuid::Uuid::new_v4().to_string(),
        surface: DraftSurface::Item,
        project_id: project_id.into(),
        entity_id: uuid::Uuid::new_v4().to_string(),
        kind: Some(Kind::Task),
        base_updated_at: String::new(),
        base_hash: String::new(),
        saved_at: String::new(),
        title: "draft title".into(),
        status: Some(Status::Doing),
        priority: Some(Priority::Normal),
        due_at: String::new(),
        tags: Vec::new(),
        jira_url: String::new(),
        body: "draft body".into(),
    }
}

#[tokio::test]
async fn delete_files_sweeps_only_that_projects_drafts() {
    let (mgr, _app) = new_manager().await;
    let (a, _dir_a) = create_project(&mgr, "Alpha").await;
    let (b, _dir_b) = create_project(&mgr, "Beta").await;

    mgr.save_draft(plan15_sample_draft(&a.id)).unwrap();
    mgr.save_draft(plan15_sample_draft(&b.id)).unwrap();
    assert_eq!(mgr.list_drafts().unwrap().len(), 2);

    mgr.unload(&a.id).await.unwrap();
    mgr.delete_files(&a.id).await.unwrap();

    let listed = mgr.list_drafts().unwrap();
    assert_eq!(listed.len(), 1, "delete_files must sweep A's draft");
    assert_eq!(listed[0].project_id, b.id, "B's draft must be untouched by A's delete_files");
}

#[tokio::test]
async fn forget_sweeps_only_that_projects_drafts() {
    let (mgr, _app) = new_manager().await;
    let (a, _dir_a) = create_project(&mgr, "Alpha").await;
    let (b, _dir_b) = create_project(&mgr, "Beta").await;

    mgr.save_draft(plan15_sample_draft(&a.id)).unwrap();
    mgr.save_draft(plan15_sample_draft(&b.id)).unwrap();
    assert_eq!(mgr.list_drafts().unwrap().len(), 2);

    mgr.unload(&a.id).await.unwrap();
    mgr.forget(&a.id).await.unwrap();

    let listed = mgr.list_drafts().unwrap();
    assert_eq!(listed.len(), 1, "forget must sweep A's draft");
    assert_eq!(listed[0].project_id, b.id, "B's draft must be untouched by A's forget");
}
