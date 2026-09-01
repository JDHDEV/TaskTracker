//! Draft backups (plan.15): one app-private file per unsaved editor buffer,
//! `<app_data_dir>\drafts\<draftId>.md` — restricted `key: value` frontmatter
//! plus the VERBATIM body, so the one irreplaceable thing stays human-readable
//! in Notepad even if the app ever fails to parse its own draft.
//!
//! This directory is explicitly NOT a compatibility surface (plan.15 D1, same
//! status as `index.db`): drafts are disposable snapshots, deleted on every
//! save/discard/delete/unload/destroy, GC'd by TTL and count. The parser is a
//! separate restricted reader — it never extends `itemfile`'s field set, and a
//! draft can never land in `items/` or the FTS index (§4.7).
//!
//! Hardening is copied from `scratchfile.rs` (the vetted template — NOT
//! `itemfile::write_item`, which skips symlink checks): symlink refusal on both
//! the target and the temp path, a write-side size cap before touching disk, a
//! bounded TOCTOU-safe read, non-lossy UTF-8 (a lossy restore + Save would
//! pepper the real note with U+FFFD), temp cleanup on rename failure, and an
//! error enum carrying kinds only — never paths. ONE deliberate divergence
//! (plan.15 D9): `File::sync_all()` before the rename — crash survival is this
//! feature's whole promise, so unlike every other writer it fsyncs.

use std::path::Path;

use crate::models::{Draft, DraftSurface, Kind, Priority, Status};

use super::itemfile::{is_uuid, quote, read_capped, unquote, MAX_ITEM_FILE_BYTES};

/// Per-draft size cap, enforced on write (before touching disk) AND on read.
pub const MAX_DRAFT_FILE_BYTES: u64 = MAX_ITEM_FILE_BYTES;

/// GC: drafts older than this (by `saved_at`) are dropped at startup.
pub const DRAFT_TTL_DAYS: i64 = 90;

/// GC: the store keeps at most this many parseable records; the oldest (by
/// `saved_at`) are evicted beyond it.
pub const MAX_DRAFT_RECORDS: usize = 50;

/// Why a draft read or write failed. Kinds only — no path, no message — so
/// nothing here can leak into a user-facing string by accident.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DraftFileError {
    /// The draftId is not a bare UUID (filenames derive ONLY from validated
    /// UUIDs — §4.2); rejected before any path join.
    BadId,
    /// The target or temp path is a symlink; refused on read and write.
    Symlink,
    /// The file (on read) or the serialized record (on write) exceeds the cap.
    TooLarge,
    /// The file is not valid UTF-8 (never read lossily).
    NotUtf8,
    /// The file is not the shape we write (bad fence/field/version) — a
    /// per-file skip on scan, never a boot failure.
    Malformed,
    /// Any other filesystem failure, by kind.
    Io(std::io::ErrorKind),
}

impl From<std::io::Error> for DraftFileError {
    fn from(e: std::io::Error) -> Self {
        match e.kind() {
            std::io::ErrorKind::InvalidData => DraftFileError::NotUtf8,
            kind => DraftFileError::Io(kind),
        }
    }
}

/// The canonical filename for a draft: `<draftId>.md`, and ONLY that. Rejects
/// anything not UUID-shaped so a crafted id can't escape the drafts directory
/// (`..`, separators, `:` ADS, reserved names all fail the UUID check).
pub fn file_name(draft_id: &str) -> Result<String, DraftFileError> {
    if is_uuid(draft_id) {
        Ok(format!("{draft_id}.md"))
    } else {
        Err(DraftFileError::BadId)
    }
}

/// The scan outcome: every draft that parsed, plus a warning line per file that
/// did not (named by file, kind only — no paths). Fail-soft: a corrupt file
/// never fails the scan as a whole.
#[derive(Debug, Default)]
pub struct DraftScan {
    pub drafts: Vec<Draft>,
    pub warnings: Vec<String>,
}

/// Write one draft atomically: temp file beside the target, `sync_all` (D9 —
/// the one writer that fsyncs), then rename; the temp is cleaned up on any
/// failure. Rejects a non-UUID `draftId` before any path join, an over-cap
/// serialized record before touching disk, and a symlink at the target or temp
/// path. Creates the drafts root on demand.
///
/// Empty-buffer convention (pinned): a NEVER-SAVED item/prompt draft
/// (`entityId == ""`) with no content has nothing to restore — the file is
/// removed instead of written, so "empty" has exactly one on-disk
/// representation. "Content" includes a non-default status/priority (a task
/// draft whose only edit is a status flip must still back up — post-review
/// C1; the defaults mirror the editor's own seeds, todo/normal). Two shapes
/// are ALWAYS written: a draft of a SAVED entity (clearing every field of a
/// real item is a genuine edit) and any SCRATCH draft (its entityId is always
/// "" and an emptied pad is a genuine edit — post-review W1).
pub fn write_draft(dir: &Path, draft: &Draft) -> Result<(), DraftFileError> {
    let name = file_name(&draft.draft_id)?; // BadId before any path join
    let default_status = matches!(draft.status, None | Some(Status::Todo));
    let default_priority = matches!(draft.priority, None | Some(Priority::Normal));
    if draft.surface != DraftSurface::Scratch
        && draft.entity_id.is_empty()
        && draft.title.is_empty()
        && draft.body.is_empty()
        && draft.tags.is_empty()
        && draft.due_at.is_empty()
        && draft.jira_url.is_empty()
        && default_status
        && default_priority
    {
        return remove_draft(dir, &draft.draft_id);
    }
    let bytes = serialize(draft);
    if bytes.len() as u64 > MAX_DRAFT_FILE_BYTES {
        return Err(DraftFileError::TooLarge);
    }
    std::fs::create_dir_all(dir)?;
    let target = dir.join(&name);
    let tmp = dir.join(format!(".{name}.tmp"));
    if is_symlink(&target)? || is_symlink(&tmp)? {
        return Err(DraftFileError::Symlink);
    }
    let written = (|| -> std::io::Result<()> {
        use std::io::Write;
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(bytes.as_bytes())?;
        // D9: flush to the platter before publishing the rename — the one
        // writer in the app that fsyncs, because crash survival is the promise.
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, &target)
    })();
    if let Err(e) = written {
        // A failed write or rename must not leave buffer text behind in a temp
        // file the sweeps don't know about.
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(())
}

