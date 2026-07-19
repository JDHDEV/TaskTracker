//! Prompt repository integration tests (plan.7), a sibling of `repo.rs`. In a
//! SEPARATE file so importing `PromptRepository` doesn't make the item tests'
//! `repo.create(...)` ambiguous (`SqliteRepository` implements both traits with
//! same-named methods). The in-memory repo has no `prompts_dir`, so these drive
//! the index alone; the canonical FILE store is exercised in
//! `tests/export_import.rs` and `tests/project_manager.rs`.

use notes_app_lib::db::{PromptRepository, SqliteRepository};
use notes_app_lib::error::AppError;
use notes_app_lib::models::{NewPrompt, PromptListFilter, UpdatePrompt};

fn new_prompt(title: &str, body: &str) -> NewPrompt {
    NewPrompt {
        // Routing key consumed by the manager; the store ignores it.
        project_id: String::new(),
        title: title.into(),
        body: Some(body.into()),
        reusable: None,
        source: None,
    }
}

#[tokio::test]
async fn prompt_create_owns_id_timestamps_and_a_first_version() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let prompts: &dyn PromptRepository = &repo;

    let p = prompts.create(new_prompt("Draft the release email", "Hi team")).await.unwrap();
    assert!(!p.id.is_empty(), "the backend mints the id");
    assert_eq!(p.title, "Draft the release email");
    assert_eq!(p.body, "Hi team");
    assert!(!p.reusable);
    assert_eq!(p.version_count, 1);
    assert_eq!(p.updated_at, p.created_at, "a fresh prompt's updatedAt equals its createdAt");
    assert_eq!(p.project_id, None, "the store never stamps project_id (the manager does)");

    // An empty/whitespace title is rejected on create.
    assert!(matches!(prompts.create(new_prompt("   ", "b")).await.unwrap_err(), AppError::Invalid(_)));
}

#[tokio::test]
async fn prompt_get_update_delete_round_trip_and_second_delete_is_not_found() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let prompts: &dyn PromptRepository = &repo;

    let p = prompts.create(new_prompt("t", "b")).await.unwrap();
    assert_eq!(prompts.get(&p.id).await.unwrap().title, "t");

    // An empty-title patch is rejected (mirrors the item update check).
    assert!(matches!(
        prompts.update(&p.id, UpdatePrompt { title: Some("  ".into()), ..Default::default() }).await.unwrap_err(),
        AppError::Invalid(_)
    ));

    prompts.delete(&p.id).await.unwrap();
    assert!(matches!(prompts.get(&p.id).await.unwrap_err(), AppError::NotFound));
    assert!(matches!(prompts.delete(&p.id).await.unwrap_err(), AppError::NotFound));
}

