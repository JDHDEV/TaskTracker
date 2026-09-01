//! Integration tests for the plan.15 phase-1 draft-backup manager surface
//! (`ProjectManager::save_draft`/`list_drafts`/`delete_draft`/
//! `sweep_project_drafts`, plus the startup GC wired into `ProjectManager::new`
//! via `DraftStore::new`). Mirrors `tests/project_manager.rs`'s harness
//! conventions: a real on-disk `app_data_dir` per manager (`tempdir()`), a real
//! on-disk project store per loaded project in a SEPARATE temp dir (the
//! containment rule — `validate_project_dir` rejects a project dir inside
//! `app_data_dir` except its `projects/` subtree), and an in-memory catalog.
//!
//! (History: these tests were written RED-first against `todo!()` stubs in
//! `store::draftfile` and flipped green unchanged when phase 1 landed.)

use notes_app_lib::error::AppError;
use notes_app_lib::models::{Draft, DraftSurface, Kind, NewItem, Priority, Status, UpdateItem};
use notes_app_lib::projects::catalog::Catalog;
use notes_app_lib::projects::ProjectManager;

use tempfile::{tempdir, TempDir};

// ---------------------------------------------------------------------------
// Fixtures (same shape as tests/project_manager.rs — duplicated because
// integration test binaries cannot share `tests/`-local helpers across files)
// ---------------------------------------------------------------------------

/// A manager with an in-memory catalog and a fresh `app_data_dir`. The
/// returned `TempDir` must be kept alive for the test's duration (it anchors
/// the manager's containment check and is where `drafts/` lives).
async fn new_manager() -> (ProjectManager, TempDir) {
    let app = tempdir().unwrap();
    let catalog = Catalog::open_in_memory().await.unwrap();
    let mgr = ProjectManager::new(catalog, app.path().to_path_buf());
    (mgr, app)
}

/// Create a loaded project in its own temp dir OUTSIDE the manager's
/// `app_data_dir`. The returned `TempDir` must be kept alive as long as the
/// project may be read from disk.
async fn create_project(mgr: &ProjectManager, name: &str) -> (notes_app_lib::models::ProjectInfo, TempDir) {
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

/// A fully-populated `Draft` with a caller-chosen `draftId`/`projectId`/
/// `entityId` and everything else non-empty (so it never hits `write_draft`'s
/// "never-saved AND all-empty" special case, which removes the file instead of
/// writing it — that convention is not what these tests are about). `v: 0` and
/// `savedAt: ""` are intentional: the manager must stamp both server-side.
fn sample_draft(draft_id: &str, project_id: &str, entity_id: &str) -> Draft {
    Draft {
        v: 0,
        draft_id: draft_id.into(),
        surface: DraftSurface::Item,
        project_id: project_id.into(),
        entity_id: entity_id.into(),
        kind: Some(Kind::Task),
        base_updated_at: String::new(),
        base_hash: String::new(),
        saved_at: String::new(),
        title: "draft title".into(),
        status: Some(Status::Doing),
        priority: Some(Priority::Normal),
        due_at: "2026-09-01".into(),
        tags: vec!["tag-a".into(), "tag-b".into()],
        jira_url: String::new(),
        body: "draft body".into(),
    }
}

// ---------------------------------------------------------------------------
// Manager-level lifecycle
// ---------------------------------------------------------------------------

#[tokio::test]
async fn save_list_delete_round_trip() {
    let (mgr, _app) = new_manager().await;
    let (project, _dir) = create_project(&mgr, "Alpha").await;
    let draft_id = uuid::Uuid::new_v4().to_string();
    let entity_id = uuid::Uuid::new_v4().to_string();
    let draft = sample_draft(&draft_id, &project.id, &entity_id);

    mgr.save_draft(draft.clone()).unwrap();

    let listed = mgr.list_drafts().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].draft_id, draft_id);
    assert_eq!(listed[0].project_id, project.id);
    assert_eq!(listed[0].entity_id, entity_id);
    assert_eq!(listed[0].v, 1, "the backend stamps v=1 even though the caller sent v: 0");
    assert!(!listed[0].saved_at.is_empty(), "the backend stamps savedAt server-side even from savedAt: \"\"");
    assert_eq!(listed[0].title, draft.title);
    assert_eq!(listed[0].body, draft.body);
    assert_eq!(listed[0].tags, draft.tags);

    mgr.delete_draft(&draft_id).unwrap();
    assert!(mgr.list_drafts().unwrap().is_empty());
}

