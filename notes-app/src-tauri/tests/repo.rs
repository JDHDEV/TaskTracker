use notes_app_lib::db::{ItemRepository, SqliteRepository};
use notes_app_lib::error::AppError;
use notes_app_lib::models::{
    Kind, ListFilter, NewItem, Priority, Project, ProjectWithCount, Sort, Status, UpdateItem,
};

fn new_item(kind: Kind, title: &str, body: &str) -> NewItem {
    NewItem {
        kind,
        title: title.into(),
        body: Some(body.into()),
        status: None,
        priority: None,
        due_at: None,
        tags: Some(vec!["work".into()]),
        project_id: None,
        jira_url: None,
    }
}

/// A NewItem with an explicit tag set (for tag-vocabulary / tag-filter tests).
fn item_with_tags(kind: Kind, title: &str, tags: &[&str]) -> NewItem {
    NewItem {
        tags: Some(tags.iter().map(|t| t.to_string()).collect()),
        ..new_item(kind, title, "")
    }
}

#[tokio::test]
async fn crud_search_and_fts() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();

    // create: note + task
    let note = repo
        .create(new_item(Kind::Note, "Quarterly planning meeting", "Discussed roadmap and budget"))
        .await
        .unwrap();
    assert_eq!(note.kind, Kind::Note);
    assert_eq!(note.status, None);
    assert_eq!(note.tags.0, vec!["work".to_string()]);

    let task = repo
        .create(new_item(Kind::Task, "Send follow-up email", "To the platform team"))
        .await
        .unwrap();
    assert_eq!(task.status, Some(Status::Todo)); // tasks default to todo
    assert_eq!(task.priority, Some(Priority::Normal)); // ...and to normal priority
    assert!(!task.pinned);
    assert_eq!(note.priority, None);

    // list + filter
    assert_eq!(repo.list(&ListFilter::default()).await.unwrap().len(), 2);
    let only_tasks = repo
        .list(&ListFilter { kind: Some(Kind::Task), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(only_tasks.len(), 1);
    assert_eq!(only_tasks[0].id, task.id);

    // get + update
    let fetched = repo.get(&note.id).await.unwrap();
    assert_eq!(fetched.title, "Quarterly planning meeting");
    let updated = repo
        .update(&task.id, UpdateItem { status: Some(Status::Done), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(updated.status, Some(Status::Done));
    assert!(updated.updated_at >= updated.created_at);

    // priority: notes ignore it, tasks take it
    let note_after = repo
        .update(&note.id, UpdateItem { priority: Some(Priority::High), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(note_after.priority, None, "notes never get a priority");
    let hi = repo
        .update(&task.id, UpdateItem { priority: Some(Priority::High), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(hi.priority, Some(Priority::High));

    // pinning wins over recency: the task was touched last, so it leads —
    // until the older note is pinned
    assert_eq!(repo.list(&ListFilter::default()).await.unwrap()[0].id, task.id);
    repo.update(&note.id, UpdateItem { pinned: Some(true), ..Default::default() })
        .await
        .unwrap();
    let pinned_first = repo.list(&ListFilter::default()).await.unwrap();
    assert_eq!(pinned_first[0].id, note.id);
    assert!(pinned_first[0].pinned);
    // pin flips are meta-state: the note's edit timestamp must not move
    assert_eq!(pinned_first[0].updated_at, note.updated_at);
    repo.update(&note.id, UpdateItem { pinned: Some(false), ..Default::default() })
        .await
        .unwrap();
    // unpinning restores plain recency order — no timestamp bump, so the
    // task (edited more recently) leads again
    assert_eq!(repo.list(&ListFilter::default()).await.unwrap()[0].id, task.id);

    // FTS search: word from the body, prefix form, and hostile input
    let hits = repo.search("budget", &ListFilter::default()).await.unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].id, note.id);

    let prefix_hits = repo.search("quart", &ListFilter::default()).await.unwrap();
    assert_eq!(prefix_hits.len(), 1, "prefix search should match 'Quarterly'");

    // raw quotes/parens/minus must not cause an FTS5 syntax error
    assert!(repo
        .search("\"unbalanced (syntax -bomb", &ListFilter::default())
        .await
        .unwrap()
        .is_empty());

    // empty query falls back to recent list
    assert_eq!(repo.search("   ", &ListFilter::default()).await.unwrap().len(), 2);

    // update syncs the FTS index
    repo.update(&note.id, UpdateItem { body: Some("Now about hiring".into()), ..Default::default() })
        .await
        .unwrap();
    assert!(repo.search("budget", &ListFilter::default()).await.unwrap().is_empty());
    assert_eq!(repo.search("hiring", &ListFilter::default()).await.unwrap().len(), 1);

    // archived items leave list and search
    repo.update(&note.id, UpdateItem { archived: Some(true), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(repo.list(&ListFilter::default()).await.unwrap().len(), 1);
    assert!(repo.search("hiring", &ListFilter::default()).await.unwrap().is_empty());

    // delete
    repo.delete(&task.id).await.unwrap();
    assert!(repo.delete(&task.id).await.is_err()); // second delete: NotFound
    assert_eq!(repo.list(&ListFilter::default()).await.unwrap().len(), 0);
}

#[tokio::test]
async fn validation_and_serde_shape() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();

    // empty title rejected
    assert!(repo.create(new_item(Kind::Note, "   ", "x")).await.is_err());

    // Item serializes to the camelCase shape the frontend types expect
    let item = repo.create(new_item(Kind::Task, "Ship it", "")).await.unwrap();
    let json = serde_json::to_value(&item).unwrap();
    assert_eq!(json["kind"], "task");
    assert_eq!(json["status"], "todo");
    assert_eq!(json["priority"], "normal");
    assert_eq!(json["pinned"], false);
    assert!(json["dueAt"].is_null());
    assert!(json["createdAt"].is_string());
    assert_eq!(json["tags"][0], "work");
    // new Phase 1 fields: camelCase keys, null when unset
    assert!(json["projectId"].is_null());
    assert!(json["jiraUrl"].is_null());

    // and NewItem deserializes from camelCase with optional fields omitted
    let parsed: NewItem =
        serde_json::from_str(r#"{"kind":"note","title":"From JS"}"#).unwrap();
    assert_eq!(parsed.kind, Kind::Note);
    assert!(parsed.project_id.is_none());
    assert!(parsed.jira_url.is_none());
}

// ---------------------------------------------------------------------------
// Project CRUD
// ---------------------------------------------------------------------------

#[tokio::test]
async fn create_project_trims_and_shapes() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let p = repo.create_project("  Ops  ").await.unwrap();
    assert!(!p.id.is_empty());
    assert_eq!(p.name, "Ops", "name is trimmed");
    // created_at parses as RFC3339
    assert!(chrono::DateTime::parse_from_rfc3339(&p.created_at).is_ok());
}

#[tokio::test]
async fn create_project_rejects_empty_name() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let err = repo.create_project("   ").await.unwrap_err();
    assert!(matches!(err, AppError::Invalid(_)));
}

#[tokio::test]
async fn create_project_rejects_duplicate_cleanly() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    repo.create_project("Ops").await.unwrap();
    // exact duplicate, and duplicate-after-trim
    let err = repo.create_project("Ops").await.unwrap_err();
    let AppError::Invalid(msg) = err else { panic!("expected Invalid, got a leaked error") };
    assert!(!msg.contains("UNIQUE"), "must not leak raw sqlx constraint text: {msg}");

    let err2 = repo.create_project("  Ops ").await.unwrap_err();
    assert!(matches!(err2, AppError::Invalid(_)));
}

#[tokio::test]
async fn create_project_binary_collation_is_case_sensitive() {
    // Q1 decision: binary collation. "Ops" and "OPS" are distinct projects.
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    repo.create_project("Ops").await.unwrap();
    repo.create_project("OPS").await.unwrap();
    assert_eq!(repo.list_projects().await.unwrap().len(), 2);
}

#[tokio::test]
async fn rename_project_is_reflected_and_rename_safe() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let p = repo.create_project("Old").await.unwrap();
    // assign an item to it
    let item = repo.create(new_item(Kind::Task, "T", "")).await.unwrap();
    repo.update(&item.id, UpdateItem { project_id: Some(p.id.clone()), ..Default::default() })
        .await
        .unwrap();

    repo.rename_project(&p.id, "New").await.unwrap();
    let listed = repo.list_projects().await.unwrap();
    assert_eq!(listed.iter().find(|x| x.id == p.id).unwrap().name, "New");
    // id-referenced: the item keeps the same project_id across a rename
    assert_eq!(repo.get(&item.id).await.unwrap().project_id, Some(p.id));
}

#[tokio::test]
async fn rename_project_to_own_name_succeeds() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let p = repo.create_project("Same").await.unwrap();
    // proves the `id <> ?` predicate: no self-collision
    let renamed = repo.rename_project(&p.id, "Same").await.unwrap();
    assert_eq!(renamed.name, "Same");
}

#[tokio::test]
async fn rename_project_to_taken_name_is_invalid() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    repo.create_project("A").await.unwrap();
    let b = repo.create_project("B").await.unwrap();
    let err = repo.rename_project(&b.id, "A").await.unwrap_err();
    assert!(matches!(err, AppError::Invalid(_)));
}

#[tokio::test]
async fn rename_project_nonexistent_is_not_found() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let err = repo.rename_project("no-such-id", "X").await.unwrap_err();
    assert!(matches!(err, AppError::NotFound));
}

