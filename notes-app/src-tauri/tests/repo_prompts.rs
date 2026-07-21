//! Prompt repository integration tests (plan.7), a sibling of `repo.rs`. In a
//! SEPARATE file so importing `PromptRepository` doesn't make the item tests'
//! `repo.create(...)` ambiguous (`SqliteRepository` implements both traits with
//! same-named methods). The in-memory repo has no `prompts_dir`, so these drive
//! the index alone; the canonical FILE store is exercised in
//! `tests/export_import.rs` and `tests/project_manager.rs`.

use notes_app_lib::db::{PromptRepository, SqliteRepository};
use notes_app_lib::error::AppError;
use notes_app_lib::models::{NewPrompt, PromptListFilter, PromptVersion, UpdatePrompt};

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

    // The title is optional (plan.8): a whitespace-only title is trimmed to
    // empty and ACCEPTED (the body carries the prompt) — flipped from the old
    // reject-empty-title behavior.
    let blank = prompts.create(new_prompt("   ", "b")).await.unwrap();
    assert_eq!(blank.title, "", "a whitespace-only title is trimmed to empty and accepted");
    assert_eq!(blank.body, "b");
}

#[tokio::test]
async fn prompt_get_update_delete_round_trip_and_second_delete_is_not_found() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let prompts: &dyn PromptRepository = &repo;

    let p = prompts.create(new_prompt("t", "b")).await.unwrap();
    assert_eq!(prompts.get(&p.id).await.unwrap().title, "t");

    // A whitespace-only title patch now SUCCEEDS (title optional, plan.8): the
    // body ("b") keeps the prompt non-blank, so the both-empty guard passes.
    // Flipped from the old reject-empty-title behavior.
    let cleared = prompts
        .update(&p.id, UpdatePrompt { title: Some("  ".into()), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(cleared.title, "", "the title is cleared to empty and stored");
    assert_eq!(cleared.body, "b", "body unchanged");

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

// --- Optional title + both-empty guard (plan.8) ----------------------------

#[tokio::test]
async fn prompt_optional_title_allows_each_non_degenerate_combo() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let prompts: &dyn PromptRepository = &repo;

    // Empty title + real body: allowed (a prompt is often just a body).
    let a = prompts.create(new_prompt("", "just a body")).await.unwrap();
    assert_eq!(a.title, "");
    assert_eq!(a.body, "just a body");

    // Real title + empty body: allowed.
    let b = prompts.create(new_prompt("just a title", "")).await.unwrap();
    assert_eq!(b.title, "just a title");
    assert_eq!(b.body, "");
}

#[tokio::test]
async fn prompt_both_empty_is_rejected_on_create_and_update() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let prompts: &dyn PromptRepository = &repo;

    // Both empty (whitespace counts as empty) → rejected on create (Decision B).
    assert!(matches!(
        prompts.create(new_prompt("   ", "  ")).await.unwrap_err(),
        AppError::Invalid(_)
    ));

    // On update the guard uses the RESOLVED current version: clearing the title
    // while the body is also being cleared is caught.
    let p = prompts.create(new_prompt("", "has body")).await.unwrap();
    assert!(matches!(
        prompts
            .update(
                &p.id,
                UpdatePrompt { title: Some("".into()), body: Some("   ".into()), ..Default::default() },
            )
            .await
            .unwrap_err(),
        AppError::Invalid(_)
    ));
    // The rejected update left the current version untouched.
    assert_eq!(prompts.get(&p.id).await.unwrap().body, "has body");

    // Clearing only the body while a real title remains is fine.
    let ok = prompts
        .update(
            &p.id,
            UpdatePrompt { title: Some("now titled".into()), body: Some("".into()), ..Default::default() },
        )
        .await
        .unwrap();
    assert_eq!(ok.title, "now titled");
    assert_eq!(ok.body, "");
}

#[tokio::test]
async fn prompt_clearing_the_title_appends_exactly_one_version() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let prompts: &dyn PromptRepository = &repo;
    let p = prompts.create(new_prompt("has title", "body")).await.unwrap();
    let after = prompts
        .update(&p.id, UpdatePrompt { title: Some("".into()), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(after.title, "", "the title clears to empty");
    assert_eq!(after.version_count, 2, "clearing the title is a content change → one new version");
}

// --- count_prompts (plan.8) ------------------------------------------------

#[tokio::test]
async fn count_prompts_reflects_creates_and_deletes() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let prompts: &dyn PromptRepository = &repo;
    assert_eq!(prompts.count_prompts().await.unwrap(), 0, "an empty store counts zero, not an error");
    let a = prompts.create(new_prompt("a", "b")).await.unwrap();
    prompts.create(new_prompt("c", "d")).await.unwrap();
    assert_eq!(prompts.count_prompts().await.unwrap(), 2);
    prompts.delete(&a.id).await.unwrap();
    assert_eq!(prompts.count_prompts().await.unwrap(), 1);
}