/// Read one draft by id. `Ok(None)` when the file is absent; a symlink,
/// over-cap file, invalid UTF-8, or malformed record is a hard per-file error.
/// The bounded read re-checks the cap against a file grown since the metadata
/// check (TOCTOU), like `itemfile::read_capped`.
pub fn read_draft(dir: &Path, draft_id: &str) -> Result<Option<Draft>, DraftFileError> {
    let name = file_name(draft_id)?;
    let target = dir.join(&name);
    let meta = match std::fs::symlink_metadata(&target) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    if meta.is_symlink() {
        return Err(DraftFileError::Symlink);
    }
    // Size first (so an over-cap file cut mid-multibyte reports TooLarge, not
    // NotUtf8); `read_capped` then re-checks a file grown since (TOCTOU).
    if meta.len() > MAX_DRAFT_FILE_BYTES {
        return Err(DraftFileError::TooLarge);
    }
    let text = read_capped(&target)?.ok_or(DraftFileError::TooLarge)?;
    let draft = parse(&text)?;
    if draft.draft_id != draft_id {
        // A record copied to a foreign filename: refuse rather than return a
        // draft whose delete/sweep would target the wrong file.
        return Err(DraftFileError::Malformed);
    }
    Ok(Some(draft))
}

/// Scan the drafts root. A MISSING directory is an empty store (created on
/// demand by the first write); a directory that exists but cannot be read is a
/// hard error — never silently "zero drafts". Per-file failures (corrupt,
/// oversized, symlink, filename≠embedded draftId) become warnings, never a
/// scan failure. Results are sorted by filename for determinism.
pub fn list_drafts(dir: &Path) -> Result<DraftScan, DraftFileError> {
    let mut scan = DraftScan::default();
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        // A missing root is an empty store (created on demand by the first
        // write); any OTHER failure is a hard error — an unreadable directory
        // must never present as "zero drafts" (a later sweep or save could
        // then quietly diverge from what is really on disk).
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(scan),
        Err(e) => return Err(e.into()),
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
        let stem = name.strip_suffix(".md").unwrap_or(&name).to_string();
        if !is_uuid(&stem) {
            scan.warnings.push(format!("{name}: not a draft record name"));
            continue;
        }
        match read_draft(dir, &stem) {
            Ok(Some(draft)) => scan.drafts.push(draft),
            Ok(None) => {} // deleted between the dir listing and the read
            Err(e) => scan.warnings.push(format!("{name}: {}", describe(&e))),
        }
    }
    Ok(scan)
}

/// A short, fixed description per error kind — for scan warnings. Never a path
/// or an `io::Error` Display.
fn describe(e: &DraftFileError) -> &'static str {
    match e {
        DraftFileError::BadId => "bad draft id",
        DraftFileError::Symlink => "symlink refused",
        DraftFileError::TooLarge => "too large",
        DraftFileError::NotUtf8 => "not valid UTF-8",
        DraftFileError::Malformed => "not a valid draft record",
        DraftFileError::Io(_) => "unreadable",
    }
}

