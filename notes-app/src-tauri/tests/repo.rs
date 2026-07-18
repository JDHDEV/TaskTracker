use notes_app_lib::db::{ItemRepository, SqliteRepository};
use notes_app_lib::error::AppError;
use notes_app_lib::models::{Kind, ListFilter, NewItem, Priority, Sort, Status, UpdateItem};

// The per-project store no longer owns project CRUD or app settings (those moved
// to the app-level catalog + ProjectManager — see tests/project_manager.rs), and
// a row's `project_id` is never persisted (always NULL; the manager stamps the
// owning UUID). These tests cover what the store still owns: item CRUD, FTS
// search, the derived tag vocabulary, sort/tiebreak, jira_url, and due_at.

fn new_item(kind: Kind, title: &str, body: &str) -> NewItem {
    NewItem {
        kind,
        title: title.into(),
        body: Some(body.into()),
        status: None,
        priority: None,
        due_at: None,
        tags: Some(vec!["work".into()]),
        // Routing key consumed by the manager; the store ignores it and stores NULL.
        project_id: String::new(),
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
    // project_id is never persisted in-store (Decision 4).
    assert_eq!(note.project_id, None);

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
    // projectId is NULL in-store (the manager stamps the owning UUID on return);
    // jiraUrl null when unset
    assert!(json["projectId"].is_null());
    assert!(json["jiraUrl"].is_null());

    // NewItem deserializes from camelCase; projectId is now REQUIRED (the routing
    // target), and optional fields may be omitted
    let parsed: NewItem =
        serde_json::from_str(r#"{"kind":"note","title":"From JS","projectId":"p1"}"#).unwrap();
    assert_eq!(parsed.kind, Kind::Note);
    assert_eq!(parsed.project_id, "p1");
    assert!(parsed.jira_url.is_none());

    // omitting the required projectId is a deserialization error
    assert!(serde_json::from_str::<NewItem>(r#"{"kind":"note","title":"x"}"#).is_err());
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
// Filters combine (AND across categories, OR within tags). Project scoping is
// no longer a per-store filter (the manager chooses which stores to query), so
// these cover kind/status/tags only.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn filter_status_alone_excludes_notes() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let task = repo.create(new_item(Kind::Task, "t", "")).await.unwrap();
    repo.create(new_item(Kind::Note, "n", "")).await.unwrap();
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
async fn filter_status_and_tag_combined_is_anded() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    // fully matching: todo + tag "a"
    let good = repo.create(item_with_tags(Kind::Task, "good", &["a"])).await.unwrap();
    repo.update(&good.id, UpdateItem { status: Some(Status::Todo), ..Default::default() })
        .await
        .unwrap();
    // right tag but wrong status
    let wrong_status = repo.create(item_with_tags(Kind::Task, "ws", &["a"])).await.unwrap();
    repo.update(&wrong_status.id, UpdateItem { status: Some(Status::Doing), ..Default::default() })
        .await
        .unwrap();
    // right status but wrong tag
    let wrong_tag = repo.create(item_with_tags(Kind::Task, "wt", &["z"])).await.unwrap();
    repo.update(&wrong_tag.id, UpdateItem { status: Some(Status::Todo), ..Default::default() })
        .await
        .unwrap();

    let got = repo
        .list(&ListFilter {
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
    let a = repo.create(item_with_tags(Kind::Task, "a", &["t"])).await.unwrap();
    repo.update(&a.id, UpdateItem { archived: Some(true), ..Default::default() })
        .await
        .unwrap();
    // default (archived false) + tag filter → excluded
    let got = repo
        .list(&ListFilter { tags: Some(vec!["t".into()]), ..Default::default() })
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
    // Pin explicit, distinct timestamps so a same-millisecond tie between the
    // rapid create/update calls can't flip the order under the (created_at, id)
    // tiebreak — this retires the documented flake (memory: flaky-sort-updated).
    // a is edited last, so its updated_at is the newest; b stays oldest.
    repo.set_timestamps_for_test(&a.id, "2026-07-14T00:00:00.000+00:00", "2026-07-14T00:00:02.000+00:00")
        .await
        .unwrap();
    repo.set_timestamps_for_test(&b.id, "2026-07-14T00:00:01.000+00:00", "2026-07-14T00:00:01.000+00:00")
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
async fn sort_equal_timestamps_tiebreak_by_id_asc() {
    // The tiebreak is (created_at DESC, id ASC), NOT rowid — rowids collide
    // across per-project files and are reassigned on index rebuild, so they
    // cannot order a merged multi-store set. Force equal timestamps and known
    // ids so `id ASC` is the sole differentiator, and assert the order is
    // stable across repeated calls (never flaps). Replaces the retired
    // sort_rowid_tiebreak_is_stable test.
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let a = repo.create(new_item(Kind::Note, "a", "")).await.unwrap();
    let b = repo.create(new_item(Kind::Note, "b", "")).await.unwrap();
    let ts = "2026-07-14T00:00:00.000+00:00";
    repo.set_timestamps_for_test(&a.id, ts, ts).await.unwrap();
    repo.set_timestamps_for_test(&b.id, ts, ts).await.unwrap();
    // Force ids so "id-1" < "id-2" lexically, independent of the minted UUIDs
    // and of insertion order (b, the later insert, gets the SMALLER id).
    repo.set_id_for_test(&a.id, "id-2").await.unwrap();
    repo.set_id_for_test(&b.id, "id-1").await.unwrap();

    // Equal timestamps → id ASC decides: "id-1" (was b) leads "id-2" (was a).
    // rowid DESC would have put b first for a different reason; this proves the
    // ordering follows id, not insertion.
    for _ in 0..3 {
        let order: Vec<String> =
            repo.list(&ListFilter::default()).await.unwrap().into_iter().map(|i| i.id).collect();
        assert_eq!(order, vec!["id-1".to_string(), "id-2".to_string()]);
    }
}

#[tokio::test]
async fn minted_timestamps_have_fixed_fractional_precision() {
    // K10: `to_rfc3339()` trims trailing fractional zeros, so two same-instant
    // timestamps can differ in digit width and sort wrong lexically (a hazard
    // masked today only by the rowid tiebreak). The producer pins to exactly
    // three fractional digits; assert that so lexical == chronological order.
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let item = repo.create(new_item(Kind::Note, "a", "")).await.unwrap();
    let frac: String = item
        .created_at
        .split('.')
        .nth(1)
        .expect("minted timestamp carries a fractional part")
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    assert_eq!(frac.len(), 3, "expected fixed ms precision, got {}", item.created_at);
}

#[tokio::test]
async fn application_id_matches_const() {
    // The 0005_meta.sql migration stamps PRAGMA application_id; it MUST equal
    // the single-source-of-truth Rust const, because foreign-DB rejection
    // (Section 4.3) compares an opened file's header against that const.
    // connect_in_memory runs the same migration set a real store does.
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    assert_eq!(
        repo.application_id_for_test().await.unwrap(),
        notes_app_lib::db::WORKNOTES_APPLICATION_ID,
        "migration application_id literal must equal db::WORKNOTES_APPLICATION_ID"
    );
}

// ---------------------------------------------------------------------------
// search() post-filters (D1 signature)
// ---------------------------------------------------------------------------

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
    repo.create(new_item(Kind::Task, "a task", "")).await.unwrap();
    repo.create(new_item(Kind::Note, "a note", "")).await.unwrap();
    // empty query + active (kind) filter → list(filter) honors the filter
    let hits = repo
        .search("   ", &ListFilter { kind: Some(Kind::Task), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].title, "a task");
}

// ---------------------------------------------------------------------------
// jira_url semantics (project_id is no longer a persisted per-item field)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn jira_url_set_on_create_persists() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let input = NewItem {
        jira_url: Some("https://jira.example.com/ABC-1".into()),
        ..new_item(Kind::Task, "t", "")
    };
    let created = repo.create(input).await.unwrap();
    assert_eq!(created.jira_url.as_deref(), Some("https://jira.example.com/ABC-1"));
    // never persisted in-store
    assert_eq!(created.project_id, None);
    let fetched = repo.get(&created.id).await.unwrap();
    assert_eq!(fetched.jira_url.as_deref(), Some("https://jira.example.com/ABC-1"));
}

#[tokio::test]
async fn jira_url_applies_to_notes_too() {
    // Notes carry jira_url (the "notes are metadata-light" pattern is broken for
    // jira_url); pin this so a future copy-paste guard can't block it.
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let note = repo.create(new_item(Kind::Note, "n", "")).await.unwrap();
    let updated = repo
        .update(&note.id, UpdateItem {
            jira_url: Some("https://jira.example.com/N-1".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(updated.jira_url.as_deref(), Some("https://jira.example.com/N-1"));
    // still a note: no status/priority
    assert_eq!(updated.status, None);
    assert_eq!(updated.priority, None);
}

#[tokio::test]
async fn jira_url_clears_via_empty_string() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let item = repo
        .create(NewItem { jira_url: Some("https://x/Y-1".into()), ..new_item(Kind::Task, "t", "") })
        .await
        .unwrap();
    let cleared = repo
        .update(&item.id, UpdateItem { jira_url: Some(String::new()), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(cleared.jira_url, None);
}

#[tokio::test]
async fn jira_url_omitted_is_unchanged() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let item = repo
        .create(NewItem { jira_url: Some("https://x/Y-1".into()), ..new_item(Kind::Task, "t", "") })
        .await
        .unwrap();
    // send an unrelated title patch; jira_url must survive
    let after = repo
        .update(&item.id, UpdateItem { title: Some("renamed".into()), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(after.jira_url.as_deref(), Some("https://x/Y-1"));
}

#[tokio::test]
async fn jira_url_change_bumps_updated_at() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let item = repo.create(new_item(Kind::Task, "t", "")).await.unwrap();
    let old = "2000-01-01T00:00:00+00:00";
    repo.set_timestamps_for_test(&item.id, old, old).await.unwrap();
    let a = repo
        .update(&item.id, UpdateItem { jira_url: Some("https://x/Y-1".into()), ..Default::default() })
        .await
        .unwrap();
    assert!(a.updated_at > old.to_string(), "setting jira_url bumps updated_at");
}

#[tokio::test]
async fn pin_and_archive_do_not_bump_updated_at() {
    // Non-bump regression: pin/archive flips must NOT move updated_at (the
    // UPDATE column list must not start writing updated_at unconditionally).
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let item = repo
        .create(NewItem { jira_url: Some("https://x/Y-1".into()), ..new_item(Kind::Task, "t", "") })
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
// due_at (task-only; capture/display is frontend-only)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn due_at_set_on_create_persists() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let created = repo
        .create(NewItem { due_at: Some("2026-07-20T00:00:00Z".into()), ..new_item(Kind::Task, "t", "") })
        .await
        .unwrap();
    assert_eq!(created.due_at.as_deref(), Some("2026-07-20T00:00:00Z"));
    let fetched = repo.get(&created.id).await.unwrap();
    assert_eq!(fetched.due_at.as_deref(), Some("2026-07-20T00:00:00Z"));
}

#[tokio::test]
async fn due_at_empty_string_clears_on_update() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let task = repo
        .create(NewItem { due_at: Some("2026-07-20T00:00:00Z".into()), ..new_item(Kind::Task, "t", "") })
        .await
        .unwrap();
    let cleared = repo
        .update(&task.id, UpdateItem { due_at: Some(String::new()), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(cleared.due_at, None);
}

#[tokio::test]
async fn due_at_omitted_patch_leaves_existing_value_unchanged() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let task = repo
        .create(NewItem { due_at: Some("2026-07-20T00:00:00Z".into()), ..new_item(Kind::Task, "t", "") })
        .await
        .unwrap();
    // unrelated patch, due_at omitted (None) — must survive
    let after = repo
        .update(&task.id, UpdateItem { title: Some("renamed".into()), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(after.due_at.as_deref(), Some("2026-07-20T00:00:00Z"));
}

#[tokio::test]
async fn due_at_patch_on_a_note_is_silently_ignored() {
    // CLAUDE.md invariant: notes never carry dueAt — a patch attempting to set
    // it must be silently ignored (the due_at block in update() is gated on
    // Kind::Task).
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let note = repo.create(new_item(Kind::Note, "n", "")).await.unwrap();
    assert_eq!(note.due_at, None);
    let after = repo
        .update(&note.id, UpdateItem { due_at: Some("2026-07-20T00:00:00Z".into()), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(after.due_at, None, "a due_at patch on a note must be silently dropped");
}

#[tokio::test]
async fn due_at_change_on_task_bumps_updated_at() {
    let repo = SqliteRepository::connect_in_memory().await.unwrap();
    let task = repo.create(new_item(Kind::Task, "t", "")).await.unwrap();
    let old = "2000-01-01T00:00:00+00:00";
    repo.set_timestamps_for_test(&task.id, old, old).await.unwrap();
    let updated = repo
        .update(&task.id, UpdateItem { due_at: Some("2026-07-20T00:00:00Z".into()), ..Default::default() })
        .await
        .unwrap();
    assert!(updated.updated_at > old.to_string(), "setting due_at bumps updated_at");
}

// ---------------------------------------------------------------------------
// ListFilter camelCase IPC shape (projectId still selects which store to query)
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