#[tokio::test]
async fn drafts_from_two_loaded_projects_are_attributed_and_swept_independently() {
    let (mgr, _app) = new_manager().await;
    let (a, _dir_a) = create_project(&mgr, "Alpha").await;
    let (b, _dir_b) = create_project(&mgr, "Beta").await;

    let draft_a = sample_draft(&uuid::Uuid::new_v4().to_string(), &a.id, &uuid::Uuid::new_v4().to_string());
    let draft_b = sample_draft(&uuid::Uuid::new_v4().to_string(), &b.id, &uuid::Uuid::new_v4().to_string());
    mgr.save_draft(draft_a.clone()).unwrap();
    mgr.save_draft(draft_b.clone()).unwrap();

    let listed = mgr.list_drafts().unwrap();
    assert_eq!(listed.len(), 2);
    assert!(listed.iter().any(|d| d.draft_id == draft_a.draft_id && d.project_id == a.id));
    assert!(listed.iter().any(|d| d.draft_id == draft_b.draft_id && d.project_id == b.id));

    mgr.sweep_project_drafts(&a.id).unwrap();
    let after = mgr.list_drafts().unwrap();
    assert_eq!(after.len(), 1, "sweeping A must remove only A's draft");
    assert_eq!(after[0].draft_id, draft_b.draft_id, "B's draft must survive A's sweep");
}

// ---------------------------------------------------------------------------
// Core safety property: drafts never touch canonical data
// ---------------------------------------------------------------------------

#[tokio::test]
async fn draft_saves_never_touch_the_canonical_item_file() {
    let (mgr, _app) = new_manager().await;
    let (project, dir) = create_project(&mgr, "Alpha").await;
    let item = mgr.create(new_item(&project.id, Kind::Task, "real item")).await.unwrap();

    let item_path = dir.path().join("items").join(format!("{}.md", item.id));
    let baseline_bytes = std::fs::read(&item_path).unwrap();
    let baseline_mtime = std::fs::metadata(&item_path).unwrap().modified().unwrap();

    // A little breathing room so an mtime comparison isn't tied by filesystem
    // timestamp coarseness; bytes are the primary assertion regardless.
    std::thread::sleep(std::time::Duration::from_millis(50));

    for i in 0..5 {
        let draft = Draft { body: format!("draft body attempt {i}"), ..sample_draft(&item.id, &project.id, &item.id) };
        mgr.save_draft(draft).unwrap();
    }

    let after_bytes = std::fs::read(&item_path).unwrap();
    assert_eq!(after_bytes, baseline_bytes, "5 draft saves must never change the canonical item file's bytes");
    let after_mtime = std::fs::metadata(&item_path).unwrap().modified().unwrap();
    assert_eq!(after_mtime, baseline_mtime, "5 draft saves must never touch the canonical item file's mtime");

    // A REAL save (mgr.update), by contrast, must change the file.
    mgr.update(&item.id, UpdateItem { body: Some("new".into()), ..Default::default() }).await.unwrap();
    let updated_bytes = std::fs::read(&item_path).unwrap();
    assert_ne!(updated_bytes, baseline_bytes, "an actual item update must change the canonical file");
}

// ---------------------------------------------------------------------------
// Errors / gating
// ---------------------------------------------------------------------------

#[tokio::test]
async fn save_draft_for_a_project_that_is_not_loaded_is_rejected() {
    let (mgr, _app) = new_manager().await;
    let draft = sample_draft(&uuid::Uuid::new_v4().to_string(), "does-not-exist", &uuid::Uuid::new_v4().to_string());

    let err = mgr.save_draft(draft).unwrap_err();
    match err {
        AppError::Invalid(msg) => assert!(msg.contains("isn't loaded"), "got: {msg}"),
        other => panic!("expected Invalid(\"...isn't loaded...\"), got {other:?}"),
    }
}

#[tokio::test]
async fn sweep_project_drafts_after_unload_is_rejected() {
    let (mgr, _app) = new_manager().await;
    let (project, _dir) = create_project(&mgr, "Alpha").await;
    mgr.unload(&project.id).await.unwrap();

    let err = mgr.sweep_project_drafts(&project.id).unwrap_err();
    match err {
        AppError::Invalid(msg) => assert!(msg.contains("isn't loaded"), "got: {msg}"),
        other => panic!("expected Invalid(\"...isn't loaded...\"), got {other:?}"),
    }
}

#[tokio::test]
async fn a_project_less_draft_saves_fine_and_lists() {
    let (mgr, _app) = new_manager().await;
    let draft = sample_draft(&uuid::Uuid::new_v4().to_string(), "", &uuid::Uuid::new_v4().to_string());

    mgr.save_draft(draft.clone()).unwrap();

    let listed = mgr.list_drafts().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].project_id, "", "a project-less draft (\"All projects\" scratch scope) must round-trip");
}