#[tokio::test]
async fn list_projects_counts_including_zero() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let empty = repo.create_project("Empty").await.unwrap();
    let one = repo.create_project("One").await.unwrap();
    let many = repo.create_project("Many").await.unwrap();

    let i1 = repo.create(new_item(Kind::Task, "a", "")).await.unwrap();
    repo.update(&i1.id, UpdateItem { project_id: Some(one.id.clone()), ..Default::default() })
        .await
        .unwrap();
    for t in ["b", "c"] {
        let it = repo.create(new_item(Kind::Task, t, "")).await.unwrap();
        repo.update(&it.id, UpdateItem { project_id: Some(many.id.clone()), ..Default::default() })
            .await
            .unwrap();
    }

    let listed = repo.list_projects().await.unwrap();
    let count = |id: &str| listed.iter().find(|p| p.id == id).unwrap().item_count;
    // zero-item project appears AND reads as 0 (proves LEFT JOIN + COUNT(i.id))
    assert_eq!(count(&empty.id), 0);
    assert_eq!(count(&one.id), 1);
    assert_eq!(count(&many.id), 2);
    // default order is by name (Q2 default)
    let names: Vec<&str> = listed.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(names, vec!["Empty", "Many", "One"]);
}

// ---------------------------------------------------------------------------
// delete_project (removal guard)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn delete_project_succeeds_when_empty() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let p = repo.create_project("Gone").await.unwrap();
    repo.delete_project(&p.id).await.unwrap();
    assert!(repo.list_projects().await.unwrap().iter().all(|x| x.id != p.id));
}

