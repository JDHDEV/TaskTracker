//! Golden on-disk fixtures: the rule in `CLAUDE.md` "On-disk backward
//! compatibility", made executable.
//!
//! `tests/fixtures/v1_0_0/` holds byte-exact copies of the canonical store as
//! shipped today - `items/<uuid>.md` plus `prompts/<prompt-uuid>/{prompt.md,
//! <version-uuid>.md}`. Every future build must still read them.
//!
//! This is deliberately NOT what `export_import.rs` does. That file round-trips
//! items the CURRENT code serialized, so it follows the format wherever it moves
//! and would stay green through a breaking change. These fixtures never change,
//! so the regression lands here.
//!
//! Why it has to be caught by a test at all: `itemfile::scan` records a per-file
//! parse failure as a WARNING and SKIPS that file - the load still succeeds. A
//! format break therefore reaches the user as notes silently missing from the
//! list, never as a crash or an error dialog.
//!
//! If a change to `store/` breaks one of these, the fix is a parser that still
//! accepts the old shape - NOT an edited fixture. The only legitimate edit to
//! `tests/fixtures/v1_0_0/` is ADDING a case.

use std::path::{Path, PathBuf};

use notes_app_lib::models::{Item, Kind, Priority, Status};
use notes_app_lib::store::itemfile;
use notes_app_lib::store::promptfile;

const NOTE_ID: &str = "11111111-1111-1111-1111-111111111111";
const TASK_ID: &str = "22222222-2222-2222-2222-222222222222";
const LEGACY_ID: &str = "33333333-3333-3333-3333-333333333333";
const FUTURE_ID: &str = "44444444-4444-4444-4444-444444444444";

const PROMPT_A: &str = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PROMPT_B: &str = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const VERSION_C: &str = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const VERSION_D: &str = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const VERSION_E: &str = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("v1_0_0")
}

fn items_dir() -> PathBuf {
    fixtures().join("items")
}

fn prompts_dir() -> PathBuf {
    fixtures().join("prompts")
}

fn read(relative: &str) -> String {
    let path = fixtures().join(relative);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("fixture {} unreadable: {e}", path.display()))
}

fn find<'a>(items: &'a [Item], id: &str) -> &'a Item {
    items
        .iter()
        .find(|i| i.id == id)
        .unwrap_or_else(|| panic!("fixture item {id} did not survive the scan"))
}

fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).expect("fixture dir must exist").flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files(&path, out);
        } else {
            out.push(path);
        }
    }
}

#[test]
fn fixture_files_are_lf_only() {
    // The fixtures are byte-exact goldens, so a CRLF rewrite on checkout would
    // break the round-trip assertions below in a way that looks like a code
    // regression. `tests/fixtures/.gitattributes` pins `* -text` to stop git
    // touching them; this asserts that guard is actually in force.
    let mut files = Vec::new();
    collect_files(&fixtures(), &mut files);
    assert!(!files.is_empty(), "fixture tree must not be empty");
    for path in files {
        let bytes = std::fs::read(&path).unwrap();
        assert!(
            !bytes.contains(&b'\r'),
            "{} contains CR - git rewrote the goldens; check tests/fixtures/.gitattributes",
            path.display()
        );
    }
}

#[test]
fn every_v1_item_fixture_still_scans_without_error() {
    // The headline assertion: today's parser reads a directory written by an
    // earlier build with NOTHING skipped. A non-empty `errors` here is exactly
    // the silent-data-loss failure mode described in the module docs.
    let outcome = itemfile::scan(&items_dir());
    assert!(
        outcome.errors.is_empty(),
        "v1.0.0 item files must still parse; skipped: {:?}",
        outcome.errors
    );
    assert_eq!(outcome.items.len(), 4, "every fixture item must be imported");
}

#[test]
fn v1_note_fixture_parses_field_for_field() {
    let outcome = itemfile::scan(&items_dir());
    let note = find(&outcome.items, NOTE_ID);

    assert_eq!(note.kind, Kind::Note);
    assert!(note.title.starts_with("Release \"v1\" notes"), "quote-escaping must survive");
    assert_eq!(note.tags.0, vec!["work".to_string(), "release".to_string()]);
    assert_eq!(note.created_at, "2026-07-14T09:30:00.000+00:00");
    assert_eq!(note.updated_at, "2026-07-14T10:15:00.000+00:00");
    assert!(!note.pinned);
    assert!(!note.archived);
    assert_eq!(note.schema_version, "1.0.0");
    // The kind gate: a note never gains task metadata on import.
    assert_eq!(note.status, None);
    assert_eq!(note.priority, None);
    assert_eq!(note.due_at, None);
    // The body is raw text recovered byte-for-byte, blank line included.
    assert_eq!(note.body, "First paragraph.\n\nSecond paragraph after a blank line.\n");
}

#[test]
fn v1_task_fixture_parses_every_optional_field() {
    let outcome = itemfile::scan(&items_dir());
    let task = find(&outcome.items, TASK_ID);

    assert_eq!(task.kind, Kind::Task);
    assert_eq!(task.title, "Ship the installer");
    assert_eq!(task.status, Some(Status::Doing));
    assert_eq!(task.priority, Some(Priority::High));
    assert_eq!(task.due_at.as_deref(), Some("2026-07-20T00:00:00.000+00:00"));
    assert_eq!(
        task.jira_url.as_deref(),
        Some("https://example.atlassian.net/browse/ABC-1")
    );
    assert!(task.pinned);
    assert!(!task.archived);
    assert_eq!(task.tags.0, vec!["release".to_string()]);
    assert_eq!(task.schema_version, "1.0.0");
    assert_eq!(task.body, "Cut the NSIS bundle and smoke-test on a clean VM.\n");
}

