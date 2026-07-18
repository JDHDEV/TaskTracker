//! Canonical item-file format (plan.6 step 16): one `<uuid>.md` per item, with
//! a small YAML-shaped frontmatter block followed by the raw body. This is the
//! git-mergeable source of truth; `index.db` is rebuilt from it.
//!
//! Design goals that drive every choice here:
//! - **Byte-deterministic output.** A fixed key order, LF line endings, and the
//!   fixed-millisecond RFC 3339 timestamps `now_rfc3339` already mints mean
//!   `serialize` is a pure function of the `Item`, so re-exporting an unchanged
//!   item never produces a spurious git diff (the idempotent-export test).
//! - **A restricted reader, not a general YAML engine.** We parse only our own
//!   fixed field set with a line-oriented reader — no anchors, aliases, or deep
//!   nesting — so there is no YAML alias-bomb / billion-laughs DoS surface, and
//!   a per-file size cap plus total absence of `unwrap`/`expect` on file content
//!   keep it panic-free (Section 4.7). The output is still ordinary YAML
//!   frontmatter other tools can read.
//! - **git-merge honesty.** Disjoint field edits on two branches land on
//!   different lines and 3-way-merge cleanly; a same-field edit conflicts, and a
//!   file carrying git conflict markers is refused per-file (the filename is
//!   reported) rather than silently importing half of it.
//!
//! `project_id` is never written: an item's owner is the store (directory) it
//! lives in (Decision 4). Secrets are never written: the item carries none, and
//! a test asserts the serialized bytes hold no token material.

use std::path::Path;

use sqlx::types::Json;

use crate::models::{Item, Kind, Priority, Status};

/// A per-file cap. `scan` skips (and reports) any file larger than this before
/// reading it, so a hostile multi-gigabyte "item" can't be slurped into memory.
/// Generous for a single note/task.
pub const MAX_ITEM_FILE_BYTES: u64 = 4 * 1024 * 1024;

/// Why a single file could not be turned into an `Item`. Carried out of `scan`
/// alongside the filename so a rebuild can report per-file partial success
/// (plan.6 step 18) instead of failing the whole load.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ItemFileError {
    /// The file (or its frontmatter) is not the shape we write.
    Malformed(String),
    /// The file carries git conflict markers — a human must resolve it first.
    ConflictMarkers,
    /// The file exceeds `MAX_ITEM_FILE_BYTES`.
    TooLarge,
    /// The `id` is missing or not a UUID (so it can't name a file safely).
    BadId,
}

impl std::fmt::Display for ItemFileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ItemFileError::Malformed(what) => write!(f, "not a valid item file ({what})"),
            ItemFileError::ConflictMarkers => write!(f, "contains unresolved git conflict markers"),
            ItemFileError::TooLarge => write!(f, "item file is too large"),
            ItemFileError::BadId => write!(f, "item id is missing or malformed"),
        }
    }
}

/// The canonical file name for an item: `<id>.md`, and ONLY that. The id is a
/// v4 UUID we mint, so this both derives the name purely from the id (never from
/// a title/tag — Section 4.7) and, on import, rejects anything not UUID-shaped so
/// a crafted `id` can't escape the items directory (`..`, separators, `:` ADS,
/// `CON`/`NUL` reserved names all fail the UUID check).
pub fn file_name(id: &str) -> Result<String, ItemFileError> {
    if is_uuid(id) {
        Ok(format!("{id}.md"))
    } else {
        Err(ItemFileError::BadId)
    }
}