#[tokio::test]
async fn prompt_content_edit_appends_one_version_bumps_updated_at_and_preserves_original() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let prompts: &dyn PromptRepository = &repo;

    let p = prompts.create(new_prompt("t", "v1 body")).await.unwrap();
    let first = prompts.versions(&p.id).await.unwrap();
    assert_eq!(first.len(), 1);
    // Pin a stale baseline so the bump is observable regardless of clock resolution.
    let old = "2000-01-01T00:00:00.000+00:00";
    repo.set_prompt_version_timestamp_for_test(&first[0].id, old).await.unwrap();
    let before = prompts.get(&p.id).await.unwrap();
    assert_eq!(before.updated_at, old);

    let after = prompts
        .update(&p.id, UpdatePrompt { body: Some("v2 body".into()), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(after.version_count, 2, "a body edit appends exactly one version");
    assert_eq!(after.body, "v2 body", "get returns the current (newest) version's body");
    assert!(after.updated_at > old.to_string(), "a content edit bumps updatedAt to the new version's createdAt");

    // The original version is preserved byte-intact and still retrievable.
    let hist = prompts.versions(&p.id).await.unwrap();
    assert_eq!(hist.len(), 2);
    assert!(hist.iter().any(|v| v.body == "v1 body"), "the original version body is preserved");
}

#[tokio::test]
async fn prompt_identical_save_appends_no_version() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let prompts: &dyn PromptRepository = &repo;
    let p = prompts.create(new_prompt("t", "b")).await.unwrap();
    // Re-saving the SAME title+body appends no version (history never bloats).
    let after = prompts
        .update(&p.id, UpdatePrompt { title: Some("t".into()), body: Some("b".into()), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(after.version_count, 1, "a no-op content save appends no version");
}

#[tokio::test]
async fn prompt_reusable_toggle_appends_no_version_and_does_not_bump_updated_at() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let prompts: &dyn PromptRepository = &repo;

    let p = prompts.create(new_prompt("t", "b")).await.unwrap();
    let v = prompts.versions(&p.id).await.unwrap();
    let old = "2000-01-01T00:00:00.000+00:00";
    repo.set_prompt_version_timestamp_for_test(&v[0].id, old).await.unwrap();
    assert_eq!(prompts.get(&p.id).await.unwrap().updated_at, old);

    // true → false → true, each a no-version, no-bump change.
    let on = prompts.update(&p.id, UpdatePrompt { reusable: Some(true), ..Default::default() }).await.unwrap();
    assert!(on.reusable);
    assert_eq!(on.version_count, 1, "a reusable toggle appends no version");
    assert_eq!(on.updated_at, old, "a reusable toggle does not bump updatedAt");

    let off = prompts.update(&p.id, UpdatePrompt { reusable: Some(false), ..Default::default() }).await.unwrap();
    assert!(!off.reusable);
    assert_eq!(off.version_count, 1);
    assert_eq!(off.updated_at, old);

    let on_again = prompts.update(&p.id, UpdatePrompt { reusable: Some(true), ..Default::default() }).await.unwrap();
    assert!(on_again.reusable);
    assert_eq!(on_again.version_count, 1);
    assert_eq!(on_again.updated_at, old);
}

#[tokio::test]
async fn prompt_ai_enhanced_update_labels_the_version_and_keeps_the_original() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let prompts: &dyn PromptRepository = &repo;

    let p = prompts.create(new_prompt("t", "original body")).await.unwrap();
    prompts
        .update(&p.id, UpdatePrompt {
            body: Some("enhanced body".into()),
            source: Some("aiEnhanced".into()),
            ..Default::default()
        })
        .await
        .unwrap();

    let hist = prompts.versions(&p.id).await.unwrap();
    assert_eq!(hist.len(), 2);
    assert_eq!(hist[0].source, "aiEnhanced", "the new version is labeled aiEnhanced");
    assert_eq!(hist[0].body, "enhanced body");
    assert_eq!(hist[1].source, "manual", "the first version stays manual");
    assert_eq!(hist[1].body, "original body", "the immediately-prior version is unchanged");
}

#[tokio::test]
async fn prompt_create_with_ai_enhanced_source_labels_the_first_version() {
    // §12: a brand-new draft whose first persisted content is an accepted AI
    // enhance is created with source "aiEnhanced", so history is truthful.
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let prompts: &dyn PromptRepository = &repo;
    let p = prompts
        .create(NewPrompt { source: Some("aiEnhanced".into()), ..new_prompt("t", "ai body") })
        .await
        .unwrap();
    let hist = prompts.versions(&p.id).await.unwrap();
    assert_eq!(hist.len(), 1);
    assert_eq!(hist[0].source, "aiEnhanced", "the first version reflects the create source");

    // A create with no source (or a garbage one) is still "manual".
    let m = prompts.create(new_prompt("m", "b")).await.unwrap();
    assert_eq!(prompts.versions(&m.id).await.unwrap()[0].source, "manual");
    let g = prompts
        .create(NewPrompt { source: Some("bogus".into()), ..new_prompt("g", "b") })
        .await
        .unwrap();
    assert_eq!(prompts.versions(&g.id).await.unwrap()[0].source, "manual");
}