#[tokio::test]
async fn delete_project_blocked_message_names_count() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let p = repo.create_project("Busy").await.unwrap();
    let i1 = repo.create(new_item(Kind::Task, "a", "")).await.unwrap();
    repo.update(&i1.id, UpdateItem { project_id: Some(p.id.clone()), ..Default::default() })
        .await
        .unwrap();

    // N=1: message must name the count (a leaked FK AppError::Db is also is_err()
    // but violates the contract) — assert the enum AND the substring.
    let err = repo.delete_project(&p.id).await.unwrap_err();
    let AppError::Invalid(msg) = err else { panic!("expected Invalid, got {err:?}") };
    assert!(msg.contains('1'), "message must name the count: {msg}");
    assert!(!msg.contains("FOREIGN KEY"), "must not leak raw FK text: {msg}");

    // N=2
    let i2 = repo.create(new_item(Kind::Task, "b", "")).await.unwrap();
    repo.update(&i2.id, UpdateItem { project_id: Some(p.id.clone()), ..Default::default() })
        .await
        .unwrap();
    let err2 = repo.delete_project(&p.id).await.unwrap_err();
    let AppError::Invalid(msg2) = err2 else { panic!("expected Invalid") };
    assert!(msg2.contains('2'), "message must name the count: {msg2}");

    // guard didn't partially apply: project still present
    assert!(repo.list_projects().await.unwrap().iter().any(|x| x.id == p.id));
}

#[tokio::test]
async fn delete_project_counts_archived_items() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let p = repo.create_project("Arch").await.unwrap();
    let i = repo.create(new_item(Kind::Task, "a", "")).await.unwrap();
    repo.update(&i.id, UpdateItem { project_id: Some(p.id.clone()), ..Default::default() })
        .await
        .unwrap();
    // archived items still reference the project → delete still blocked
    repo.update(&i.id, UpdateItem { archived: Some(true), ..Default::default() })
        .await
        .unwrap();
    assert!(matches!(repo.delete_project(&p.id).await, Err(AppError::Invalid(_))));
}

#[tokio::test]
async fn delete_project_succeeds_after_unassign() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let p = repo.create_project("Freed").await.unwrap();
    let i = repo.create(new_item(Kind::Task, "a", "")).await.unwrap();
    repo.update(&i.id, UpdateItem { project_id: Some(p.id.clone()), ..Default::default() })
        .await
        .unwrap();
    assert!(repo.delete_project(&p.id).await.is_err());
    // unassign (empty string clears) — proves the guard uses a live count
    repo.update(&i.id, UpdateItem { project_id: Some(String::new()), ..Default::default() })
        .await
        .unwrap();
    repo.delete_project(&p.id).await.unwrap();
}

#[tokio::test]
async fn delete_project_nonexistent_is_not_found() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let err = repo.delete_project("no-such-id").await.unwrap_err();
    assert!(matches!(err, AppError::NotFound));
}

// ---------------------------------------------------------------------------
// list_active_tags (derived vocabulary)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn active_tags_union_distinct_sorted() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    repo.create(item_with_tags(Kind::Note, "n", &["gamma", "alpha"])).await.unwrap();
    repo.create(item_with_tags(Kind::Task, "t", &["beta", "alpha"])).await.unwrap();
    // union, dedup (alpha shared), sorted
    assert_eq!(
        repo.list_active_tags().await.unwrap(),
        vec!["alpha".to_string(), "beta".into(), "gamma".into()]
    );
}