/// Remove a draft (and any leftover temp). Idempotent: a missing file is
/// success. The id is validated before any path join.
pub fn remove_draft(dir: &Path, draft_id: &str) -> Result<(), DraftFileError> {
    let name = file_name(draft_id)?;
    for path in [dir.join(&name), dir.join(format!(".{name}.tmp"))] {
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}

/// Startup GC: drop every parseable record whose `saved_at` is older than
/// `cutoff_rfc3339` (byte comparison — timestamps are fixed-precision RFC 3339),
/// then evict the oldest parseable records beyond `MAX_DRAFT_RECORDS`. Files
/// that don't parse are left alone (they might be a newer build's drafts; the
/// store is app-private and bounded in practice). Returns how many were
/// removed. A missing root is a no-op.
pub fn gc(dir: &Path, cutoff_rfc3339: &str) -> Result<usize, DraftFileError> {
    let scan = list_drafts(dir)?;
    let mut removed = 0usize;
    // Reap crash-leftover temp files first (post-review, security M1): a temp
    // exists only for the instant between create and rename, and gc's one
    // caller is startup — before any writer runs — so every `.<name>.md.tmp`
    // here is a crash leftover holding buffer text that the .md-only scan,
    // the sweeps, the TTL, and the cap can otherwise never reach. Worst case
    // it was newer than its .md sibling by one flush tick (≤5 s) — within the
    // feature's stated crash-loss bound. Best-effort per file.
    if let Ok(entries) = std::fs::read_dir(dir) {
        for path in entries.filter_map(|e| e.ok().map(|e| e.path())) {
            let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
            if name.starts_with('.') && name.ends_with(".md.tmp") {
                if std::fs::remove_file(&path).is_ok() {
                    removed += 1;
                }
            }
        }
    }
    let mut live: Vec<Draft> = Vec::new();
    for draft in scan.drafts {
        // Fixed-precision RFC 3339: byte order == chronological order.
        if draft.saved_at.as_str() < cutoff_rfc3339 {
            remove_draft(dir, &draft.draft_id)?;
            removed += 1;
        } else {
            live.push(draft);
        }
    }
    if live.len() > MAX_DRAFT_RECORDS {
        live.sort_by(|a, b| a.saved_at.cmp(&b.saved_at).then_with(|| a.draft_id.cmp(&b.draft_id)));
        let excess = live.len() - MAX_DRAFT_RECORDS;
        for draft in &live[..excess] {
            remove_draft(dir, &draft.draft_id)?;
            removed += 1;
        }
    }
    Ok(removed)
}

// --- Serialization (private) -------------------------------------------------

/// Serialize a draft to its file bytes: fixed key order, LF endings, enum
/// values bareword, free-text values quoted, optional enums omitted when None,
/// body verbatim after the closing fence. Always writes `v: 1` — the version
/// of THIS format, not whatever the struct happens to carry.
fn serialize(draft: &Draft) -> String {
    let mut out = String::new();
    out.push_str("---\n");
    line(&mut out, "v", "1");
    line(&mut out, "draft_id", &draft.draft_id);
    line(&mut out, "surface", surface_str(draft.surface));
    quoted_line(&mut out, "project_id", &draft.project_id);
    quoted_line(&mut out, "entity_id", &draft.entity_id);
    if let Some(kind) = draft.kind {
        line(&mut out, "kind", kind_str(kind));
    }
    quoted_line(&mut out, "base_updated_at", &draft.base_updated_at);
    quoted_line(&mut out, "base_hash", &draft.base_hash);
    quoted_line(&mut out, "saved_at", &draft.saved_at);
    quoted_line(&mut out, "title", &draft.title);
    if let Some(status) = draft.status {
        line(&mut out, "status", status_str(status));
    }
    if let Some(priority) = draft.priority {
        line(&mut out, "priority", priority_str(priority));
    }
    quoted_line(&mut out, "due_at", &draft.due_at);
    tags_block(&mut out, &draft.tags);
    quoted_line(&mut out, "jira_url", &draft.jira_url);
    out.push_str("---\n");
    out.push_str(&draft.body);
    out
}

/// Parse draft file bytes. Requires `v: 1` (an unknown version is `Malformed`
/// — skipped per-file on scan; the version gate runs before any TYPED field
/// parsing, though the line/tags-block reader necessarily runs first, so a
/// future format that also breaks line shape reports `Malformed` from there —
/// the same kind either way), a UUID `draft_id`, a known `surface`, and a
/// `saved_at`; every other field parse-defaults. Never panics on file content.
fn parse(text: &str) -> Result<Draft, DraftFileError> {
    let after_open = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))
        .ok_or(DraftFileError::Malformed)?;

    // The closing fence: the first whole line that is exactly "---". The body
    // is everything after that line's newline, preserved verbatim.
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
    let fm_end = fm_end.ok_or(DraftFileError::Malformed)?;
    let frontmatter = &after_open[..fm_end];
    let body = &after_open[body_start.unwrap_or(after_open.len())..];

    // Collect scalar fields; `tags` is a block handled inline (same restricted
    // reader shape as itemfile::parse, over OUR field set).
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
        let (key, value) = split_field(raw).ok_or(DraftFileError::Malformed)?;
        if key == "tags" {
            if value == "[]" || value.is_empty() {
                let mut j = i + 1;
                while j < lines.len() {
                    let trimmed = lines[j].trim_start();
                    if let Some(rest) = trimmed.strip_prefix("- ") {
                        tags.push(unquote(rest.trim()).map_err(|_| DraftFileError::Malformed)?);
                        j += 1;
                    } else {
                        break;
                    }
                }
                i = j;
                continue;
            }
            return Err(DraftFileError::Malformed);
        }
        fields.insert(key.to_string(), value.to_string());
        i += 1;
    }

    // Version gate BEFORE any field parsing.
    if fields.get("v").map(String::as_str) != Some("1") {
        return Err(DraftFileError::Malformed);
    }

    let draft_id = fields.get("draft_id").cloned().ok_or(DraftFileError::Malformed)?;
    if !is_uuid(&draft_id) {
        return Err(DraftFileError::Malformed);
    }
    let surface = parse_surface(fields.get("surface").ok_or(DraftFileError::Malformed)?)?;

    // Quoted optional string: absent → "".
    let q = |key: &str| -> Result<String, DraftFileError> {
        match fields.get(key) {
            Some(v) => unquote(v).map_err(|_| DraftFileError::Malformed),
            None => Ok(String::new()),
        }
    };
    let saved_at =
        unquote(fields.get("saved_at").ok_or(DraftFileError::Malformed)?).map_err(|_| DraftFileError::Malformed)?;

    let kind = fields.get("kind").map(|v| parse_kind(v)).transpose()?;
    let status = fields.get("status").map(|v| parse_status(v)).transpose()?;
    let priority = fields.get("priority").map(|v| parse_priority(v)).transpose()?;

    Ok(Draft {
        v: 1,
        draft_id,
        surface,
        project_id: q("project_id")?,
        entity_id: q("entity_id")?,
        kind,
        base_updated_at: q("base_updated_at")?,
        base_hash: q("base_hash")?,
        saved_at,
        title: q("title")?,
        status,
        priority,
        due_at: q("due_at")?,
        tags,
        jira_url: q("jira_url")?,
        body: body.to_string(),
    })
}

// Output primitives (local copies — see the note on `split_field` below).

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

/// `symlink_metadata` does not follow links, so this sees the link itself. A
/// missing path is simply "not a symlink".
fn is_symlink(path: &Path) -> Result<bool, DraftFileError> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) => Ok(meta.is_symlink()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
    }
}

// Local field primitives: a restricted line reader over OUR fixed field set —
// deliberately a copy, not an extension of `itemfile`'s (the draft format must
// never leak into the canonical item format or vice versa; `promptfile` sets
// the same precedent with its own local `split_field`).

