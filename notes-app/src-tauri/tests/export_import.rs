//! Stage 2 (plan.6 step 18): merge-shaped fixture tests for the canonical
//! item-file store, exercised through the PUBLIC `store::itemfile` API — the
//! very serialize/parse/scan the index rebuild uses. They assert the
//! git-merge contract directly:
//! - byte-identical idempotent export (an unchanged item never diffs);
//! - round-trip equality including the kind gate on import;
//! - id + filename stability across re-export;
//! - two branches' disjoint adds both import;
//! - a clean 3-way merge of one item (title from A, status from B) imports;
//! - a file with unresolved conflict markers is rejected per-file while its
//!   neighbours still import (partial success);
//! - no exported file carries secret material.
//!
//! Manager-level end-to-end import/reload/upgrade is covered in
//! `project_manager.rs`; this file is the format/merge contract in isolation.

use notes_app_lib::models::{Item, Kind, Priority, Status};
use notes_app_lib::store::itemfile;
use notes_app_lib::store::promptfile;

use sqlx::types::Json;
use tempfile::tempdir;

const ID_A: &str = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ID_B: &str = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const TS: &str = "2026-07-14T00:00:00.000+00:00";

fn note(id: &str, title: &str) -> Item {
    Item {
        id: id.into(),
        kind: Kind::Note,
        title: title.into(),
        body: format!("{title} body\n"),
        status: None,
        priority: None,
        due_at: None,
        tags: Json(vec!["work".into()]),
        created_at: TS.into(),
        updated_at: TS.into(),
        archived: false,
        pinned: false,
        project_id: None,
        jira_url: None,
    }
}

fn task(id: &str, title: &str) -> Item {
    Item {
        kind: Kind::Task,
        status: Some(Status::Todo),
        priority: Some(Priority::Normal),
        due_at: Some("2026-07-20T00:00:00.000+00:00".into()),
        jira_url: Some("https://x.atlassian.net/browse/ABC-1".into()),
        ..note(id, title)
    }
}

#[test]
fn idempotent_export_is_byte_stable() {
    for it in [note(ID_A, "a note"), task(ID_B, "a task")] {
        let once = itemfile::serialize(&it);
        let twice = itemfile::serialize(&itemfile::parse(&once).unwrap());
        assert_eq!(once, twice, "re-exporting a parsed item must be byte-identical");
    }
}

#[test]
fn round_trip_gates_an_injected_task_field_out_of_a_note() {
    // A note file that a hand-edit/merge gave a task-only `status` must import as
    // a clean note (the import kind gate), and re-export without that field.
    let text = format!(
        "---\nid: {ID_A}\nkind: note\ntitle: \"gated\"\nstatus: doing\npinned: false\n\
         archived: false\ntags: []\ncreated_at: {TS}\nupdated_at: {TS}\n---\nbody\n"
    );
    let parsed = itemfile::parse(&text).unwrap();
    assert_eq!(parsed.kind, Kind::Note);
    assert_eq!(parsed.status, None);
    assert!(!itemfile::serialize(&parsed).contains("status:"));
}

#[test]
fn id_and_filename_are_stable_across_reexport() {
    let it = task(ID_A, "stable");
    let before = itemfile::file_name(&it.id).unwrap();
    let reparsed = itemfile::parse(&itemfile::serialize(&it)).unwrap();
    let after = itemfile::file_name(&reparsed.id).unwrap();
    assert_eq!(before, after);
    assert_eq!(before, format!("{ID_A}.md"), "the filename is derived only from the id");
}

#[test]
fn disjoint_adds_from_two_branches_both_import() {
    // Two branches each added a different item file; a merge brings both into one
    // items dir. Scanning must yield both, with no errors.
    let dir = tempdir().unwrap();
    itemfile::write_item(dir.path(), &note(ID_A, "from branch a")).unwrap();
    itemfile::write_item(dir.path(), &note(ID_B, "from branch b")).unwrap();

    let out = itemfile::scan(dir.path());
    assert!(out.errors.is_empty(), "clean files scan without errors");
    let mut ids: Vec<&str> = out.items.iter().map(|i| i.id.as_str()).collect();
    ids.sort();
    assert_eq!(ids, vec![ID_A, ID_B], "both branches' additions import");
}