// ---------------------------------------------------------------------------
// Sweep is usable purely from the LOADED set — no tab/editor concept exists
// backend-side (the frontend sweeps before it unloads, per plan.15's design)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn sweep_project_drafts_removes_all_of_a_loaded_projects_drafts_at_once() {
    let (mgr, _app) = new_manager().await;
    let (project, _dir) = create_project(&mgr, "Alpha").await;
    mgr.save_draft(sample_draft(&uuid::Uuid::new_v4().to_string(), &project.id, &uuid::Uuid::new_v4().to_string()))
        .unwrap();
    mgr.save_draft(sample_draft(&uuid::Uuid::new_v4().to_string(), &project.id, &uuid::Uuid::new_v4().to_string()))
        .unwrap();
    assert_eq!(mgr.list_drafts().unwrap().len(), 2);

    mgr.sweep_project_drafts(&project.id).unwrap();

    assert!(
        mgr.list_drafts().unwrap().is_empty(),
        "sweep must work against a loaded project with no notion of an open tab/editor"
    );
}

// ---------------------------------------------------------------------------
// Startup GC (DraftStore::new, invoked by ProjectManager::new)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn startup_gc_through_a_fresh_manager_drops_old_drafts_and_keeps_recent_ones() {
    let app = tempdir().unwrap();
    let drafts_dir = app.path().join("drafts");

    let old_id = uuid::Uuid::new_v4().to_string();
    let recent_id = uuid::Uuid::new_v4().to_string();
    let mut old_draft = sample_draft(&old_id, "", "");
    old_draft.saved_at = "2026-01-01T00:00:00.000+00:00".into(); // ~240 days before "today" (2026-08-31)
    let mut recent_draft = sample_draft(&recent_id, "", "");
    recent_draft.saved_at = "2026-08-30T00:00:00.000+00:00".into();

    notes_app_lib::store::draftfile::write_draft(&drafts_dir, &old_draft).unwrap();
    notes_app_lib::store::draftfile::write_draft(&drafts_dir, &recent_draft).unwrap();

    // A NEW manager over the SAME app_data_dir runs the startup GC as a side
    // effect of constructing its DraftStore.
    let catalog = Catalog::open_in_memory().await.unwrap();
    let mgr = ProjectManager::new(catalog, app.path().to_path_buf());

    let listed = mgr.list_drafts().unwrap();
    assert_eq!(listed.len(), 1, "the far-past-TTL draft must be GC'd at startup");
    assert_eq!(listed[0].draft_id, recent_id, "the recent draft must survive startup GC");
}

// ---------------------------------------------------------------------------
// delete_draft edge cases
// ---------------------------------------------------------------------------

#[tokio::test]
async fn delete_draft_rejects_a_non_uuid_id() {
    let (mgr, _app) = new_manager().await;
    let err = mgr.delete_draft("not-a-uuid").unwrap_err();
    assert!(matches!(err, AppError::Invalid(_)), "got {err:?}");
}

#[tokio::test]
async fn delete_draft_for_an_absent_uuid_is_idempotent_ok() {
    let (mgr, _app) = new_manager().await;
    let absent = uuid::Uuid::new_v4().to_string();
    mgr.delete_draft(&absent).unwrap();
}

// ---------------------------------------------------------------------------
// Post-review (security M3): "delete means gone" is enforced SERVER-side —
// deleting an item/prompt sweeps its draft backup inside the manager, not just
// via the frontend's follow-up call (a deleted item's draft can hold MORE than
// the last saved version).
// ---------------------------------------------------------------------------

#[tokio::test]
async fn deleting_an_item_sweeps_its_draft_server_side() {
    let (mgr, _app) = new_manager().await;
    let (project, _dir) = create_project(&mgr, "delete-sweeps-item").await;
    let item = mgr.create(new_item(&project.id, Kind::Task, "doomed item")).await.unwrap();
    mgr.save_draft(sample_draft(&item.id, &project.id, &item.id)).unwrap();
    assert_eq!(mgr.list_drafts().unwrap().len(), 1, "precondition: the draft exists");

    mgr.delete(&item.id).await.unwrap();

    assert!(
        mgr.list_drafts().unwrap().is_empty(),
        "deleting an item must sweep its draft backup server-side"
    );
}

#[tokio::test]
async fn deleting_a_prompt_sweeps_its_draft_server_side() {
    use notes_app_lib::models::NewPrompt;
    let (mgr, _app) = new_manager().await;
    let (project, _dir) = create_project(&mgr, "delete-sweeps-prompt").await;
    let prompt = mgr
        .create_prompt(NewPrompt {
            project_id: project.id.clone(),
            title: "doomed prompt".into(),
            body: Some("body".into()),
            reusable: None,
            source: None,
        })
        .await
        .unwrap();
    let mut draft = sample_draft(&prompt.id, &project.id, &prompt.id);
    draft.surface = DraftSurface::Prompt;
    draft.kind = None;
    draft.status = None;
    draft.priority = None;
    mgr.save_draft(draft).unwrap();
    assert_eq!(mgr.list_drafts().unwrap().len(), 1, "precondition: the draft exists");

    mgr.delete_prompt(&prompt.id).await.unwrap();

    assert!(
        mgr.list_drafts().unwrap().is_empty(),
        "deleting a prompt must sweep its draft backup server-side"
    );
}