/// A 8-4-4-4-12 hex UUID (any version/variant). We only ever mint v4, but any
/// canonical UUID is a safe, separator-free file stem.
fn is_uuid(s: &str) -> bool {
    let groups = [8usize, 4, 4, 4, 12];
    let parts: Vec<&str> = s.split('-').collect();
    parts.len() == groups.len()
        && parts
            .iter()
            .zip(groups)
            .all(|(p, n)| p.len() == n && p.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// Serialize an item to its canonical file bytes. Pure and deterministic: fixed
/// key order, LF endings, task-only keys omitted for notes, optional keys omitted
/// when empty. The body follows the closing fence verbatim (it is raw text, never
/// escaped), so `parse` recovers it byte-for-byte.
pub fn serialize(item: &Item) -> String {
    let mut out = String::new();
    out.push_str("---\n");
    line(&mut out, "id", item.id.as_str());
    line(&mut out, "kind", kind_str(item.kind));
    quoted_line(&mut out, "title", &item.title);
    // Task-only metadata: present for tasks, omitted entirely for notes so a
    // note file never carries a status/priority it can't have.
    if item.kind == Kind::Task {
        if let Some(status) = item.status {
            line(&mut out, "status", status_str(status));
        }
        if let Some(priority) = item.priority {
            line(&mut out, "priority", priority_str(priority));
        }
    }
    line(&mut out, "pinned", bool_str(item.pinned));
    line(&mut out, "archived", bool_str(item.archived));
    tags_block(&mut out, &item.tags.0);
    if item.kind == Kind::Task {
        if let Some(due) = &item.due_at {
            line(&mut out, "due_at", due);
        }
    }
    if let Some(url) = &item.jira_url {
        quoted_line(&mut out, "jira_url", url);
    }
    line(&mut out, "created_at", &item.created_at);
    line(&mut out, "updated_at", &item.updated_at);
    out.push_str("---\n");
    out.push_str(&item.body);
    out
}

/// Parse canonical file bytes back into an `Item`. Enforces the kind gate on
/// import (a note drops any status/priority/due_at; a task defaults them) so a
/// hand-edited or merged file can never introduce an illegal note+status shape.
/// `project_id` is always `None` — the store stamps ownership.
pub fn parse(text: &str) -> Result<Item, ItemFileError> {
    if has_conflict_markers(text) {
        return Err(ItemFileError::ConflictMarkers);
    }

    let after_open = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))
        .ok_or_else(|| ItemFileError::Malformed("missing opening --- fence".into()))?;

    // Find the closing fence: the first whole line that is exactly "---". The
    // body is everything after that line's newline, preserved verbatim.
    let mut fm_end = None;
    let mut body_start = None;
    let mut offset = 0usize;
    for raw_line in after_open.split_inclusive('\n') {
        let content = raw_line.strip_suffix('\n').unwrap_or(raw_line);
        let content = content.strip_suffix('\r').unwrap_or(content);
        if content == "---" {
            fm_end = Some(offset);
            body_start = Some(offset + raw_line.len());
            break;
        }
        offset += raw_line.len();
    }
    let fm_end = fm_end.ok_or_else(|| ItemFileError::Malformed("missing closing --- fence".into()))?;
    let frontmatter = &after_open[..fm_end];
    let body = &after_open[body_start.unwrap_or(after_open.len())..];

    // Collect scalar fields; `tags` is a block handled inline.
    let lines: Vec<&str> = frontmatter.lines().collect();
    let mut fields: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut tags: Vec<String> = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let raw = lines[i];
        if raw.trim().is_empty() {
            i += 1;
            continue;
        }
        let (key, value) = split_field(raw)
            .ok_or_else(|| ItemFileError::Malformed(format!("bad frontmatter line: {raw}")))?;
        if key == "tags" {
            if value == "[]" || value.is_empty() {
                // Block form: consume the following "  - <quoted>" entries.
                let mut j = i + 1;
                while j < lines.len() {
                    let entry = lines[j];
                    let trimmed = entry.trim_start();
                    if let Some(rest) = trimmed.strip_prefix("- ") {
                        tags.push(unquote(rest.trim())?);
                        j += 1;
                    } else {
                        break;
                    }
                }
                i = j;
                continue;
            } else {
                return Err(ItemFileError::Malformed("unexpected inline tags value".into()));
            }
        }
        fields.insert(key.to_string(), value.to_string());
        i += 1;
    }

    let get = |k: &str| -> Result<&String, ItemFileError> {
        fields
            .get(k)
            .ok_or_else(|| ItemFileError::Malformed(format!("missing {k}")))
    };

    let id = get("id")?.clone();
    if !is_uuid(&id) {
        return Err(ItemFileError::BadId);
    }
    let kind = parse_kind(get("kind")?)?;
    let title = fields
        .get("title")
        .map(|v| unquote(v))
        .transpose()?
        .ok_or_else(|| ItemFileError::Malformed("missing title".into()))?;

    // Kind gate on import (mirrors `SqliteRepository::create`): notes never carry
    // status/priority/due_at; tasks always do (defaulting like create()).
    let (status, priority, due_at) = match kind {
        Kind::Note => (None, None, None),
        Kind::Task => {
            let status = match fields.get("status") {
                Some(v) => Some(parse_status(v)?),
                None => Some(Status::Todo),
            };
            let priority = match fields.get("priority") {
                Some(v) => Some(parse_priority(v)?),
                None => Some(Priority::Normal),
            };
            let due_at = fields.get("due_at").cloned().filter(|s| !s.is_empty());
            (status, priority, due_at)
        }
    };

    let pinned = parse_bool(get("pinned")?)?;
    let archived = parse_bool(get("archived")?)?;
    let jira_url = fields.get("jira_url").map(|v| unquote(v)).transpose()?;
    let created_at = get("created_at")?.clone();
    let updated_at = get("updated_at")?.clone();

    Ok(Item {
        id,
        kind,
        title,
        body: body.to_string(),
        status,
        priority,
        due_at,
        tags: Json(tags),
        created_at,
        updated_at,
        archived,
        pinned,
        project_id: None,
        jira_url,
    })
}