#[test]
fn same_item_clean_three_way_merge_imports_both_field_changes() {
    // git cleanly merges branch A's title change (one line) and branch B's status
    // change (another line) into a single task file. The merged bytes parse with
    // BOTH changes applied.
    let merged = format!(
        "---\nid: {ID_A}\nkind: task\ntitle: \"renamed on branch A\"\nstatus: done\n\
         priority: normal\npinned: false\narchived: false\ntags: []\n\
         created_at: {TS}\nupdated_at: {TS}\n---\nbody\n"
    );
    let it = itemfile::parse(&merged).unwrap();
    assert_eq!(it.title, "renamed on branch A", "branch A's title change survives");
    assert_eq!(it.status, Some(Status::Done), "branch B's status change survives");
}

#[test]
fn a_conflicted_file_is_rejected_while_its_neighbours_import() {
    // Partial success: one file carries unresolved conflict markers; the clean
    // file still imports, and the bad file is reported by name.
    let dir = tempdir().unwrap();
    itemfile::write_item(dir.path(), &note(ID_A, "clean")).unwrap();
    std::fs::write(
        dir.path().join(format!("{ID_B}.md")),
        format!(
            "---\nid: {ID_B}\nkind: note\ntitle: \"x\"\n<<<<<<< HEAD\npinned: false\n=======\n\
             pinned: true\n>>>>>>> branch\narchived: false\ntags: []\n\
             created_at: {TS}\nupdated_at: {TS}\n---\nbody\n"
        ),
    )
    .unwrap();

    let out = itemfile::scan(dir.path());
    assert_eq!(out.items.len(), 1, "the clean file still imports");
    assert_eq!(out.items[0].id, ID_A);
    assert_eq!(out.errors.len(), 1, "the conflicted file is reported, not imported");
    assert!(out.errors[0].0.contains(ID_B), "the report names the offending file");
    assert!(matches!(out.errors[0].1, itemfile::ItemFileError::ConflictMarkers));
}

#[test]
fn no_exported_file_contains_secret_material() {
    // Items never hold keyring material; a written file must contain no field
    // that could smuggle a token (plan.6 step 18, Section 4.5).
    let dir = tempdir().unwrap();
    itemfile::write_item(dir.path(), &task(ID_A, "with a jira link")).unwrap();
    let text = std::fs::read_to_string(dir.path().join(format!("{ID_A}.md"))).unwrap().to_lowercase();
    for forbidden in ["token", "secret", "password", "apikey", "api_key", "authorization", "bearer"] {
        assert!(!text.contains(forbidden), "an exported file must never contain {forbidden}");
    }
}

// ---------------------------------------------------------------------------
// Prompts (plan.7): the canonical prompt/version file format, exercised
// through the PUBLIC `store::promptfile` API — same spirit as the item tests
// above, but proving the two-level `prompts/<uuid>/` layout's git-merge
// contract specifically: disjoint version files (one per branch's edit) merge
// with both preserved, a conflicted version is skipped per-file, and no
// exported file carries secret material. Prompt REPOSITORY-level invariants
// live in `tests/repo_prompts.rs`; manager/reload integration lives in
// `tests/project_manager.rs`.
// ---------------------------------------------------------------------------

const PROMPT_ID: &str = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const VERSION_ID: &str = "dddddddd-dddd-dddd-dddd-dddddddddddd";

fn prompt_head() -> promptfile::PromptRecord {
    promptfile::PromptRecord { id: PROMPT_ID.into(), reusable: true, created_at: TS.into() }
}

fn prompt_version(id: &str, title: &str, body: &str) -> promptfile::PromptVersionRecord {
    promptfile::PromptVersionRecord {
        id: id.into(),
        prompt_id: PROMPT_ID.into(),
        title: title.into(),
        body: body.into(),
        source: "manual".into(),
        created_at: TS.into(),
    }
}

#[test]
fn prompt_idempotent_export_is_byte_stable() {
    // Mirrors `idempotent_export_is_byte_stable` for items: an unchanged
    // prompt head and an unchanged version must never produce a spurious git
    // diff on re-export.
    let head = prompt_head();
    let once = promptfile::serialize_prompt(&head);
    let twice = promptfile::serialize_prompt(&promptfile::parse_prompt(&once).unwrap());
    assert_eq!(once, twice, "re-exporting a parsed prompt head must be byte-identical");

    let version = prompt_version(VERSION_ID, "Draft the release email", "Hi team\n");
    let once = promptfile::serialize_version(&version);
    let twice = promptfile::serialize_version(&promptfile::parse_version(&once, PROMPT_ID).unwrap());
    assert_eq!(once, twice, "re-exporting a parsed version must be byte-identical");
}