#[tokio::test]
async fn active_tags_drop_on_archive_and_done_but_note_survives() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    // sole carrier of "solo" — archiving it drops the tag
    let solo = repo.create(item_with_tags(Kind::Note, "solo", &["solo"])).await.unwrap();
    assert!(repo.list_active_tags().await.unwrap().contains(&"solo".to_string()));
    repo.update(&solo.id, UpdateItem { archived: Some(true), ..Default::default() })
        .await
        .unwrap();
    assert!(!repo.list_active_tags().await.unwrap().contains(&"solo".to_string()));

    // a done task's tag drops, but a NOTE carrying the same tag keeps it alive
    // (proves the joint kind+status predicate, not a bare status check)
    let task = repo.create(item_with_tags(Kind::Task, "t", &["shared"])).await.unwrap();
    repo.create(item_with_tags(Kind::Note, "n", &["shared"])).await.unwrap();
    repo.update(&task.id, UpdateItem { status: Some(Status::Done), ..Default::default() })
        .await
        .unwrap();
    assert!(
        repo.list_active_tags().await.unwrap().contains(&"shared".to_string()),
        "note keeps the tag alive even though the task with it is done"
    );
}

#[tokio::test]
async fn active_tags_restore_on_reopen_and_unarchive() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let task = repo.create(item_with_tags(Kind::Task, "t", &["x"])).await.unwrap();
    repo.update(&task.id, UpdateItem { status: Some(Status::Done), ..Default::default() })
        .await
        .unwrap();
    assert!(!repo.list_active_tags().await.unwrap().contains(&"x".to_string()));
    // reopen restores
    repo.update(&task.id, UpdateItem { status: Some(Status::Todo), ..Default::default() })
        .await
        .unwrap();
    assert!(repo.list_active_tags().await.unwrap().contains(&"x".to_string()));

    let note = repo.create(item_with_tags(Kind::Note, "n", &["y"])).await.unwrap();
    repo.update(&note.id, UpdateItem { archived: Some(true), ..Default::default() })
        .await
        .unwrap();
    assert!(!repo.list_active_tags().await.unwrap().contains(&"y".to_string()));
    repo.update(&note.id, UpdateItem { archived: Some(false), ..Default::default() })
        .await
        .unwrap();
    assert!(repo.list_active_tags().await.unwrap().contains(&"y".to_string()));
}

#[tokio::test]
async fn active_tags_multi_carrier_survives_partial_removal() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let a = repo.create(item_with_tags(Kind::Note, "a", &["team"])).await.unwrap();
    repo.create(item_with_tags(Kind::Note, "b", &["team"])).await.unwrap();
    // archive one of two carriers — tag survives
    repo.update(&a.id, UpdateItem { archived: Some(true), ..Default::default() })
        .await
        .unwrap();
    assert!(repo.list_active_tags().await.unwrap().contains(&"team".to_string()));
}

#[tokio::test]
async fn active_tags_empty_and_no_items() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    // no items → empty vec, not an error
    assert!(repo.list_active_tags().await.unwrap().is_empty());
    // item with an empty tag array contributes nothing
    repo.create(item_with_tags(Kind::Note, "n", &[])).await.unwrap();
    assert!(repo.list_active_tags().await.unwrap().is_empty());
}