/// Read a file into a string, reading AT MOST `MAX_ITEM_FILE_BYTES + 1` bytes so
/// a file grown past the cap since its `metadata` check can't be slurped whole
/// (a TOCTOU guard). `Ok(None)` means it exceeded the cap; `Ok(Some(_))` is the
/// content.
fn read_capped(path: &Path) -> std::io::Result<Option<String>> {
    use std::io::Read;
    let file = std::fs::File::open(path)?;
    let mut buf = String::new();
    file.take(MAX_ITEM_FILE_BYTES + 1).read_to_string(&mut buf)?;
    if buf.len() as u64 > MAX_ITEM_FILE_BYTES {
        Ok(None)
    } else {
        Ok(Some(buf))
    }
}

/// Write an item to `<items_dir>/<id>.md` atomically (write a temp file next to
/// the target, then rename over it) so a crash mid-write never leaves a
/// half-written canonical file that a later scan would reject. This protects
/// against a PROCESS crash (the rename is atomic); it does not fsync, so it does
/// not guarantee durability across an OS crash / power loss — acceptable for a
/// local notes store whose index is rebuilt from these files on the next load.
pub fn write_item(items_dir: &Path, item: &Item) -> Result<(), ItemFileError> {
    let name = file_name(&item.id)?;
    let target = items_dir.join(&name);
    let tmp = items_dir.join(format!(".{name}.tmp"));
    let bytes = serialize(item);
    std::fs::write(&tmp, bytes.as_bytes())
        .map_err(|e| ItemFileError::Malformed(format!("write failed: {}", e.kind())))?;
    std::fs::rename(&tmp, &target)
        .map_err(|e| ItemFileError::Malformed(format!("rename failed: {}", e.kind())))?;
    Ok(())
}

/// Remove an item's file. A missing file is success (the canonical store already
/// lacks it), so delete stays idempotent.
pub fn remove_item(items_dir: &Path, id: &str) -> Result<(), ItemFileError> {
    let name = file_name(id)?;
    match std::fs::remove_file(items_dir.join(&name)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(ItemFileError::Malformed(format!("delete failed: {}", e.kind()))),
    }
}