fn split_field(raw: &str) -> Option<(&str, &str)> {
    if let Some((k, v)) = raw.split_once(": ") {
        Some((k.trim(), v))
    } else {
        let k = raw.strip_suffix(':')?;
        Some((k.trim(), ""))
    }
}

fn surface_str(surface: DraftSurface) -> &'static str {
    match surface {
        DraftSurface::Item => "item",
        DraftSurface::Prompt => "prompt",
        DraftSurface::Scratch => "scratch",
    }
}

fn parse_surface(s: &str) -> Result<DraftSurface, DraftFileError> {
    match s {
        "item" => Ok(DraftSurface::Item),
        "prompt" => Ok(DraftSurface::Prompt),
        "scratch" => Ok(DraftSurface::Scratch),
        _ => Err(DraftFileError::Malformed),
    }
}

fn kind_str(kind: Kind) -> &'static str {
    match kind {
        Kind::Note => "note",
        Kind::Task => "task",
    }
}

fn parse_kind(s: &str) -> Result<Kind, DraftFileError> {
    match s {
        "note" => Ok(Kind::Note),
        "task" => Ok(Kind::Task),
        _ => Err(DraftFileError::Malformed),
    }
}

fn status_str(status: Status) -> &'static str {
    match status {
        Status::Todo => "todo",
        Status::Doing => "doing",
        Status::Testing => "testing",
        Status::Done => "done",
    }
}

fn parse_status(s: &str) -> Result<Status, DraftFileError> {
    match s {
        "todo" => Ok(Status::Todo),
        "doing" => Ok(Status::Doing),
        "testing" => Ok(Status::Testing),
        "done" => Ok(Status::Done),
        _ => Err(DraftFileError::Malformed),
    }
}

fn priority_str(priority: Priority) -> &'static str {
    match priority {
        Priority::Low => "low",
        Priority::Normal => "normal",
        Priority::High => "high",
    }
}

fn parse_priority(s: &str) -> Result<Priority, DraftFileError> {
    match s {
        "low" => Ok(Priority::Low),
        "normal" => Ok(Priority::Normal),
        "high" => Ok(Priority::High),
        _ => Err(DraftFileError::Malformed),
    }
}