#[tokio::test]
async fn prompt_unknown_source_normalizes_to_manual() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let prompts: &dyn PromptRepository = &repo;
    let p = prompts.create(new_prompt("t", "b")).await.unwrap();
    prompts
        .update(&p.id, UpdatePrompt { body: Some("c".into()), source: Some("bogus".into()), ..Default::default() })
        .await
        .unwrap();
    let hist = prompts.versions(&p.id).await.unwrap();
    assert_eq!(hist[0].source, "manual", "a garbage source normalizes to manual");
}

#[tokio::test]
async fn prompt_version_history_is_newest_first_and_stable_on_equal_timestamps() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let prompts: &dyn PromptRepository = &repo;

    let p = prompts.create(new_prompt("t", "v1")).await.unwrap();
    prompts.update(&p.id, UpdatePrompt { body: Some("v2".into()), ..Default::default() }).await.unwrap();
    let hist = prompts.versions(&p.id).await.unwrap();
    assert_eq!(hist.len(), 2);

    // Force equal timestamps and known ids so `id ASC` is the sole tiebreak.
    let ts = "2026-07-18T00:00:00.000+00:00";
    for v in &hist {
        repo.set_prompt_version_timestamp_for_test(&v.id, ts).await.unwrap();
    }
    repo.set_prompt_version_id_for_test(&hist[0].id, "id-2").await.unwrap(); // was newest
    repo.set_prompt_version_id_for_test(&hist[1].id, "id-1").await.unwrap();

    // Equal timestamps → newest-first list = created_at DESC, id ASC → id-1 leads,
    // and the order is stable across repeated reads (never flaps).
    for _ in 0..3 {
        let order: Vec<String> =
            prompts.versions(&p.id).await.unwrap().into_iter().map(|v| v.id).collect();
        assert_eq!(order, vec!["id-1".to_string(), "id-2".to_string()]);
    }
    // The current version (get) resolves to the same head of the ordering.
    assert_eq!(prompts.get(&p.id).await.unwrap().version_count, 2);
}

#[tokio::test]
async fn prompt_reusable_filter_returns_only_reusables_empty_when_none() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let prompts: &dyn PromptRepository = &repo;

    // No reusables yet → reusable-only is empty (not an error).
    prompts.create(new_prompt("plain one", "b")).await.unwrap();
    assert!(prompts
        .list(&PromptListFilter { reusable_only: Some(true), ..Default::default() })
        .await
        .unwrap()
        .is_empty());

    let reusable =
        prompts.create(NewPrompt { reusable: Some(true), ..new_prompt("reusable one", "b") }).await.unwrap();
    // No filter → both; reusable-only → just the one.
    assert_eq!(prompts.list(&PromptListFilter::default()).await.unwrap().len(), 2);
    let only = prompts
        .list(&PromptListFilter { reusable_only: Some(true), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(only.len(), 1);
    assert_eq!(only[0].id, reusable.id);
}

#[tokio::test]
async fn prompt_and_version_serialize_to_camelcase_shape() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let prompts: &dyn PromptRepository = &repo;

    let p = prompts.create(new_prompt("t", "b")).await.unwrap();
    let json = serde_json::to_value(&p).unwrap();
    assert!(json["id"].is_string());
    assert_eq!(json["title"], "t");
    assert_eq!(json["body"], "b");
    assert_eq!(json["reusable"], false);
    assert!(json["createdAt"].is_string());
    assert!(json["updatedAt"].is_string());
    assert_eq!(json["versionCount"].as_i64(), Some(1));
    assert!(json["projectId"].is_null(), "the store leaves projectId null (the manager stamps it)");

    let versions = prompts.versions(&p.id).await.unwrap();
    let vjson = serde_json::to_value(&versions[0]).unwrap();
    assert!(vjson["promptId"].is_string());
    assert_eq!(vjson["source"], "manual");
    assert!(vjson["createdAt"].is_string());

    // NewPrompt deserializes from camelCase with a REQUIRED projectId.
    let parsed: NewPrompt = serde_json::from_str(r#"{"projectId":"p1","title":"x"}"#).unwrap();
    assert_eq!(parsed.project_id, "p1");
    assert!(parsed.body.is_none());
    assert!(serde_json::from_str::<NewPrompt>(r#"{"title":"x"}"#).is_err(), "projectId is required");
}