/// The result of scanning an items directory: every file that parsed, plus a
/// `(filename, reason)` for every file that did not — so a rebuild imports the
/// good files and reports the bad ones instead of aborting (plan.6 step 18).
pub struct ScanOutcome {
    pub items: Vec<Item>,
    pub errors: Vec<(String, ItemFileError)>,
}

/// Scan every `*.md` in `items_dir`, parsing each independently. Never fails as
/// a whole: a missing directory yields an empty scan; a bad/oversized/conflicted
/// file becomes an entry in `errors`. Results are sorted by filename so a rebuild
/// is deterministic.
pub fn scan(items_dir: &Path) -> ScanOutcome {
    let mut items = Vec::new();
    let mut errors = Vec::new();

    let entries = match std::fs::read_dir(items_dir) {
        Ok(e) => e,
        Err(_) => return ScanOutcome { items, errors },
    };

    let mut files: Vec<std::path::PathBuf> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("md"))
        .collect();
    files.sort();

    for path in files {
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("<file>")
            .to_string();
        // Fast reject for a statically oversized file, then a BOUNDED read so a
        // file grown past the cap between the stat and the read (TOCTOU) still
        // can't be slurped whole — at most MAX+1 bytes are ever read.
        match std::fs::metadata(&path) {
            Ok(meta) if meta.len() > MAX_ITEM_FILE_BYTES => {
                errors.push((name, ItemFileError::TooLarge));
                continue;
            }
            Ok(_) => {}
            Err(e) => {
                errors.push((name, ItemFileError::Malformed(format!("stat failed: {}", e.kind()))));
                continue;
            }
        }
        match read_capped(&path) {
            Ok(Some(text)) => match parse(&text) {
                Ok(item) => items.push(item),
                Err(e) => errors.push((name, e)),
            },
            Ok(None) => errors.push((name, ItemFileError::TooLarge)),
            Err(e) => errors.push((name, ItemFileError::Malformed(format!("read failed: {}", e.kind())))),
        }
    }

    ScanOutcome { items, errors }
}

// --- Conflict-marker detection ---------------------------------------------

/// True if the text carries git merge conflict markers. Every conflict hunk git
/// writes opens a line with `<<<<<<<` AND closes one with `>>>>>>>` (both merge
/// and diff3 styles), so we require BOTH to appear before rejecting — a note
/// that merely contains a lone `<<<<<<<` or `>>>>>>>` line (a pasted snippet, a
/// row of equals signs) is not a conflict and must still round-trip. This keeps
/// a single such line from permanently blocking a whole project's import while
/// still catching real, resolvable conflicts.
fn has_conflict_markers(text: &str) -> bool {
    let mut opened = false;
    let mut closed = false;
    for line in text.lines() {
        if line.starts_with("<<<<<<<") {
            opened = true;
        } else if line.starts_with(">>>>>>>") {
            closed = true;
        }
    }
    opened && closed
}

// --- Frontmatter primitives -------------------------------------------------

fn line(out: &mut String, key: &str, value: &str) {
    out.push_str(key);
    out.push_str(": ");
    out.push_str(value);
    out.push('\n');
}

fn quoted_line(out: &mut String, key: &str, value: &str) {
    out.push_str(key);
    out.push_str(": ");
    out.push_str(&quote(value));
    out.push('\n');
}

fn tags_block(out: &mut String, tags: &[String]) {
    if tags.is_empty() {
        out.push_str("tags: []\n");
        return;
    }
    out.push_str("tags:\n");
    for tag in tags {
        out.push_str("  - ");
        out.push_str(&quote(tag));
        out.push('\n');
    }
}