#[test]
fn v1_item_without_a_schema_version_marker_defaults_to_1_0_0() {
    // The back-fill contract: files written before the marker existed are
    // already 1.0.0-shaped, so an absent marker is a default, never an error.
    let outcome = itemfile::scan(&items_dir());
    let legacy = find(&outcome.items, LEGACY_ID);

    assert_eq!(legacy.schema_version, "1.0.0");
    assert_eq!(legacy.title, "Pre-marker legacy note");
    assert!(legacy.archived, "an archived legacy item stays archived");
    assert!(legacy.tags.0.is_empty(), "`tags: []` is the empty-tag form");
    assert_eq!(legacy.body, "Written before schema_version existed.\n");
}

#[test]
fn v1_item_with_unknown_future_keys_ignores_them_and_defaults_task_fields() {
    // The forward-compatibility half of the rule: a file written by a NEWER
    // build that added scalar keys must still import here, with the unknown keys
    // ignored rather than rejected. Adding a strict unknown-key check would turn
    // every additive change into a break - this test is what forbids it.
    let outcome = itemfile::scan(&items_dir());
    let future = find(&outcome.items, FUTURE_ID);

    assert_eq!(future.kind, Kind::Task);
    assert_eq!(future.title, "Task written by a newer build");
    // Omitted task metadata defaults exactly as `create()` would.
    assert_eq!(future.status, Some(Status::Todo));
    assert_eq!(future.priority, Some(Priority::Normal));
    assert_eq!(future.due_at, None);
    assert_eq!(future.body, "Body from a build that added fields this one does not know.\n");
}

#[test]
fn current_shape_item_fixtures_reserialize_byte_identically() {
    // For fixtures already in the current shape, parse then serialize must
    // reproduce the file byte-for-byte: the idempotent-export property, pinned
    // against bytes on disk rather than against whatever the current code
    // emits. Any key reorder, rename, or added field fails here.
    for name in [
        "items/11111111-1111-1111-1111-111111111111.md",
        "items/22222222-2222-2222-2222-222222222222.md",
    ] {
        let bytes = read(name);
        let parsed = itemfile::parse(&bytes).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(
            itemfile::serialize(&parsed),
            bytes,
            "{name} must re-export byte-identically or it is a spurious git diff"
        );
    }
}

#[test]
fn every_v1_prompt_fixture_still_scans_with_full_version_history() {
    let outcome = promptfile::scan(&prompts_dir());
    assert!(
        outcome.errors.is_empty(),
        "v1.0.0 prompt files must still parse; skipped: {:?}",
        outcome.errors
    );
    assert_eq!(outcome.prompts.len(), 2, "both fixture prompts must be imported");

    let a = outcome
        .prompts
        .iter()
        .find(|p| p.prompt.id == PROMPT_A)
        .expect("prompt A survived the scan");
    assert!(a.prompt.reusable);
    assert_eq!(a.prompt.created_at, "2026-07-14T09:00:00.000+00:00");
    assert_eq!(a.prompt.schema_version, "1.0.0");

    let mut ids: Vec<&str> = a.versions.iter().map(|v| v.id.as_str()).collect();
    ids.sort();
    assert_eq!(ids, vec![VERSION_C, VERSION_D], "both versions preserved");

    let manual = a.versions.iter().find(|v| v.id == VERSION_C).unwrap();
    assert_eq!(manual.source, "manual");
    assert_eq!(manual.title, "First draft");
    assert_eq!(manual.body, "Summarize the text below.\n");
    // `prompt_id` is derived from the parent directory, never stored in the file.
    assert_eq!(manual.prompt_id, PROMPT_A);

    let enhanced = a.versions.iter().find(|v| v.id == VERSION_D).unwrap();
    assert_eq!(enhanced.source, "aiEnhanced", "aiEnhanced must survive normalization");
    assert_eq!(enhanced.title, "Enhanced draft");
}

#[test]
fn v1_prompt_head_without_a_schema_version_marker_defaults_to_1_0_0() {
    let outcome = promptfile::scan(&prompts_dir());
    let b = outcome
        .prompts
        .iter()
        .find(|p| p.prompt.id == PROMPT_B)
        .expect("legacy prompt B survived the scan");

    assert_eq!(b.prompt.schema_version, "1.0.0");
    assert!(!b.prompt.reusable);
    assert_eq!(b.versions.len(), 1);
    assert_eq!(b.versions[0].id, VERSION_E);
    assert_eq!(b.versions[0].body, "Rewrite the text below to be shorter.\n");
}

#[test]
fn current_shape_prompt_fixtures_reserialize_byte_identically() {
    let head_name = "prompts/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/prompt.md";
    let head_bytes = read(head_name);
    let head = promptfile::parse_prompt(&head_bytes).unwrap_or_else(|e| panic!("{head_name}: {e}"));
    assert_eq!(promptfile::serialize_prompt(&head), head_bytes, "prompt head must be byte-stable");

    for name in [
        "prompts/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/cccccccc-cccc-cccc-cccc-cccccccccccc.md",
        "prompts/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/dddddddd-dddd-dddd-dddd-dddddddddddd.md",
    ] {
        let bytes = read(name);
        let version =
            promptfile::parse_version(&bytes, PROMPT_A).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(
            promptfile::serialize_version(&version),
            bytes,
            "{name} must re-export byte-identically"
        );
    }
}