#[test]
fn two_branches_each_adding_a_version_merge_into_one_prompt_with_both_preserved() {
    // The acceptance test for the versioning choice (plan.7 Section 5): every
    // content edit writes a NEW immutable version file and never touches an
    // existing one, so two branches each appending a version to the SAME
    // prompt produce two DISJOINT files that a git merge brings together
    // cleanly, with both preserved (mirrors `disjoint_adds_from_two_branches_both_import`).
    let dir = tempdir().unwrap();
    promptfile::write_prompt(dir.path(), &prompt_head()).unwrap();

    let version_a = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    let version_b = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    promptfile::write_version(dir.path(), &prompt_version(version_a, "from branch a", "a body")).unwrap();
    promptfile::write_version(dir.path(), &prompt_version(version_b, "from branch b", "b body")).unwrap();

    let out = promptfile::scan(dir.path());
    assert!(out.errors.is_empty(), "clean disjoint version files scan without errors: {:?}", out.errors);
    assert_eq!(out.prompts.len(), 1, "both branches' version files belong to the SAME prompt");
    let mut ids: Vec<&str> = out.prompts[0].versions.iter().map(|v| v.id.as_str()).collect();
    ids.sort();
    let mut expected = vec![version_a, version_b];
    expected.sort();
    assert_eq!(ids, expected, "both branches' versions are preserved, neither overwriting the other");
}

#[test]
fn a_conflicted_prompt_version_is_skipped_while_its_neighbour_imports() {
    // Partial success, mirroring `a_conflicted_file_is_rejected_while_its_neighbours_import`:
    // one version file carries unresolved conflict markers; the clean sibling
    // version (same prompt) still imports, and the bad file is named.
    let dir = tempdir().unwrap();
    promptfile::write_prompt(dir.path(), &prompt_head()).unwrap();
    let clean_version = "11111111-2222-3333-4444-555555555555";
    promptfile::write_version(dir.path(), &prompt_version(clean_version, "clean", "clean body")).unwrap();

    let bad_version = "66666666-7777-8888-9999-000000000000";
    std::fs::write(
        dir.path().join(PROMPT_ID).join(format!("{bad_version}.md")),
        format!(
            "---\nid: {bad_version}\nsource: manual\ncreated_at: {TS}\ntitle: \"x\"\n\
             <<<<<<< HEAD\nfoo\n=======\nbar\n>>>>>>> branch\n---\nbody\n"
        ),
    )
    .unwrap();

    let out = promptfile::scan(dir.path());
    assert_eq!(out.prompts.len(), 1, "the prompt still imports via its clean version");
    assert_eq!(out.prompts[0].versions.len(), 1);
    assert_eq!(out.prompts[0].versions[0].id, clean_version);
    assert_eq!(out.errors.len(), 1, "the conflicted version file is reported, not imported");
    assert!(out.errors[0].0.contains(bad_version), "the report names the offending file");
    assert!(matches!(out.errors[0].1, promptfile::PromptFileError::ConflictMarkers));
}

#[test]
fn no_exported_prompt_file_contains_secret_material() {
    // Mirrors `no_exported_file_contains_secret_material` for items (M3):
    // neither the prompt head nor a version file may ever carry token/secret
    // material.
    let dir = tempdir().unwrap();
    promptfile::write_prompt(dir.path(), &prompt_head()).unwrap();
    let version = prompt_version(VERSION_ID, "Draft the release email", "Hi team, please review.");
    promptfile::write_version(dir.path(), &version).unwrap();

    let prompt_text =
        std::fs::read_to_string(dir.path().join(PROMPT_ID).join("prompt.md")).unwrap().to_lowercase();
    let version_text = std::fs::read_to_string(dir.path().join(PROMPT_ID).join(format!("{VERSION_ID}.md")))
        .unwrap()
        .to_lowercase();
    for forbidden in ["token", "secret", "password", "apikey", "api_key", "authorization", "bearer"] {
        assert!(!prompt_text.contains(forbidden), "prompt.md must never contain {forbidden}");
        assert!(!version_text.contains(forbidden), "a version file must never contain {forbidden}");
    }
}