/// Split `key: value` on the FIRST ": ". The key is a fixed bareword with no
/// spaces or colons, so internal colons of an RFC 3339 timestamp value stay in
/// the value. A key line with no value (e.g. `tags:`) yields an empty value.
fn split_field(raw: &str) -> Option<(&str, &str)> {
    if let Some((k, v)) = raw.split_once(": ") {
        Some((k.trim(), v))
    } else {
        let k = raw.strip_suffix(':')?;
        Some((k.trim(), ""))
    }
}

/// Double-quote a scalar and escape what would break a single line. Applied to
/// free-text values (title, tags, jira_url); enum/bool/timestamp values are
/// bareword-safe and written unquoted.
fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

fn unquote(s: &str) -> Result<String, ItemFileError> {
    let bytes = s.as_bytes();
    if bytes.len() < 2 || bytes[0] != b'"' || bytes[bytes.len() - 1] != b'"' {
        return Err(ItemFileError::Malformed(format!("unquoted value: {s}")));
    }
    let inner = &s[1..s.len() - 1];
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('\\') => out.push('\\'),
                Some('"') => out.push('"'),
                Some('n') => out.push('\n'),
                Some('r') => out.push('\r'),
                Some('t') => out.push('\t'),
                Some(other) => out.push(other),
                None => return Err(ItemFileError::Malformed("dangling escape".into())),
            }
        } else {
            out.push(c);
        }
    }
    Ok(out)
}

fn kind_str(kind: Kind) -> &'static str {
    match kind {
        Kind::Note => "note",
        Kind::Task => "task",
    }
}

fn parse_kind(s: &str) -> Result<Kind, ItemFileError> {
    match s {
        "note" => Ok(Kind::Note),
        "task" => Ok(Kind::Task),
        other => Err(ItemFileError::Malformed(format!("bad kind: {other}"))),
    }
}

fn status_str(status: Status) -> &'static str {
    match status {
        Status::Todo => "todo",
        Status::Doing => "doing",
        Status::Done => "done",
    }
}

fn parse_status(s: &str) -> Result<Status, ItemFileError> {
    match s {
        "todo" => Ok(Status::Todo),
        "doing" => Ok(Status::Doing),
        "done" => Ok(Status::Done),
        other => Err(ItemFileError::Malformed(format!("bad status: {other}"))),
    }
}

fn priority_str(priority: Priority) -> &'static str {
    match priority {
        Priority::Low => "low",
        Priority::Normal => "normal",
        Priority::High => "high",
    }
}

fn parse_priority(s: &str) -> Result<Priority, ItemFileError> {
    match s {
        "low" => Ok(Priority::Low),
        "normal" => Ok(Priority::Normal),
        "high" => Ok(Priority::High),
        other => Err(ItemFileError::Malformed(format!("bad priority: {other}"))),
    }
}

fn bool_str(b: bool) -> &'static str {
    if b {
        "true"
    } else {
        "false"
    }
}

