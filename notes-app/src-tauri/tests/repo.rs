use notes_app_lib::db::{ItemRepository, SqliteRepository};
use notes_app_lib::models::{Kind, ListFilter, NewItem, Priority, Status, UpdateItem};

fn new_item(kind: Kind, title: &str, body: &str) -> NewItem {
    NewItem {
        kind,
        title: title.into(),
        body: Some(body.into()),
        status: None,
        priority: None,
        due_at: None,
        tags: Some(vec!["work".into()]),
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
        .list(&ListFilter { kind: Some(Kind::Task), archived: None })
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
    let hits = repo.search("budget").await.unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].id, note.id);

    let prefix_hits = repo.search("quart").await.unwrap();
    assert_eq!(prefix_hits.len(), 1, "prefix search should match 'Quarterly'");

    // raw quotes/parens/minus must not cause an FTS5 syntax error
    assert!(repo.search("\"unbalanced (syntax -bomb").await.unwrap().is_empty());

    // empty query falls back to recent list
    assert_eq!(repo.search("   ").await.unwrap().len(), 2);

    // update syncs the FTS index
    repo.update(&note.id, UpdateItem { body: Some("Now about hiring".into()), ..Default::default() })
        .await
        .unwrap();
    assert!(repo.search("budget").await.unwrap().is_empty());
    assert_eq!(repo.search("hiring").await.unwrap().len(), 1);

    // archived items leave list and search
    repo.update(&note.id, UpdateItem { archived: Some(true), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(repo.list(&ListFilter::default()).await.unwrap().len(), 1);
    assert!(repo.search("hiring").await.unwrap().is_empty());

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

    // and NewItem deserializes from camelCase with optional fields omitted
    let parsed: NewItem =
        serde_json::from_str(r#"{"kind":"note","title":"From JS"}"#).unwrap();
    assert_eq!(parsed.kind, Kind::Note);
}