// ---------------------------------------------------------------------------
// Filters combine (AND across categories, OR within tags)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn filter_project_and_status_alone() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let proj = repo.create_project("P").await.unwrap();
    let task = repo.create(new_item(Kind::Task, "t", "")).await.unwrap();
    repo.update(&task.id, UpdateItem { project_id: Some(proj.id.clone()), ..Default::default() })
        .await
        .unwrap();
    repo.create(new_item(Kind::Note, "n", "")).await.unwrap();

    // project filter alone
    let by_proj = repo
        .list(&ListFilter { project_id: Some(proj.id.clone()), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(by_proj.len(), 1);
    assert_eq!(by_proj[0].id, task.id);

    // status filter alone — a note (NULL status) must not match, no error
    let by_status = repo
        .list(&ListFilter { status: Some(Status::Todo), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(by_status.len(), 1);
    assert_eq!(by_status[0].id, task.id);
}

#[tokio::test]
async fn filter_tags_or_match() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    repo.create(item_with_tags(Kind::Note, "only-a", &["a"])).await.unwrap();
    repo.create(item_with_tags(Kind::Note, "only-b", &["b"])).await.unwrap();
    repo.create(item_with_tags(Kind::Note, "a-and-b", &["a", "b"])).await.unwrap();
    repo.create(item_with_tags(Kind::Note, "only-c", &["c"])).await.unwrap();

    let got = repo
        .list(&ListFilter { tags: Some(vec!["a".into(), "b".into()]), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(got.len(), 3, "OR-match: a, b, or (a,b) — but not c-only");
    assert!(got.iter().all(|i| i.title != "only-c"));
}

#[tokio::test]
async fn filter_empty_tag_list_is_noop() {
    // Highest-risk edge: Some(vec![]) must equal None (no filter) and raise NO
    // SQL error (an IN () would be a syntax error). D4.
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    repo.create(item_with_tags(Kind::Note, "x", &["a"])).await.unwrap();
    repo.create(item_with_tags(Kind::Note, "y", &["b"])).await.unwrap();

    let unfiltered = repo.list(&ListFilter::default()).await.unwrap().len();
    let empty_tags = repo
        .list(&ListFilter { tags: Some(vec![]), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(empty_tags.len(), unfiltered);
    assert_eq!(unfiltered, 2);
}

#[tokio::test]
async fn filter_tag_no_carrier_is_empty_not_error() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    repo.create(item_with_tags(Kind::Note, "x", &["a"])).await.unwrap();
    let got = repo
        .list(&ListFilter { tags: Some(vec!["nope".into()]), ..Default::default() })
        .await
        .unwrap();
    assert!(got.is_empty());
}

#[tokio::test]
async fn filter_project_status_tag_combined_is_anded() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let proj = repo.create_project("P").await.unwrap();
    let other = repo.create_project("Other").await.unwrap();

    // fully matching: proj + todo + tag "a"
    let good = repo.create(item_with_tags(Kind::Task, "good", &["a"])).await.unwrap();
    repo.update(&good.id, UpdateItem { project_id: Some(proj.id.clone()), status: Some(Status::Todo), ..Default::default() })
        .await
        .unwrap();
    // right project + tag but wrong status
    let wrong_status = repo.create(item_with_tags(Kind::Task, "ws", &["a"])).await.unwrap();
    repo.update(&wrong_status.id, UpdateItem { project_id: Some(proj.id.clone()), status: Some(Status::Doing), ..Default::default() })
        .await
        .unwrap();
    // right status + tag but wrong project
    let wrong_proj = repo.create(item_with_tags(Kind::Task, "wp", &["a"])).await.unwrap();
    repo.update(&wrong_proj.id, UpdateItem { project_id: Some(other.id.clone()), status: Some(Status::Todo), ..Default::default() })
        .await
        .unwrap();
    // right project + status but wrong tag
    let wrong_tag = repo.create(item_with_tags(Kind::Task, "wt", &["z"])).await.unwrap();
    repo.update(&wrong_tag.id, UpdateItem { project_id: Some(proj.id.clone()), status: Some(Status::Todo), ..Default::default() })
        .await
        .unwrap();

    let got = repo
        .list(&ListFilter {
            project_id: Some(proj.id.clone()),
            status: Some(Status::Todo),
            tags: Some(vec!["a".into()]),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(got.len(), 1, "AND across categories, not OR");
    assert_eq!(got[0].id, good.id);
}

#[tokio::test]
async fn filter_archived_exclusion_holds_with_other_filters() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let proj = repo.create_project("P").await.unwrap();
    let a = repo.create(item_with_tags(Kind::Task, "a", &["t"])).await.unwrap();
    repo.update(&a.id, UpdateItem { project_id: Some(proj.id.clone()), ..Default::default() })
        .await
        .unwrap();
    repo.update(&a.id, UpdateItem { archived: Some(true), ..Default::default() })
        .await
        .unwrap();
    // default (archived false) + project filter → excluded
    let got = repo
        .list(&ListFilter { project_id: Some(proj.id.clone()), tags: Some(vec!["t".into()]), ..Default::default() })
        .await
        .unwrap();
    assert!(got.is_empty());
}

// ---------------------------------------------------------------------------
// Sort modes
// ---------------------------------------------------------------------------

#[tokio::test]
async fn sort_updated_is_default() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let a = repo.create(new_item(Kind::Note, "a", "")).await.unwrap();
    let b = repo.create(new_item(Kind::Note, "b", "")).await.unwrap();
    // edit a → it becomes most recently updated
    repo.update(&a.id, UpdateItem { body: Some("edited".into()), ..Default::default() })
        .await
        .unwrap();
    let default_order = repo.list(&ListFilter::default()).await.unwrap();
    let explicit = repo
        .list(&ListFilter { sort: Some(Sort::Updated), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(default_order[0].id, a.id);
    assert_eq!(explicit[0].id, a.id);
    assert_eq!(default_order.last().unwrap().id, b.id);
}

#[tokio::test]
async fn sort_created_distinct_from_updated() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let a = repo.create(new_item(Kind::Note, "a", "")).await.unwrap();
    let b = repo.create(new_item(Kind::Note, "b", "")).await.unwrap();
    // edit A's body → Updated would put A first, but Created still orders by creation
    repo.update(&a.id, UpdateItem { body: Some("x".into()), ..Default::default() })
        .await
        .unwrap();
    let created = repo
        .list(&ListFilter { sort: Some(Sort::Created), ..Default::default() })
        .await
        .unwrap();
    // b created after a → b first under Created DESC
    assert_eq!(created[0].id, b.id);
    assert_eq!(created[1].id, a.id);
}

#[tokio::test]
async fn sort_priority_orders_high_normal_low_then_note() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let mk = |title, prio| NewItem { priority: Some(prio), ..new_item(Kind::Task, title, "") };
    let low = repo.create(mk("low", Priority::Low)).await.unwrap();
    let high = repo.create(mk("high", Priority::High)).await.unwrap();
    let normal = repo.create(mk("normal", Priority::Normal)).await.unwrap();
    let note = repo.create(new_item(Kind::Note, "note", "")).await.unwrap();

    let order: Vec<String> = repo
        .list(&ListFilter { sort: Some(Sort::Priority), ..Default::default() })
        .await
        .unwrap()
        .into_iter()
        .map(|i| i.id)
        .collect();
    assert_eq!(order, vec![high.id, normal.id, low.id, note.id]);
}

#[tokio::test]
async fn sort_status_orders_doing_todo_done_then_note() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let mk = |title, st| NewItem { status: Some(st), ..new_item(Kind::Task, title, "") };
    let done = repo.create(mk("done", Status::Done)).await.unwrap();
    let doing = repo.create(mk("doing", Status::Doing)).await.unwrap();
    let todo = repo.create(mk("todo", Status::Todo)).await.unwrap();
    let note = repo.create(new_item(Kind::Note, "note", "")).await.unwrap();

    let order: Vec<String> = repo
        .list(&ListFilter { sort: Some(Sort::Status), ..Default::default() })
        .await
        .unwrap()
        .into_iter()
        .map(|i| i.id)
        .collect();
    assert_eq!(order, vec![doing.id, todo.id, done.id, note.id]);
}

#[tokio::test]
async fn sort_pinned_supremacy_under_priority_and_status() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    // a note would sort last under Priority; pinning it forces it first
    let note = repo.create(new_item(Kind::Note, "note", "")).await.unwrap();
    repo.create(NewItem { priority: Some(Priority::High), ..new_item(Kind::Task, "hi", "") })
        .await
        .unwrap();
    repo.update(&note.id, UpdateItem { pinned: Some(true), ..Default::default() })
        .await
        .unwrap();

    let by_prio = repo
        .list(&ListFilter { sort: Some(Sort::Priority), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(by_prio[0].id, note.id, "pinned wins over priority order");

    let by_status = repo
        .list(&ListFilter { sort: Some(Sort::Status), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(by_status[0].id, note.id, "pinned wins over status order");
}

#[tokio::test]
async fn sort_rowid_tiebreak_is_stable() {
    // Depends on the test-support timestamp seam: force equal timestamps so the
    // rowid DESC tiebreak is the only differentiator.
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let a = repo.create(new_item(Kind::Note, "a", "")).await.unwrap();
    let b = repo.create(new_item(Kind::Note, "b", "")).await.unwrap();
    let ts = "2026-07-14T00:00:00+00:00";
    repo.set_timestamps_for_test(&a.id, ts, ts).await.unwrap();
    repo.set_timestamps_for_test(&b.id, ts, ts).await.unwrap();

    // b was inserted after a → higher rowid → first under rowid DESC. Stable
    // across repeated calls (never flaps).
    for _ in 0..3 {
        let order: Vec<String> =
            repo.list(&ListFilter::default()).await.unwrap().into_iter().map(|i| i.id).collect();
        assert_eq!(order, vec![b.id.clone(), a.id.clone()]);
    }
}

// ---------------------------------------------------------------------------
// search() post-filters (D1 signature)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn search_respects_project_filter() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let p1 = repo.create_project("P1").await.unwrap();
    let p2 = repo.create_project("P2").await.unwrap();
    let a = repo.create(new_item(Kind::Note, "shared keyword one", "")).await.unwrap();
    let b = repo.create(new_item(Kind::Note, "shared keyword two", "")).await.unwrap();
    repo.update(&a.id, UpdateItem { project_id: Some(p1.id.clone()), ..Default::default() })
        .await
        .unwrap();
    repo.update(&b.id, UpdateItem { project_id: Some(p2.id.clone()), ..Default::default() })
        .await
        .unwrap();

    let hits = repo
        .search("keyword", &ListFilter { project_id: Some(p1.id.clone()), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].id, a.id);
}

#[tokio::test]
async fn search_combines_tag_filter() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    repo.create(item_with_tags(Kind::Note, "keyword alpha", &["a"])).await.unwrap();
    repo.create(item_with_tags(Kind::Note, "keyword beta", &["b"])).await.unwrap();
    let hits = repo
        .search("keyword", &ListFilter { tags: Some(vec!["a".into()]), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].title, "keyword alpha");
}

#[tokio::test]
async fn search_forces_archived_exclusion_ignoring_filter() {
    // D5a: search must ALWAYS exclude archived, even if filter.archived = true
    // (unlike list(), which honors filter.archived).
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let a = repo.create(new_item(Kind::Note, "keyword here", "")).await.unwrap();
    repo.update(&a.id, UpdateItem { archived: Some(true), ..Default::default() })
        .await
        .unwrap();
    let hits = repo
        .search("keyword", &ListFilter { archived: Some(true), ..Default::default() })
        .await
        .unwrap();
    assert!(hits.is_empty(), "search ignores filter.archived and never returns archived items");
}

#[tokio::test]
async fn search_empty_query_falls_back_to_list_with_filter() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let proj = repo.create_project("P").await.unwrap();
    let a = repo.create(new_item(Kind::Note, "a", "")).await.unwrap();
    repo.update(&a.id, UpdateItem { project_id: Some(proj.id.clone()), ..Default::default() })
        .await
        .unwrap();
    repo.create(new_item(Kind::Note, "b", "")).await.unwrap();
    // empty query + active filter → list(filter) honors the filter
    let hits = repo
        .search("   ", &ListFilter { project_id: Some(proj.id.clone()), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].id, a.id);
}

// ---------------------------------------------------------------------------
// jira_url + project_id semantics
// ---------------------------------------------------------------------------

#[tokio::test]
async fn fields_set_on_create_persist() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let p = repo.create_project("P").await.unwrap();
    let input = NewItem {
        project_id: Some(p.id.clone()),
        jira_url: Some("https://jira.example.com/ABC-1".into()),
        ..new_item(Kind::Task, "t", "")
    };
    let created = repo.create(input).await.unwrap();
    assert_eq!(created.project_id, Some(p.id.clone()));
    assert_eq!(created.jira_url.as_deref(), Some("https://jira.example.com/ABC-1"));
    // round-trips through storage
    let fetched = repo.get(&created.id).await.unwrap();
    assert_eq!(fetched.project_id, Some(p.id));
    assert_eq!(fetched.jira_url.as_deref(), Some("https://jira.example.com/ABC-1"));
}

#[tokio::test]
async fn fields_apply_to_notes_too() {
    // Phase 1 breaks the "notes are metadata-light" pattern: notes carry
    // project_id + jira_url. Pin this so a future copy-paste guard can't block it.
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let p = repo.create_project("P").await.unwrap();
    let note = repo.create(new_item(Kind::Note, "n", "")).await.unwrap();
    let updated = repo
        .update(&note.id, UpdateItem {
            project_id: Some(p.id.clone()),
            jira_url: Some("https://jira.example.com/N-1".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(updated.project_id, Some(p.id));
    assert_eq!(updated.jira_url.as_deref(), Some("https://jira.example.com/N-1"));
    // still a note: no status/priority
    assert_eq!(updated.status, None);
    assert_eq!(updated.priority, None);
}

#[tokio::test]
async fn fields_clear_via_empty_string() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let p = repo.create_project("P").await.unwrap();
    let item = repo
        .create(NewItem { project_id: Some(p.id.clone()), jira_url: Some("https://x/Y-1".into()), ..new_item(Kind::Task, "t", "") })
        .await
        .unwrap();
    let cleared = repo
        .update(&item.id, UpdateItem { project_id: Some(String::new()), jira_url: Some(String::new()), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(cleared.project_id, None);
    assert_eq!(cleared.jira_url, None);
}

#[tokio::test]
async fn fields_omitted_are_unchanged() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let p = repo.create_project("P").await.unwrap();
    let item = repo
        .create(NewItem { project_id: Some(p.id.clone()), jira_url: Some("https://x/Y-1".into()), ..new_item(Kind::Task, "t", "") })
        .await
        .unwrap();
    // send an unrelated title patch; both fields must survive
    let after = repo
        .update(&item.id, UpdateItem { title: Some("renamed".into()), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(after.project_id, Some(p.id));
    assert_eq!(after.jira_url.as_deref(), Some("https://x/Y-1"));
}

#[tokio::test]
async fn fields_bump_updated_at() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let p = repo.create_project("P").await.unwrap();
    let item = repo.create(new_item(Kind::Task, "t", "")).await.unwrap();
    // freeze timestamps to an old value so any bump is detectable
    let old = "2000-01-01T00:00:00+00:00";
    repo.set_timestamps_for_test(&item.id, old, old).await.unwrap();

    let a = repo
        .update(&item.id, UpdateItem { jira_url: Some("https://x/Y-1".into()), ..Default::default() })
        .await
        .unwrap();
    assert!(a.updated_at > old.to_string(), "setting jira_url bumps updated_at");

    repo.set_timestamps_for_test(&item.id, old, old).await.unwrap();
    let b = repo
        .update(&item.id, UpdateItem { project_id: Some(p.id.clone()), ..Default::default() })
        .await
        .unwrap();
    assert!(b.updated_at > old.to_string(), "setting project_id bumps updated_at");
}

#[tokio::test]
async fn nonexistent_project_id_is_invalid_on_create_and_update() {
    // D2a: assigning a project_id that doesn't exist → clean Invalid, NOT a
    // leaked raw FOREIGN KEY constraint error.
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let err = repo
        .create(NewItem { project_id: Some("ghost".into()), ..new_item(Kind::Task, "t", "") })
        .await
        .unwrap_err();
    let AppError::Invalid(msg) = err else { panic!("expected Invalid, got {err:?}") };
    assert!(!msg.contains("FOREIGN KEY"), "must not leak raw FK text: {msg}");

    let item = repo.create(new_item(Kind::Task, "t2", "")).await.unwrap();
    let err2 = repo
        .update(&item.id, UpdateItem { project_id: Some("ghost".into()), ..Default::default() })
        .await
        .unwrap_err();
    assert!(matches!(err2, AppError::Invalid(_)));
}

#[tokio::test]
async fn pin_and_archive_do_not_bump_updated_at_with_new_fields() {
    // Non-bump regression: after populating the new fields, pin/archive flips
    // must NOT move updated_at (the extended UPDATE column list must not start
    // writing updated_at unconditionally).
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let p = repo.create_project("P").await.unwrap();
    let item = repo
        .create(NewItem { project_id: Some(p.id.clone()), jira_url: Some("https://x/Y-1".into()), ..new_item(Kind::Task, "t", "") })
        .await
        .unwrap();
    let baseline = item.updated_at.clone();

    let pinned = repo.update(&item.id, UpdateItem { pinned: Some(true), ..Default::default() }).await.unwrap();
    assert_eq!(pinned.updated_at, baseline, "pin flip must not bump");
    let archived = repo.update(&item.id, UpdateItem { archived: Some(true), ..Default::default() }).await.unwrap();
    assert_eq!(archived.updated_at, baseline, "archive flip must not bump");
}

// ---------------------------------------------------------------------------
// jira_url scheme allowlist (Section 8)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn jira_url_scheme_allowlist() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();

    // hostile / non-http(s) schemes rejected on create
    for bad in [
        "javascript:alert(1)",
        "file:///etc/passwd",
        "data:text/html,x",
        "jira.example.com/ABC-1", // scheme-less/relative
    ] {
        let err = repo
            .create(NewItem { jira_url: Some(bad.into()), ..new_item(Kind::Task, "t", "") })
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Invalid(_)), "expected Invalid for {bad}, got {err:?}");
    }

    // weak-fallback guard: bare scheme with no host is rejected
    let err = repo
        .create(NewItem { jira_url: Some("https://".into()), ..new_item(Kind::Task, "t", "") })
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::Invalid(_)));

    // weak-fallback guard: uppercase scheme is still accepted (case-insensitive match)
    let upper = repo
        .create(NewItem {
            jira_url: Some("HTTPS://jira.example.com/ABC-1".into()),
            ..new_item(Kind::Task, "t", "")
        })
        .await
        .unwrap();
    assert_eq!(upper.jira_url.as_deref(), Some("HTTPS://jira.example.com/ABC-1"));

    // valid https and http both succeed and persist verbatim
    let https_item = repo
        .create(NewItem {
            jira_url: Some("https://jira.example.com/ABC-1".into()),
            ..new_item(Kind::Task, "t", "")
        })
        .await
        .unwrap();
    assert_eq!(https_item.jira_url.as_deref(), Some("https://jira.example.com/ABC-1"));

    let http_item = repo
        .create(NewItem {
            jira_url: Some("http://jira.example.com/ABC-1".into()),
            ..new_item(Kind::Task, "t", "")
        })
        .await
        .unwrap();
    assert_eq!(http_item.jira_url.as_deref(), Some("http://jira.example.com/ABC-1"));

    // update: invalid scheme rejected
    let err2 = repo
        .update(&https_item.id, UpdateItem { jira_url: Some("javascript:alert(1)".into()), ..Default::default() })
        .await
        .unwrap_err();
    assert!(matches!(err2, AppError::Invalid(_)));

    // update: empty string still clears to None, no scheme error (empty exempt)
    let cleared = repo
        .update(&https_item.id, UpdateItem { jira_url: Some(String::new()), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(cleared.jira_url, None);
}

// ---------------------------------------------------------------------------
// ListFilter / Project camelCase IPC shape
// ---------------------------------------------------------------------------

#[tokio::test]
async fn list_filter_deserializes_camelcase() {
    let full: ListFilter = serde_json::from_str(
        r#"{"projectId":"p1","tags":["a","b"],"sort":"priority","status":"doing"}"#,
    )
    .unwrap();
    assert_eq!(full.project_id, Some("p1".to_string()));
    assert_eq!(full.tags, Some(vec!["a".to_string(), "b".to_string()]));
    assert_eq!(full.sort, Some(Sort::Priority));
    assert_eq!(full.status, Some(Status::Doing));

    let empty: ListFilter = serde_json::from_str(r#"{}"#).unwrap();
    assert!(empty.kind.is_none());
    assert!(empty.archived.is_none());
    assert!(empty.project_id.is_none());
    assert!(empty.status.is_none());
    assert!(empty.tags.is_none());
    assert!(empty.sort.is_none());
}

#[tokio::test]
async fn project_shapes_serialize_camelcase() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let created: Project = repo.create_project("X").await.unwrap();
    let json = serde_json::to_value(&created).unwrap();
    assert!(json["id"].is_string());
    assert_eq!(json["name"], "X");
    assert!(json["createdAt"].is_string());

    let listed: Vec<ProjectWithCount> = repo.list_projects().await.unwrap();
    let with_count = listed.iter().find(|p| p.id == created.id).unwrap();
    let json2 = serde_json::to_value(with_count).unwrap();
    assert!(json2["id"].is_string());
    assert_eq!(json2["name"], "X");
    assert!(json2["createdAt"].is_string());
    assert!(json2["itemCount"].is_number());
    assert_eq!(json2["itemCount"], 0);
}