fn parse_bool(s: &str) -> Result<bool, ItemFileError> {
    match s {
        "true" => Ok(true),
        "false" => Ok(false),
        other => Err(ItemFileError::Malformed(format!("bad bool: {other}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task() -> Item {
        Item {
            id: "550e8400-e29b-41d4-a716-446655440000".into(),
            kind: Kind::Task,
            title: "Fix the login redirect".into(),
            body: "Steps:\n1. reproduce\n2. patch\n".into(),
            status: Some(Status::Doing),
            priority: Some(Priority::High),
            due_at: Some("2026-07-20T00:00:00.000+00:00".into()),
            tags: Json(vec!["auth".into(), "backend".into()]),
            created_at: "2026-07-17T10:00:00.000+00:00".into(),
            updated_at: "2026-07-17T11:30:00.000+00:00".into(),
            archived: false,
            pinned: true,
            project_id: None,
            jira_url: Some("https://x.atlassian.net/browse/ABC-1".into()),
        }
    }

    fn note() -> Item {
        Item {
            id: "11111111-2222-3333-4444-555555555555".into(),
            kind: Kind::Note,
            title: "A plain note".into(),
            body: "body text".into(),
            status: None,
            priority: None,
            due_at: None,
            tags: Json(vec![]),
            created_at: "2026-07-17T10:00:00.000+00:00".into(),
            updated_at: "2026-07-17T10:00:00.000+00:00".into(),
            archived: false,
            pinned: false,
            project_id: None,
            jira_url: None,
        }
    }

    fn assert_item_eq(a: &Item, b: &Item) {
        assert_eq!(a.id, b.id);
        assert_eq!(a.kind, b.kind);
        assert_eq!(a.title, b.title);
        assert_eq!(a.body, b.body);
        assert_eq!(a.status, b.status);
        assert_eq!(a.priority, b.priority);
        assert_eq!(a.due_at, b.due_at);
        assert_eq!(a.tags.0, b.tags.0);
        assert_eq!(a.created_at, b.created_at);
        assert_eq!(a.updated_at, b.updated_at);
        assert_eq!(a.archived, b.archived);
        assert_eq!(a.pinned, b.pinned);
        assert_eq!(a.project_id, b.project_id);
        assert_eq!(a.jira_url, b.jira_url);
    }

    #[test]
    fn round_trip_task_preserves_every_field() {
        let original = task();
        let parsed = parse(&serialize(&original)).unwrap();
        assert_item_eq(&original, &parsed);
    }

    #[test]
    fn round_trip_note_has_no_task_fields() {
        let original = note();
        let text = serialize(&original);
        assert!(!text.contains("status:"), "a note file must not carry status");
        assert!(!text.contains("priority:"), "a note file must not carry priority");
        assert!(!text.contains("due_at:"), "a note file must not carry due_at");
        assert!(text.contains("tags: []"), "an empty tag list is written inline");
        let parsed = parse(&text).unwrap();
        assert_item_eq(&original, &parsed);
    }

    #[test]
    fn export_is_byte_identical_after_a_round_trip() {
        // The idempotent-export guarantee: re-serializing a parsed item yields
        // the exact same bytes, so an unchanged item never shows a git diff.
        for original in [task(), note()] {
            let once = serialize(&original);
            let twice = serialize(&parse(&once).unwrap());
            assert_eq!(once, twice, "serialize∘parse∘serialize must be a fixed point");
        }
    }

    #[test]
    fn kind_gating_on_import_drops_status_on_a_note() {
        // A hand-edited/merged note file that illegally carries a task status
        // must import as a clean note, never a note-with-status.
        let text = "---\nid: 11111111-2222-3333-4444-555555555555\nkind: note\n\
                    title: \"sneaky\"\nstatus: doing\npriority: high\npinned: false\n\
                    archived: false\ntags: []\ndue_at: 2026-07-20T00:00:00.000+00:00\n\
                    created_at: 2026-07-17T10:00:00.000+00:00\n\
                    updated_at: 2026-07-17T10:00:00.000+00:00\n---\nbody";
        let parsed = parse(text).unwrap();
        assert_eq!(parsed.kind, Kind::Note);
        assert_eq!(parsed.status, None, "a note must never keep an imported status");
        assert_eq!(parsed.priority, None);
        assert_eq!(parsed.due_at, None);
    }

    #[test]
    fn kind_gating_on_import_defaults_a_tasks_missing_status_and_priority() {
        let text = "---\nid: 550e8400-e29b-41d4-a716-446655440000\nkind: task\n\
                    title: \"bare task\"\npinned: false\narchived: false\ntags: []\n\
                    created_at: 2026-07-17T10:00:00.000+00:00\n\
                    updated_at: 2026-07-17T10:00:00.000+00:00\n---\n";
        let parsed = parse(text).unwrap();
        assert_eq!(parsed.status, Some(Status::Todo));
        assert_eq!(parsed.priority, Some(Priority::Normal));
    }

    #[test]
    fn titles_with_quotes_backslashes_and_colons_round_trip() {
        let mut it = note();
        it.title = r#"weird: "quoted" back\slash — value: 2"#.into();
        let parsed = parse(&serialize(&it)).unwrap();
        assert_eq!(parsed.title, it.title);
    }

    #[test]
    fn body_is_preserved_verbatim_including_a_frontmatter_lookalike() {
        let mut it = note();
        // A body that itself contains a "---" line and "key: value" text must not
        // confuse the parser — only whole "---" lines fence, and the body starts
        // after the FIRST closing fence.
        it.body = "intro\n---\nlooks: like frontmatter\nbut is body\n".into();
        let parsed = parse(&serialize(&it)).unwrap();
        assert_eq!(parsed.body, it.body);
    }

    #[test]
    fn empty_body_round_trips() {
        let mut it = note();
        it.body = String::new();
        let parsed = parse(&serialize(&it)).unwrap();
        assert_eq!(parsed.body, "");
    }

    #[test]
    fn conflict_markers_are_refused() {
        let text = "---\nid: 11111111-2222-3333-4444-555555555555\nkind: note\n\
                    title: \"x\"\n<<<<<<< HEAD\npinned: false\n=======\npinned: true\n\
                    >>>>>>> branch\narchived: false\ntags: []\n\
                    created_at: 2026-07-17T10:00:00.000+00:00\n\
                    updated_at: 2026-07-17T10:00:00.000+00:00\n---\nbody";
        assert!(matches!(parse(text), Err(ItemFileError::ConflictMarkers)));
    }

    #[test]
    fn a_lone_equals_line_in_the_body_is_not_a_conflict() {
        let mut it = note();
        it.body = "setext heading\n=======\nmore".into();
        // No opener, so the equals line is ordinary body text and round-trips.
        let parsed = parse(&serialize(&it)).unwrap();
        assert_eq!(parsed.body, it.body);
    }

    #[test]
    fn a_lone_opening_marker_without_a_closer_is_not_a_conflict() {
        // A note body may legitimately contain a line starting with `<<<<<<<`
        // (a pasted snippet). Without a matching `>>>>>>>` it is not a conflict
        // and must round-trip — a single such line must never block a project.
        let mut it = note();
        it.body = "here is a diff marker line:\n<<<<<<< not really a conflict\ndone".into();
        let parsed = parse(&serialize(&it)).unwrap();
        assert_eq!(parsed.body, it.body);
    }

    #[test]
    fn file_name_is_derived_from_the_uuid_and_rejects_unsafe_ids() {
        assert_eq!(
            file_name("550e8400-e29b-41d4-a716-446655440000").unwrap(),
            "550e8400-e29b-41d4-a716-446655440000.md"
        );
        for bad in ["../escape", "CON", "a/b", "a:b", "not-a-uuid", ""] {
            assert_eq!(file_name(bad), Err(ItemFileError::BadId), "must reject {bad:?}");
        }
    }

    #[test]
    fn parse_rejects_a_missing_fence_and_a_non_uuid_id() {
        assert!(matches!(parse("no fence here"), Err(ItemFileError::Malformed(_))));
        let text = "---\nid: not-a-uuid\nkind: note\ntitle: \"x\"\npinned: false\n\
                    archived: false\ntags: []\ncreated_at: t\nupdated_at: t\n---\n";
        assert!(matches!(parse(text), Err(ItemFileError::BadId)));
    }

    #[test]
    fn serialized_bytes_carry_no_secret_material() {
        // Items never hold keyring material; assert the format has no field that
        // could carry a token (plan.6 step 18 "no keyring material in any file").
        let text = serialize(&task());
        for forbidden in ["token", "apikey", "api_key", "secret", "password", "authorization"] {
            assert!(
                !text.to_lowercase().contains(forbidden),
                "item file must never contain {forbidden}"
            );
        }
    }
}