// `quote`/`unquote`/`read_capped`/`is_uuid`/`MAX_ITEM_FILE_BYTES` are reused
// from `itemfile` — already `pub(crate)` format primitives shared with
// `promptfile`, not an extension of the item field set.

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::path::PathBuf;
    use tempfile::tempdir;

    const ID_A: &str = "550e8400-e29b-41d4-a716-446655440000";
    const ID_B: &str = "11111111-2222-3333-4444-555555555555";

    /// A fully-populated draft fixture — every field set to a distinguishable
    /// value so a round-trip test can't pass by accident on a field that was
    /// silently dropped or defaulted. `entity_id`/`title`/`body`/`tags`/
    /// `due_at`/`jira_url` are all non-empty, so this fixture never triggers
    /// the empty-buffer convention.
    fn draft(id: &str) -> Draft {
        Draft {
            v: 1,
            draft_id: id.to_string(),
            surface: DraftSurface::Item,
            project_id: "660e8400-e29b-41d4-a716-446655440000".into(),
            entity_id: "770e8400-e29b-41d4-a716-446655440000".into(),
            kind: Some(Kind::Task),
            base_updated_at: "2026-07-17T11:30:00.000+00:00".into(),
            base_hash: "base-hash-value".into(),
            saved_at: "2026-07-20T09:00:00.000+00:00".into(),
            title: "Fix the login redirect".into(),
            status: Some(Status::Doing),
            priority: Some(Priority::High),
            due_at: "2026-07-25".into(),
            tags: vec!["auth".into(), "backend".into()],
            jira_url: "https://x.atlassian.net/browse/ABC-1".into(),
            body: "Steps:\r\n1. reproduce\r\n2. patch — done\r\n".into(),
        }
    }

    /// The presumed temp-file path for `id`: mirrors `itemfile::write_item`'s
    /// `.{name}.tmp` convention, which this module's doc comment says its
    /// hardening (including temp cleanup on failure) is copied from. If the
    /// real implementation names its temp file differently, the tests that use
    /// this helper will need updating alongside it.
    fn tmp_path(dir: &Path, id: &str) -> PathBuf {
        dir.join(format!(".{id}.md.tmp"))
    }

    /// A minimal, hand-crafted draft file: only the four fields `parse` is
    /// documented to require (`v`, `draft_id`, `surface`, `saved_at`) — every
    /// other field parse-defaults. Used where a test must control a field
    /// (like `v`) that `write_draft`/`serialize` can't yet produce.
    fn craft_minimal_draft_text(v: &str, draft_id: &str, surface: &str, saved_at: &str) -> String {
        format!("---\nv: {v}\ndraft_id: {draft_id}\nsurface: {surface}\nsaved_at: {saved_at}\n---\n")
    }

    #[cfg(windows)]
    fn make_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_file(target, link)
    }

    #[cfg(unix)]
    fn make_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    // --- round trip ----------------------------------------------------

    #[test]
    fn round_trip_preserves_every_field_including_crlf_and_multibyte_body() {
        let dir = tempdir().unwrap();
        let original = draft(ID_A);
        write_draft(dir.path(), &original).unwrap();
        let read = read_draft(dir.path(), ID_A).unwrap().expect("draft must exist after write_draft");
        assert_eq!(read, original, "every field, including a CRLF + multibyte body, must round-trip untouched");
    }

    #[test]
    fn body_with_frontmatter_lookalike_round_trips_verbatim() {
        let dir = tempdir().unwrap();
        let mut original = draft(ID_A);
        original.body = "intro\n---\nlooks: like frontmatter\nbut is body\n".into();
        write_draft(dir.path(), &original).unwrap();
        let read = read_draft(dir.path(), ID_A).unwrap().expect("draft must exist after write_draft");
        assert_eq!(
            read.body, original.body,
            "a body containing a bare '---' line and key: value text must not be mistaken for frontmatter"
        );
    }

    // --- atomic write ----------------------------------------------------

    #[test]
    fn write_leaves_no_tmp_file_on_success() {
        let dir = tempdir().unwrap();
        write_draft(dir.path(), &draft(ID_A)).unwrap();
        assert!(dir.path().join(format!("{ID_A}.md")).exists());
        assert!(!tmp_path(dir.path(), ID_A).exists(), "the temp file must not survive a successful write_draft");
    }

    #[test]
    fn second_write_fully_overwrites_the_first() {
        let dir = tempdir().unwrap();
        let mut first = draft(ID_A);
        first.title = "a very long first title, much longer than the second one".into();
        write_draft(dir.path(), &first).unwrap();
        let mut second = draft(ID_A);
        second.title = "short".into();
        write_draft(dir.path(), &second).unwrap();
        let read = read_draft(dir.path(), ID_A).unwrap().unwrap();
        assert_eq!(read.title, "short", "a second write_draft for the same id must fully overwrite the first");
    }

    // --- remove ----------------------------------------------------------

    #[test]
    fn remove_is_idempotent_on_a_missing_draft() {
        let dir = tempdir().unwrap();
        remove_draft(dir.path(), ID_A).unwrap();
        remove_draft(dir.path(), ID_A).unwrap();
    }

    #[test]
    fn removing_one_draft_leaves_another_intact() {
        let dir = tempdir().unwrap();
        write_draft(dir.path(), &draft(ID_A)).unwrap();
        write_draft(dir.path(), &draft(ID_B)).unwrap();
        remove_draft(dir.path(), ID_A).unwrap();
        assert_eq!(read_draft(dir.path(), ID_A).unwrap(), None);
        assert!(read_draft(dir.path(), ID_B).unwrap().is_some(), "removing one draft must not touch another");
    }

    // --- list --------------------------------------------------------------

    #[test]
    fn list_drafts_returns_exactly_the_ids_with_a_draft_file_present() {
        let dir = tempdir().unwrap();
        write_draft(dir.path(), &draft(ID_A)).unwrap();
        write_draft(dir.path(), &draft(ID_B)).unwrap();
        remove_draft(dir.path(), ID_A).unwrap();
        let scan = list_drafts(dir.path()).unwrap();
        let ids: Vec<&str> = scan.drafts.iter().map(|d| d.draft_id.as_str()).collect();
        assert_eq!(ids, vec![ID_B], "list_drafts must return exactly the ids with a draft file present");
    }

    #[test]
    fn list_drafts_records_base_updated_at_for_each_draft() {
        let dir = tempdir().unwrap();
        let mut d = draft(ID_A);
        d.base_updated_at = "2026-08-01T00:00:00.000+00:00".into();
        write_draft(dir.path(), &d).unwrap();
        let scan = list_drafts(dir.path()).unwrap();
        assert_eq!(scan.drafts[0].base_updated_at, "2026-08-01T00:00:00.000+00:00");
    }

    #[test]
    fn two_distinct_draft_ids_never_collide_on_disk() {
        let dir = tempdir().unwrap();
        write_draft(dir.path(), &draft(ID_A)).unwrap();
        write_draft(dir.path(), &draft(ID_B)).unwrap();
        assert!(read_draft(dir.path(), ID_A).unwrap().is_some());
        assert!(read_draft(dir.path(), ID_B).unwrap().is_some());
    }

    // --- empty-buffer convention --------------------------------------------

    #[test]
    fn write_of_an_all_empty_never_saved_draft_removes_the_file_instead_of_writing() {
        let dir = tempdir().unwrap();
        let mut d = draft(ID_A);
        d.entity_id = String::new();
        d.title = String::new();
        d.body = String::new();
        d.tags = Vec::new();
        d.due_at = String::new();
        d.jira_url = String::new();
        // Post-review C1: "empty" includes DEFAULT status/priority — the
        // fixture must genuinely be default-shaped (todo/normal, the editor's
        // own task seeds) for the removal branch to be correct.
        d.status = Some(Status::Todo);
        d.priority = Some(Priority::Normal);
        // Pre-seed a stale file so a passing test proves REMOVAL, not merely
        // "did not write" (which a missing file would trivially satisfy).
        std::fs::write(dir.path().join(format!("{ID_A}.md")), "stale content").unwrap();

        write_draft(dir.path(), &d).unwrap();

        assert_eq!(
            read_draft(dir.path(), ID_A).unwrap(),
            None,
            "an all-empty never-saved draft (entityId == \"\") must be removed, never written"
        );
    }

    #[test]
    fn a_status_or_priority_flip_alone_on_a_never_saved_task_draft_is_written() {
        // Post-review C1: a brand-new task draft whose ONLY edit is the status
        // (or priority) dropdown has no persisted identity anywhere else — the
        // old text-fields-only emptiness gate silently dropped it, losing the
        // whole tab on a crash.
        let dir = tempdir().unwrap();
        let mut d = draft(ID_A);
        d.entity_id = String::new();
        d.title = String::new();
        d.body = String::new();
        d.tags = Vec::new();
        d.due_at = String::new();
        d.jira_url = String::new();
        d.status = Some(Status::Doing); // the one edit
        d.priority = Some(Priority::Normal);

        write_draft(dir.path(), &d).unwrap();

        assert_eq!(
            read_draft(dir.path(), ID_A).unwrap(),
            Some(d),
            "a non-default status on a never-saved task draft is content and must be written"
        );
    }

    #[test]
    fn an_emptied_scratch_draft_is_written_not_removed() {
        // Post-review W1: a scratch draft's entityId is always "", and a user
        // who selected-all-and-deleted a non-empty pad made a genuine edit —
        // the emptied state must survive a crash, so scratch is excluded from
        // the delete-on-empty convention entirely.
        let dir = tempdir().unwrap();
        let mut d = draft(ID_A);
        d.surface = DraftSurface::Scratch;
        d.entity_id = String::new();
        d.kind = None;
        d.title = String::new();
        d.body = String::new(); // the emptied pad
        d.tags = Vec::new();
        d.due_at = String::new();
        d.jira_url = String::new();
        d.status = None;
        d.priority = None;
        d.base_hash = "1a-2b3c-4d5e".into(); // seeded from a non-empty pad

        write_draft(dir.path(), &d).unwrap();

        assert_eq!(
            read_draft(dir.path(), ID_A).unwrap(),
            Some(d),
            "an emptied scratch pad is a genuine edit and must be written"
        );
    }

    #[test]
    fn write_of_an_all_empty_saved_entity_draft_is_written_and_reads_back() {
        let dir = tempdir().unwrap();
        let mut d = draft(ID_A);
        d.title = String::new();
        d.body = String::new();
        d.tags = Vec::new();
        d.due_at = String::new();
        d.jira_url = String::new();
        // entity_id stays non-empty (from the fixture): a SAVED entity.

        write_draft(dir.path(), &d).unwrap();

        assert_eq!(
            read_draft(dir.path(), ID_A).unwrap(),
            Some(d),
            "clearing every field of a SAVED entity's draft is a genuine edit and must be written"
        );
    }

    // --- zero-byte file (simulated crash at create) -------------------------

    #[test]
    fn read_draft_on_a_zero_byte_file_returns_malformed_never_a_panic_or_empty_draft() {
        let dir = tempdir().unwrap();
        File::create(dir.path().join(format!("{ID_A}.md"))).unwrap();
        assert_eq!(read_draft(dir.path(), ID_A), Err(DraftFileError::Malformed));
    }

    #[test]
    fn list_drafts_skips_a_zero_byte_file_with_a_warning() {
        let dir = tempdir().unwrap();
        write_draft(dir.path(), &draft(ID_B)).unwrap();
        File::create(dir.path().join(format!("{ID_A}.md"))).unwrap();

        let scan = list_drafts(dir.path()).unwrap();

        assert_eq!(scan.drafts.len(), 1, "the zero-byte file must not appear as a parsed draft");
        assert_eq!(scan.drafts[0].draft_id, ID_B);
        assert_eq!(scan.warnings.len(), 1);
        assert!(
            scan.warnings[0].contains(&format!("{ID_A}.md")),
            "the warning must name the offending file: {:?}",
            scan.warnings
        );
    }

    // --- garbage file --------------------------------------------------------

    #[test]
    fn list_drafts_returns_good_drafts_and_warns_on_a_garbage_file_never_erring() {
        let dir = tempdir().unwrap();
        write_draft(dir.path(), &draft(ID_B)).unwrap();
        std::fs::write(
            dir.path().join(format!("{ID_A}.md")),
            "not frontmatter at all, just some random text\nmore garbage\n",
        )
        .unwrap();

        let scan = list_drafts(dir.path()).unwrap();

        assert_eq!(scan.drafts.len(), 1, "a garbage file must never abort the whole scan");
        assert_eq!(scan.drafts[0].draft_id, ID_B);
        assert_eq!(scan.warnings.len(), 1);
    }

    // --- invalid UTF-8 -------------------------------------------------------

    #[test]
    fn read_draft_on_invalid_utf8_returns_not_utf8_never_lossy() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join(format!("{ID_A}.md")), [0xffu8, 0xfe, b'a']).unwrap();
        assert_eq!(read_draft(dir.path(), ID_A), Err(DraftFileError::NotUtf8));
    }

    #[test]
    fn list_drafts_skips_an_invalid_utf8_file_with_a_warning() {
        let dir = tempdir().unwrap();
        write_draft(dir.path(), &draft(ID_B)).unwrap();
        std::fs::write(dir.path().join(format!("{ID_A}.md")), [0xffu8, 0xfe, b'a']).unwrap();

        let scan = list_drafts(dir.path()).unwrap();

        assert_eq!(scan.drafts.len(), 1);
        assert_eq!(scan.drafts[0].draft_id, ID_B);
        assert_eq!(scan.warnings.len(), 1);
    }

    // --- over-cap ------------------------------------------------------------

    #[test]
    fn read_draft_rejects_a_file_over_the_cap_without_reading_it_whole() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(format!("{ID_A}.md"));
        // A sparse file: this allocates no real multi-MiB of memory or (on most
        // filesystems) disk, unlike writing that many bytes out.
        let file = File::create(&path).unwrap();
        file.set_len(MAX_DRAFT_FILE_BYTES + 1).unwrap();
        assert_eq!(read_draft(dir.path(), ID_A), Err(DraftFileError::TooLarge));
    }

    #[test]
    fn write_draft_rejects_an_over_cap_body_and_leaves_the_prior_file_byte_for_byte_unchanged() {
        let dir = tempdir().unwrap();
        write_draft(dir.path(), &draft(ID_A)).unwrap();
        let before = std::fs::read(dir.path().join(format!("{ID_A}.md"))).unwrap();

        let mut oversized = draft(ID_A);
        oversized.body = "a".repeat(MAX_DRAFT_FILE_BYTES as usize + 1);
        assert_eq!(write_draft(dir.path(), &oversized), Err(DraftFileError::TooLarge));

        let after = std::fs::read(dir.path().join(format!("{ID_A}.md"))).unwrap();
        assert_eq!(before, after, "a rejected oversized write must not touch the prior file");
        assert!(!tmp_path(dir.path(), ID_A).exists(), "a rejected write must leave no tmp file behind");
    }

    // --- unknown record version ----------------------------------------------

    #[test]
    fn read_draft_on_an_unknown_record_version_returns_malformed() {
        let dir = tempdir().unwrap();
        let text = craft_minimal_draft_text("2", ID_A, "item", "2026-07-20T09:00:00.000+00:00");
        std::fs::write(dir.path().join(format!("{ID_A}.md")), text).unwrap();
        assert_eq!(read_draft(dir.path(), ID_A), Err(DraftFileError::Malformed));
    }

    #[test]
    fn list_drafts_skips_an_unknown_version_file_with_a_warning() {
        let dir = tempdir().unwrap();
        write_draft(dir.path(), &draft(ID_B)).unwrap();
        let text = craft_minimal_draft_text("2", ID_A, "item", "2026-07-20T09:00:00.000+00:00");
        std::fs::write(dir.path().join(format!("{ID_A}.md")), text).unwrap();

        let scan = list_drafts(dir.path()).unwrap();

        assert_eq!(scan.drafts.len(), 1);
        assert_eq!(scan.drafts[0].draft_id, ID_B);
        assert_eq!(scan.warnings.len(), 1);
    }

    // --- leftover tmp --------------------------------------------------------

    #[test]
    fn leftover_tmp_file_does_not_affect_a_fresh_write_or_listing() {
        let dir = tempdir().unwrap();
        std::fs::write(tmp_path(dir.path(), ID_A), "leftover partial write").unwrap();

        write_draft(dir.path(), &draft(ID_A)).unwrap();

        let scan = list_drafts(dir.path()).unwrap();
        assert_eq!(scan.drafts.len(), 1, "a leftover .tmp file must never be listed as a draft");
        assert_eq!(scan.drafts[0].draft_id, ID_A);
    }

    // --- rename-failure cleanup ------------------------------------------------

    #[test]
    fn write_draft_cleans_up_the_tmp_when_the_rename_fails() {
        // A directory named `<id>.md` makes the rename fail after the temp file
        // was fully written; the temp must not survive.
        let dir = tempdir().unwrap();
        std::fs::create_dir(dir.path().join(format!("{ID_A}.md"))).unwrap();
        assert!(write_draft(dir.path(), &draft(ID_A)).is_err());
        assert!(!tmp_path(dir.path(), ID_A).exists(), "a failed write_draft must not leave its tmp file behind");
    }

    // --- non-UUID ids --------------------------------------------------------

    #[test]
    fn non_uuid_draft_ids_are_rejected_before_any_path_join() {
        let dir = tempdir().unwrap();
        for bad in ["../escape", "a:b", "CON", "draft-550e8400-e29b-41d4-a716-446655440000", ""] {
            assert_eq!(write_draft(dir.path(), &draft(bad)), Err(DraftFileError::BadId), "write_draft must reject {bad:?}");
            assert_eq!(read_draft(dir.path(), bad), Err(DraftFileError::BadId), "read_draft must reject {bad:?}");
            assert_eq!(remove_draft(dir.path(), bad), Err(DraftFileError::BadId), "remove_draft must reject {bad:?}");
        }
    }

    #[test]
    fn file_name_rejects_non_uuid_ids() {
        assert_eq!(file_name(ID_A).unwrap(), format!("{ID_A}.md"));
        for bad in ["../escape", "a:b", "CON", "draft-550e8400-e29b-41d4-a716-446655440000", ""] {
            assert_eq!(file_name(bad), Err(DraftFileError::BadId), "file_name must reject {bad:?}");
        }
    }

    // --- symlink refusal -----------------------------------------------------

    #[test]
    fn write_draft_refuses_when_the_target_path_is_a_symlink() {
        let dir = tempdir().unwrap();
        let real = dir.path().join("real.md");
        std::fs::write(&real, "real content, never to be touched").unwrap();
        let link = dir.path().join(format!("{ID_A}.md"));
        if let Err(e) = make_symlink(&real, &link) {
            eprintln!(
                "skipping write_draft_refuses_when_the_target_path_is_a_symlink: \
                 cannot create a symlink on this host ({e}); enable Windows Developer \
                 Mode or run elevated"
            );
            return;
        }

        assert_eq!(write_draft(dir.path(), &draft(ID_A)), Err(DraftFileError::Symlink));

        let after = std::fs::read_to_string(&real).unwrap();
        assert_eq!(
            after, "real content, never to be touched",
            "a refused write must never touch the symlink's target file"
        );
    }

    #[test]
    fn write_draft_refuses_when_the_tmp_path_is_a_symlink() {
        let dir = tempdir().unwrap();
        let real = dir.path().join("real.md");
        std::fs::write(&real, "real content, never to be touched").unwrap();
        let link = tmp_path(dir.path(), ID_A);
        if let Err(e) = make_symlink(&real, &link) {
            eprintln!(
                "skipping write_draft_refuses_when_the_tmp_path_is_a_symlink: \
                 cannot create a symlink on this host ({e}); enable Windows Developer \
                 Mode or run elevated"
            );
            return;
        }

        assert_eq!(write_draft(dir.path(), &draft(ID_A)), Err(DraftFileError::Symlink));

        let after = std::fs::read_to_string(&real).unwrap();
        assert_eq!(
            after, "real content, never to be touched",
            "a refused write must never touch the tmp symlink's target file"
        );
        assert!(
            !dir.path().join(format!("{ID_A}.md")).exists(),
            "the write must not have proceeded to the target either"
        );
    }

    #[test]
    fn read_draft_refuses_when_the_target_path_is_a_symlink() {
        let dir = tempdir().unwrap();
        let real = dir.path().join("real.md");
        std::fs::write(&real, "real content, never to be touched").unwrap();
        let link = dir.path().join(format!("{ID_A}.md"));
        if let Err(e) = make_symlink(&real, &link) {
            eprintln!(
                "skipping read_draft_refuses_when_the_target_path_is_a_symlink: \
                 cannot create a symlink on this host ({e}); enable Windows Developer \
                 Mode or run elevated"
            );
            return;
        }

        assert_eq!(read_draft(dir.path(), ID_A), Err(DraftFileError::Symlink));
    }

    // --- filename != embedded id ---------------------------------------------

    #[test]
    fn list_drafts_skips_a_file_whose_filename_does_not_match_its_embedded_draft_id() {
        let dir = tempdir().unwrap();
        write_draft(dir.path(), &draft(ID_A)).unwrap();
        std::fs::copy(dir.path().join(format!("{ID_A}.md")), dir.path().join(format!("{ID_B}.md"))).unwrap();

        let scan = list_drafts(dir.path()).unwrap();

        let ids: Vec<&str> = scan.drafts.iter().map(|d| d.draft_id.as_str()).collect();
        assert_eq!(
            ids,
            vec![ID_A],
            "a file whose filename does not match its embedded draft_id must never be returned"
        );
        assert_eq!(scan.warnings.len(), 1, "the mismatch must produce exactly one warning: {:?}", scan.warnings);
    }

    // --- missing drafts root -------------------------------------------------

    #[test]
    fn list_drafts_on_a_missing_root_returns_zero_drafts() {
        let dir = tempdir().unwrap();
        let gone = dir.path().join("no-such-drafts-dir");
        let scan = list_drafts(&gone).unwrap();
        assert!(scan.drafts.is_empty());
        assert!(scan.warnings.is_empty());
    }

    #[test]
    fn write_draft_creates_the_drafts_root_on_demand() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("drafts");
        assert!(!root.exists());
        write_draft(&root, &draft(ID_A)).unwrap();
        assert!(root.join(format!("{ID_A}.md")).exists(), "write_draft must create the drafts root directory on demand");
    }

    // --- read on an absent file ------------------------------------------------

    #[test]
    fn read_draft_on_an_absent_file_returns_ok_none() {
        let dir = tempdir().unwrap();
        assert_eq!(read_draft(dir.path(), ID_A).unwrap(), None);
    }

    // --- GC ------------------------------------------------------------------

    #[test]
    fn gc_removes_drafts_older_than_the_cutoff_and_keeps_newer_ones() {
        let dir = tempdir().unwrap();
        let mut old = draft(ID_A);
        old.saved_at = "2026-05-01T00:00:00.000+00:00".into();
        let mut newer = draft(ID_B);
        newer.saved_at = "2026-07-01T00:00:00.000+00:00".into();
        write_draft(dir.path(), &old).unwrap();
        write_draft(dir.path(), &newer).unwrap();

        let removed = gc(dir.path(), "2026-06-01T00:00:00.000+00:00").unwrap();

        assert_eq!(removed, 1, "gc must remove exactly the one draft older than the cutoff");
        assert_eq!(read_draft(dir.path(), ID_A).unwrap(), None, "a draft saved before the cutoff must be gc'd");
        assert!(read_draft(dir.path(), ID_B).unwrap().is_some(), "a draft saved after the cutoff must survive");
    }

    #[test]
    fn gc_evicts_exactly_the_oldest_two_beyond_max_draft_records() {
        let dir = tempdir().unwrap();
        let total = MAX_DRAFT_RECORDS + 2;
        let mut ids = Vec::with_capacity(total);
        for i in 0..total {
            let id = uuid::Uuid::new_v4().to_string();
            let mut d = draft(&id);
            d.saved_at = format!("2026-01-01T00:{i:02}:00.000+00:00");
            write_draft(dir.path(), &d).unwrap();
            ids.push(id);
        }

        // A cutoff far in the past so only the count-based eviction fires.
        let removed = gc(dir.path(), "2000-01-01T00:00:00.000+00:00").unwrap();

        assert_eq!(removed, 2, "gc must evict exactly the records beyond MAX_DRAFT_RECORDS");
        assert_eq!(read_draft(dir.path(), &ids[0]).unwrap(), None, "the oldest record must be evicted");
        assert_eq!(read_draft(dir.path(), &ids[1]).unwrap(), None, "the second-oldest record must be evicted");
        for id in &ids[2..] {
            assert!(read_draft(dir.path(), id).unwrap().is_some(), "a record within the cap must survive");
        }
    }

    #[test]
    fn gc_on_a_missing_root_is_ok_zero() {
        let dir = tempdir().unwrap();
        let gone = dir.path().join("no-such-drafts-dir");
        assert_eq!(gc(&gone, "2026-01-01T00:00:00.000+00:00"), Ok(0));
    }

    #[test]
    fn gc_reaps_a_crash_leftover_tmp_file_and_leaves_real_drafts_alone() {
        // Post-review (security M1): a `.<uuid>.md.tmp` left by a crash between
        // create and rename holds buffer text that the .md-only scan, sweeps,
        // TTL, and cap can never reach — startup gc must remove it. A normally
        // written draft (no tmp survives a successful write) is untouched.
        let dir = tempdir().unwrap();
        write_draft(dir.path(), &draft(ID_B)).unwrap();
        std::fs::write(tmp_path(dir.path(), ID_A), "crash-leftover buffer text").unwrap();

        let removed = gc(dir.path(), "2000-01-01T00:00:00.000+00:00").unwrap();

        assert_eq!(removed, 1, "exactly the leftover tmp must be reaped");
        assert!(!tmp_path(dir.path(), ID_A).exists(), "the leftover tmp must be gone");
        assert!(
            read_draft(dir.path(), ID_B).unwrap().is_some(),
            "a real draft within TTL and cap must survive the tmp reap"
        );
    }
}