#[tokio::test]
async fn count_prompts_counts_prompts_not_versions_and_ignores_reusable() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let prompts: &dyn PromptRepository = &repo;
    let plain = prompts.create(new_prompt("plain", "b")).await.unwrap();
    prompts.create(NewPrompt { reusable: Some(true), ..new_prompt("reusable", "b") }).await.unwrap();
    assert_eq!(prompts.count_prompts().await.unwrap(), 2, "counts all prompts, reusable or not");
    // Adding versions to a prompt must NOT inflate the prompt count.
    prompts
        .update(&plain.id, UpdatePrompt { body: Some("v2".into()), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(prompts.count_prompts().await.unwrap(), 2, "versions don't inflate the prompt count");
}

// --- import_prompt (plan.8 move; id-preserving) ----------------------------

#[tokio::test]
async fn import_prompt_preserves_ids_history_and_provenance() {
    // The move copies a prompt into another store VERBATIM: same prompt id, same
    // version ids/titles/bodies/sources/created_at, same reusable flag and
    // derived updatedAt. (Index-level here; the file store is covered in
    // tests/project_manager.rs and tests/export_import.rs.)
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let prompts: &dyn PromptRepository = &repo;
    let src = prompts.create(NewPrompt { reusable: Some(true), ..new_prompt("t1", "b1") }).await.unwrap();
    prompts
        .update(
            &src.id,
            UpdatePrompt { body: Some("b2".into()), source: Some("aiEnhanced".into()), ..Default::default() },
        )
        .await
        .unwrap();
    let source_versions: Vec<PromptVersion> = prompts.versions(&src.id).await.unwrap();
    let head = prompts.get(&src.id).await.unwrap();

    let repo2 = SqliteRepository::connect_in_memory().await.unwrap();
    let prompts2: &dyn PromptRepository = &repo2;
    let imported = prompts2
        .import_prompt(&src.id, head.reusable, &head.created_at, &head.schema_version, &source_versions)
        .await
        .unwrap();

    assert_eq!(imported.id, src.id, "the prompt id is preserved verbatim");
    assert!(imported.reusable, "the reusable flag travels");
    assert_eq!(imported.version_count, 2);
    assert_eq!(imported.created_at, head.created_at, "the prompt created_at is preserved");
    assert_eq!(
        imported.updated_at, head.updated_at,
        "derived updatedAt preserved (the newest version's created_at travels)"
    );

    let imported_versions = prompts2.versions(&src.id).await.unwrap();
    assert_eq!(imported_versions.len(), source_versions.len());
    for (a, b) in source_versions.iter().zip(imported_versions.iter()) {
        assert_eq!(a.id, b.id, "version id preserved");
        assert_eq!(a.title, b.title);
        assert_eq!(a.body, b.body);
        assert_eq!(a.source, b.source, "provenance preserved");
        assert_eq!(a.created_at, b.created_at);
    }
}

#[tokio::test]
async fn import_prompt_rejects_an_empty_version_list() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let prompts: &dyn PromptRepository = &repo;
    assert!(matches!(
        prompts
            .import_prompt("id", false, "2026-07-19T00:00:00.000+00:00", "1.0.0", &[])
            .await
            .unwrap_err(),
        AppError::Invalid(_)
    ));
}

// ---------------------------------------------------------------------------
// schema_version marker (plan.10) — index-level create/round-trip/immunity.
// File-store preservation (reusable toggle, cross-project move) is covered in
// tests/project_manager.rs, since the in-memory repo here has no prompts_dir.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn prompt_create_stamps_current_schema_version_and_it_survives_get_and_list() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let prompts: &dyn PromptRepository = &repo;
    let p = prompts.create(new_prompt("t", "b")).await.unwrap();
    assert_eq!(p.schema_version, "1.0.0");

    let fetched = prompts.get(&p.id).await.unwrap();
    assert_eq!(fetched.schema_version, "1.0.0", "get() must return the marker");

    let listed = prompts.list(&PromptListFilter::default()).await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].schema_version, "1.0.0", "list() must return the marker");
}

#[tokio::test]
async fn new_prompt_json_carrying_a_client_schema_version_is_ignored_on_create() {
    // NewPrompt has no schemaVersion field: a client-supplied value in the wire
    // JSON must not error deserialization and must not reach the stored record.
    let parsed: NewPrompt =
        serde_json::from_str(r#"{"projectId":"p1","title":"hostile","schemaVersion":"9.9.9"}"#).unwrap();
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let prompts: &dyn PromptRepository = &repo;
    let created = prompts.create(parsed).await.unwrap();
    assert_eq!(created.schema_version, "1.0.0", "a client-supplied schemaVersion must never persist");
}

#[tokio::test]
async fn update_prompt_json_carrying_a_client_schema_version_is_ignored() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let prompts: &dyn PromptRepository = &repo;
    let p = prompts.create(new_prompt("before", "b")).await.unwrap();

    let patch: UpdatePrompt =
        serde_json::from_str(r#"{"title":"after","schemaVersion":"9.9.9"}"#).unwrap();
    let updated = prompts.update(&p.id, patch).await.unwrap();
    assert_eq!(updated.title, "after", "the real patch field still applies");
    assert_eq!(updated.schema_version, "1.0.0", "a client-supplied schemaVersion in a patch must be ignored");
}
