//! Canonical prompt-file format (plan.7): the git-mergeable source of truth for
//! per-project prompts and their full version history. Mirrors `itemfile` but
//! over a TWO-LEVEL layout, because a prompt owns an immutable version history:
//!
//! ```text
//! prompts/
//!   <prompt-uuid>/
//!     prompt.md            mutable prompt-level state: id, reusable, created_at
//!     <version-uuid>.md    immutable version: id, source, created_at, title + body
//!     <version-uuid>.md    (another immutable version)
//! ```
//!
//! Design choices inherited verbatim from `itemfile` (whose primitives this
//! module reuses rather than reimplements — `is_uuid`, `quote`/`unquote`,
//! `has_conflict_markers`, `read_capped`, the 4 MB cap):
//! - **Byte-deterministic output** (fixed key order, LF, fixed-ms timestamps) so
//!   an unchanged file never produces a spurious git diff.
//! - **A restricted line reader, not a general YAML engine** — no alias/anchor
//!   DoS surface, panic-free on file content, per-file size cap.
//! - **git-merge honesty** — a file carrying conflict markers is refused
//!   per-file (reported, not half-imported).
//!
//! Two invariants this format enforces for security (plan.7 §4):
//! - **H2 — filenames derive ONLY from a backend-minted UUID.** The prompt dir is
//!   `<prompt-uuid>/` and a version file is `<version-uuid>.md`, both gated by
//!   `is_uuid`, so a crafted id can never escape `prompts/` (`..`, separators,
//!   `:` ADS, reserved names all fail the check). `prompt_id` is NEVER written
//!   into a version file — it is derived from the parent directory on scan (the
//!   same principle as items not storing `project_id`).
//! - **M3 — no secret material is ever written.** A prompt carries none; a test
//!   asserts the serialized bytes hold no token/key field.
//!
//! Every content edit and every AI-enhanced save writes a NEW immutable
//! `<version-uuid>.md` and never touches an existing version file, so two
//! branches each adding a version produce two disjoint files that git merges
//! cleanly with both preserved. "Current version" is DERIVED (head of
//! `ORDER BY created_at DESC, id ASC`), never a stored pointer, so nothing
//! mutable conflicts on merge.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::itemfile::{
    self, has_conflict_markers, is_uuid, quote, read_capped, unquote, MAX_ITEM_FILE_BYTES,
};

/// The prompt-level record persisted in `prompt.md` — the only mutable prompt
/// state. `id` is the directory name; `created_at` is the prompt's creation
/// time (NOT derived — a prompt's own birth, distinct from any version's).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptRecord {
    pub id: String,
    pub reusable: bool,
    pub created_at: String,
}

/// One immutable version, persisted in `<version-uuid>.md`. `prompt_id` is
/// derived from the parent directory on scan and is NEVER written to the file
/// (mirrors items not persisting `project_id`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptVersionRecord {
    pub id: String,
    pub prompt_id: String,
    pub title: String,
    pub body: String,
    /// `"manual"` | `"aiEnhanced"`. Normalized on parse to one of those two so a
    /// hand-edited/merged file with a garbage source can never poison the index.
    pub source: String,
    pub created_at: String,
}

/// Why a single prompt/version file could not be parsed. Carried out of `scan`
/// alongside the offending name so a rebuild reports per-file partial success
/// (mirrors `itemfile::ItemFileError`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PromptFileError {
    /// The file (or its frontmatter) is not the shape we write.
    Malformed(String),
    /// The file carries git conflict markers — a human must resolve it first.
    ConflictMarkers,
    /// The file exceeds `MAX_ITEM_FILE_BYTES`.
    TooLarge,
    /// The id (dir name or file stem) is missing or not a UUID.
    BadId,
}

impl std::fmt::Display for PromptFileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PromptFileError::Malformed(what) => write!(f, "not a valid prompt file ({what})"),
            PromptFileError::ConflictMarkers => {
                write!(f, "contains unresolved git conflict markers")
            }
            PromptFileError::TooLarge => write!(f, "prompt file is too large"),
            PromptFileError::BadId => write!(f, "prompt id is missing or malformed"),
        }
    }
}

/// A prompt reconstructed from disk: its head (from `prompt.md` or synthesized)
/// and every version file that parsed under it.
pub struct ScannedPrompt {
    pub prompt: PromptRecord,
    pub versions: Vec<PromptVersionRecord>,
}

/// The result of a two-level `prompts/` scan: every prompt that yielded at least
/// one version, plus a `(name, reason)` per entry that was skipped — so a rebuild
/// imports the good and reports the bad instead of aborting.
pub struct PromptScanOutcome {
    pub prompts: Vec<ScannedPrompt>,
    pub errors: Vec<(String, PromptFileError)>,
}

/// The canonical directory name for a prompt: `<id>`, UUID-only. Both derives
/// the name purely from the backend id and rejects anything not UUID-shaped so a
/// crafted id can't escape `prompts/` (H2).
pub fn prompt_dir_name(id: &str) -> Result<String, PromptFileError> {
    if is_uuid(id) {
        Ok(id.to_string())
    } else {
        Err(PromptFileError::BadId)
    }
}

/// The canonical file name for a version: `<id>.md`, UUID-only (H2).
pub fn version_file_name(id: &str) -> Result<String, PromptFileError> {
    if is_uuid(id) {
        Ok(format!("{id}.md"))
    } else {
        Err(PromptFileError::BadId)
    }
}

/// Normalize a version `source` to the closed set. Anything that is not the
/// exact `"aiEnhanced"` marker (including a missing, empty, or hand-edited value)
/// collapses to `"manual"`, so a merged/garbage file can never introduce an
/// unknown source into the index.
fn normalize_source(raw: &str) -> String {
    if raw == "aiEnhanced" {
        "aiEnhanced".to_string()
    } else {
        "manual".to_string()
    }
}

// --- Serialize --------------------------------------------------------------

/// Serialize a prompt head to its canonical `prompt.md` bytes. Pure and
/// deterministic; no body follows the closing fence.
pub fn serialize_prompt(p: &PromptRecord) -> String {
    let mut out = String::new();
    out.push_str("---\n");
    line(&mut out, "id", &p.id);
    line(&mut out, "reusable", bool_str(p.reusable));
    line(&mut out, "created_at", &p.created_at);
    out.push_str("---\n");
    out
}

/// Serialize a version to its canonical `<id>.md` bytes. Fixed key order; the
/// body follows the closing fence verbatim (raw text, recovered byte-for-byte).
/// `prompt_id` is deliberately NOT written (derived from the parent dir on scan).
pub fn serialize_version(v: &PromptVersionRecord) -> String {
    let mut out = String::new();
    out.push_str("---\n");
    line(&mut out, "id", &v.id);
    line(&mut out, "source", &normalize_source(&v.source));
    line(&mut out, "created_at", &v.created_at);
    quoted_line(&mut out, "title", &v.title);
    out.push_str("---\n");
    out.push_str(&v.body);
    out
}

// --- Parse ------------------------------------------------------------------

/// Parse `prompt.md` bytes into a `PromptRecord`. A conflicted or malformed file
/// errors (the scanner then synthesizes the head from the versions). `id` must be
/// a UUID.
pub fn parse_prompt(text: &str) -> Result<PromptRecord, PromptFileError> {
    if has_conflict_markers(text) {
        return Err(PromptFileError::ConflictMarkers);
    }
    let (fields, _body) = parse_frontmatter(text)?;
    let id = require(&fields, "id")?;
    if !is_uuid(&id) {
        return Err(PromptFileError::BadId);
    }
    let reusable = parse_bool(&require(&fields, "reusable")?)?;
    let created_at = require(&fields, "created_at")?;
    Ok(PromptRecord { id, reusable, created_at })
}

/// Parse a version file's bytes into a `PromptVersionRecord`, stamping the
/// `prompt_id` supplied by the caller (the parent directory name — never read
/// from the file). `id` must be a UUID; `source` is normalized; `title` is
/// required; the body is everything after the closing fence, verbatim.
pub fn parse_version(text: &str, prompt_id: &str) -> Result<PromptVersionRecord, PromptFileError> {
    if has_conflict_markers(text) {
        return Err(PromptFileError::ConflictMarkers);
    }
    let (fields, body) = parse_frontmatter(text)?;
    let id = require(&fields, "id")?;
    if !is_uuid(&id) {
        return Err(PromptFileError::BadId);
    }
    let source = normalize_source(fields.get("source").map(String::as_str).unwrap_or("manual"));
    let created_at = require(&fields, "created_at")?;
    let title = fields
        .get("title")
        .map(|v| unquote(v))
        .transpose()
        .map_err(map_item_err)?
        .ok_or_else(|| PromptFileError::Malformed("missing title".into()))?;
    Ok(PromptVersionRecord {
        id,
        prompt_id: prompt_id.to_string(),
        title,
        body: body.to_string(),
        source,
        created_at,
    })
}

// --- Write / remove ---------------------------------------------------------

/// Write `prompt.md` into `<prompts_dir>/<prompt-uuid>/`, creating the dir if
/// needed, atomically (temp-then-rename) so a crash never leaves a half-written
/// head. The dir name is UUID-derived (H2).
pub fn write_prompt(prompts_dir: &Path, p: &PromptRecord) -> Result<(), PromptFileError> {
    let dir = ensure_prompt_dir(prompts_dir, &p.id)?;
    write_atomic(&dir, "prompt.md", &serialize_prompt(p))
}

/// Write a version file into `<prompts_dir>/<prompt-uuid>/`, atomically. Both the
/// dir (from `v.prompt_id`) and the file name (from `v.id`) are UUID-derived
/// (H2). NEVER overwrites an existing version file in practice — the id is a
/// freshly minted UUID — so history is append-only.
pub fn write_version(prompts_dir: &Path, v: &PromptVersionRecord) -> Result<(), PromptFileError> {
    let dir = ensure_prompt_dir(prompts_dir, &v.prompt_id)?;
    let name = version_file_name(&v.id)?;
    write_atomic(&dir, &name, &serialize_version(v))
}

/// Remove an entire prompt directory (its `prompt.md` and every version). A
/// missing directory is success, so delete stays idempotent. The dir name is
/// UUID-derived (H2).
pub fn remove_prompt(prompts_dir: &Path, prompt_id: &str) -> Result<(), PromptFileError> {
    let dir_name = prompt_dir_name(prompt_id)?;
    match std::fs::remove_dir_all(prompts_dir.join(&dir_name)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(PromptFileError::Malformed(format!("delete failed: {}", e.kind()))),
    }
}

fn ensure_prompt_dir(prompts_dir: &Path, prompt_id: &str) -> Result<PathBuf, PromptFileError> {
    let dir = prompts_dir.join(prompt_dir_name(prompt_id)?);
    std::fs::create_dir_all(&dir)
        .map_err(|e| PromptFileError::Malformed(format!("mkdir failed: {}", e.kind())))?;
    Ok(dir)
}

/// Write `name` into `dir` via a temp-then-rename, mirroring `itemfile::write_item`
/// (crash-atomic against a process crash; no fsync, matching the item store).
fn write_atomic(dir: &Path, name: &str, contents: &str) -> Result<(), PromptFileError> {
    let target = dir.join(name);
    let tmp = dir.join(format!(".{name}.tmp"));
    std::fs::write(&tmp, contents.as_bytes())
        .map_err(|e| PromptFileError::Malformed(format!("write failed: {}", e.kind())))?;
    std::fs::rename(&tmp, &target)
        .map_err(|e| PromptFileError::Malformed(format!("rename failed: {}", e.kind())))?;
    Ok(())
}

// --- Scan (two-level) -------------------------------------------------------

/// Scan `prompts/`: iterate its immediate subdirectories, parse each prompt and
/// its versions, and report per-entry failures. Never fails as a whole: a
/// missing directory yields an empty scan; a bad subdir/file becomes an entry in
/// `errors`. Results are sorted by name so a rebuild is deterministic.
///
/// - A subdir whose name is not a UUID is skipped and reported (no recursion).
/// - Within a prompt dir, every `<stem>.md` except `prompt.md` is a version:
///   a non-UUID stem, an oversized file, or a conflicted/malformed file is
///   skipped+reported; the rest parse (with `prompt_id` = the dir name).
/// - The head is read from `prompt.md`; if it is missing, unparseable, or its id
///   disagrees with the dir name, the head is SYNTHESIZED (`reusable = false`,
///   `created_at = min(version created_at)`) so versions are never orphaned (H2).
/// - A prompt dir with zero parseable versions contributes NO prompt and is
///   reported (an index prompt always has ≥1 version; there is nothing to show).
pub fn scan(prompts_dir: &Path) -> PromptScanOutcome {
    let mut prompts = Vec::new();
    let mut errors = Vec::new();

    let entries = match std::fs::read_dir(prompts_dir) {
        Ok(e) => e,
        Err(_) => return PromptScanOutcome { prompts, errors }, // missing dir → empty scan
    };
    let mut dirs: Vec<PathBuf> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();

    for dir in dirs {
        let dir_name = dir
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("<dir>")
            .to_string();
        if !is_uuid(&dir_name) {
            errors.push((dir_name, PromptFileError::BadId)); // not a prompt dir; do not recurse
            continue;
        }

        let versions = scan_versions(&dir, &dir_name, &mut errors);
        if versions.is_empty() {
            // Nothing to show: a prompt row requires a current version.
            errors.push((dir_name, PromptFileError::Malformed("prompt has no versions".into())));
            continue;
        }

        let head = read_prompt_head(&dir).filter(|rec| rec.id == dir_name);
        let prompt = head.unwrap_or_else(|| PromptRecord {
            id: dir_name.clone(),
            reusable: false,
            created_at: min_created_at(&versions),
        });
        prompts.push(ScannedPrompt { prompt, versions });
    }

    PromptScanOutcome { prompts, errors }
}

/// Parse every version file in one prompt dir, appending failures to `errors`.
/// `prompt.md` is skipped here (it is the head, read separately). Sorted for
/// determinism.
fn scan_versions(
    dir: &Path,
    prompt_id: &str,
    errors: &mut Vec<(String, PromptFileError)>,
) -> Vec<PromptVersionRecord> {
    let mut versions = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return versions,
    };
    let mut files: Vec<PathBuf> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("md"))
        .filter(|p| p.file_name().and_then(|s| s.to_str()) != Some("prompt.md"))
        .collect();
    files.sort();

    for path in files {
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("<file>")
            .to_string();
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        if !is_uuid(stem) {
            errors.push((name, PromptFileError::BadId));
            continue;
        }
        // Fast reject then a BOUNDED read (same TOCTOU guard as `itemfile::scan`).
        match std::fs::metadata(&path) {
            Ok(meta) if meta.len() > MAX_ITEM_FILE_BYTES => {
                errors.push((name, PromptFileError::TooLarge));
                continue;
            }
            Ok(_) => {}
            Err(e) => {
                errors.push((name, PromptFileError::Malformed(format!("stat failed: {}", e.kind()))));
                continue;
            }
        }
        match read_capped(&path) {
            Ok(Some(text)) => match parse_version(&text, prompt_id) {
                Ok(v) => versions.push(v),
                Err(e) => errors.push((name, e)),
            },
            Ok(None) => errors.push((name, PromptFileError::TooLarge)),
            Err(e) => errors.push((name, PromptFileError::Malformed(format!("read failed: {}", e.kind())))),
        }
    }
    versions
}

/// Read + parse `prompt.md` if present, cap-bounded. `None` on any failure
/// (missing / oversized / malformed / conflicted) so the caller synthesizes.
fn read_prompt_head(dir: &Path) -> Option<PromptRecord> {
    let path = dir.join("prompt.md");
    match std::fs::metadata(&path) {
        Ok(meta) if meta.len() > MAX_ITEM_FILE_BYTES => return None,
        Ok(_) => {}
        Err(_) => return None,
    }
    match read_capped(&path) {
        Ok(Some(text)) => parse_prompt(&text).ok(),
        _ => None,
    }
}

/// The smallest `created_at` across versions (fixed-ms RFC 3339 → lexical order
/// equals chronological). Callers only invoke this when `versions` is non-empty.
fn min_created_at(versions: &[PromptVersionRecord]) -> String {
    versions
        .iter()
        .map(|v| v.created_at.as_str())
        .min()
        .unwrap_or("")
        .to_string()
}

// --- Frontmatter primitives (a restricted reader over our fixed field set) ---

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

/// Split the frontmatter fields from the body. Finds the opening `---` fence and
/// the first whole `---` line that closes it; the body is everything after that
/// line, verbatim. Mirrors `itemfile::parse`'s fence handling exactly, so a body
/// that itself contains a `---` or `key: value` line is preserved.
fn parse_frontmatter(text: &str) -> Result<(HashMap<String, String>, &str), PromptFileError> {
    let after_open = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))
        .ok_or_else(|| PromptFileError::Malformed("missing opening --- fence".into()))?;

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
    let fm_end =
        fm_end.ok_or_else(|| PromptFileError::Malformed("missing closing --- fence".into()))?;
    let frontmatter = &after_open[..fm_end];
    let body = &after_open[body_start.unwrap_or(after_open.len())..];

    let mut fields: HashMap<String, String> = HashMap::new();
    for raw in frontmatter.lines() {
        if raw.trim().is_empty() {
            continue;
        }
        let (key, value) = split_field(raw)
            .ok_or_else(|| PromptFileError::Malformed(format!("bad frontmatter line: {raw}")))?;
        fields.insert(key.to_string(), value.to_string());
    }
    Ok((fields, body))
}

/// Split `key: value` on the FIRST ": " (a fixed bareword key, so colons inside
/// an RFC 3339 timestamp or a quoted title stay in the value). A key line with no
/// value yields an empty value.
fn split_field(raw: &str) -> Option<(&str, &str)> {
    if let Some((k, v)) = raw.split_once(": ") {
        Some((k.trim(), v))
    } else {
        let k = raw.strip_suffix(':')?;
        Some((k.trim(), ""))
    }
}

fn require(fields: &HashMap<String, String>, key: &str) -> Result<String, PromptFileError> {
    fields
        .get(key)
        .cloned()
        .ok_or_else(|| PromptFileError::Malformed(format!("missing {key}")))
}

fn bool_str(b: bool) -> &'static str {
    if b {
        "true"
    } else {
        "false"
    }
}

fn parse_bool(s: &str) -> Result<bool, PromptFileError> {
    match s {
        "true" => Ok(true),
        "false" => Ok(false),
        other => Err(PromptFileError::Malformed(format!("bad bool: {other}"))),
    }
}

/// Bridge an `ItemFileError` (from the shared `unquote`) into our error type —
/// only `Malformed` can arise from `unquote`, but map all arms for totality.
fn map_item_err(e: itemfile::ItemFileError) -> PromptFileError {
    match e {
        itemfile::ItemFileError::Malformed(what) => PromptFileError::Malformed(what),
        itemfile::ItemFileError::ConflictMarkers => PromptFileError::ConflictMarkers,
        itemfile::ItemFileError::TooLarge => PromptFileError::TooLarge,
        itemfile::ItemFileError::BadId => PromptFileError::BadId,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PID: &str = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const VID: &str = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const VID2: &str = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const TS: &str = "2026-07-18T10:00:00.000+00:00";
    const TS2: &str = "2026-07-18T11:00:00.000+00:00";

    fn head() -> PromptRecord {
        PromptRecord { id: PID.into(), reusable: true, created_at: TS.into() }
    }

    fn version(id: &str, title: &str, body: &str, source: &str, created_at: &str) -> PromptVersionRecord {
        PromptVersionRecord {
            id: id.into(),
            prompt_id: PID.into(),
            title: title.into(),
            body: body.into(),
            source: source.into(),
            created_at: created_at.into(),
        }
    }

    #[test]
    fn prompt_head_round_trips() {
        let p = head();
        let parsed = parse_prompt(&serialize_prompt(&p)).unwrap();
        assert_eq!(p, parsed);
    }

    #[test]
    fn version_round_trips_every_field() {
        let v = version(VID, "Draft the release email", "Body\nwith lines\n", "aiEnhanced", TS);
        let parsed = parse_version(&serialize_version(&v), PID).unwrap();
        assert_eq!(v, parsed);
    }

    #[test]
    fn export_is_byte_identical_after_a_round_trip() {
        for v in [
            version(VID, "t", "b", "manual", TS),
            version(VID2, "t2", "", "aiEnhanced", TS2),
        ] {
            let once = serialize_version(&v);
            let twice = serialize_version(&parse_version(&once, PID).unwrap());
            assert_eq!(once, twice, "serialize∘parse∘serialize must be a fixed point");
        }
        let p = head();
        assert_eq!(serialize_prompt(&p), serialize_prompt(&parse_prompt(&serialize_prompt(&p)).unwrap()));
    }

    #[test]
    fn prompt_id_is_never_written_into_a_version_file() {
        let v = version(VID, "title", "body", "manual", TS);
        let text = serialize_version(&v);
        assert!(!text.contains("prompt_id"), "a version file must not carry prompt_id (derived from the dir)");
    }

    #[test]
    fn body_with_a_frontmatter_lookalike_is_preserved_verbatim() {
        let v = version(VID, "t", "intro\n---\nkey: value\nstill body\n", "manual", TS);
        let parsed = parse_version(&serialize_version(&v), PID).unwrap();
        assert_eq!(parsed.body, v.body);
    }

    #[test]
    fn empty_body_round_trips() {
        let v = version(VID, "t", "", "manual", TS);
        let parsed = parse_version(&serialize_version(&v), PID).unwrap();
        assert_eq!(parsed.body, "");
    }

    #[test]
    fn title_with_quotes_and_colons_round_trips() {
        let v = version(VID, r#"weird: "quoted" title: 2"#, "b", "manual", TS);
        let parsed = parse_version(&serialize_version(&v), PID).unwrap();
        assert_eq!(parsed.title, v.title);
    }

    #[test]
    fn unknown_source_normalizes_to_manual() {
        let text = format!("---\nid: {VID}\nsource: bogus\ncreated_at: {TS}\ntitle: \"t\"\n---\nbody");
        let parsed = parse_version(&text, PID).unwrap();
        assert_eq!(parsed.source, "manual", "a garbage source must not enter the index");
    }

    #[test]
    fn conflict_markers_are_refused() {
        let text = format!(
            "---\nid: {VID}\nsource: manual\ncreated_at: {TS}\ntitle: \"t\"\n\
             <<<<<<< HEAD\nx\n=======\ny\n>>>>>>> branch\n---\nbody"
        );
        assert!(matches!(parse_version(&text, PID), Err(PromptFileError::ConflictMarkers)));
    }

    #[test]
    fn filenames_derive_from_the_uuid_and_reject_unsafe_ids() {
        assert_eq!(prompt_dir_name(PID).unwrap(), PID);
        assert_eq!(version_file_name(VID).unwrap(), format!("{VID}.md"));
        for bad in ["../escape", "CON", "a/b", "a:b", "not-a-uuid", ""] {
            assert_eq!(prompt_dir_name(bad), Err(PromptFileError::BadId), "dir must reject {bad:?}");
            assert_eq!(version_file_name(bad), Err(PromptFileError::BadId), "file must reject {bad:?}");
        }
    }

    #[test]
    fn parse_rejects_a_non_uuid_id_and_a_missing_fence() {
        assert!(matches!(parse_version("no fence", PID), Err(PromptFileError::Malformed(_))));
        let text = format!("---\nid: not-a-uuid\nsource: manual\ncreated_at: {TS}\ntitle: \"t\"\n---\n");
        assert!(matches!(parse_version(&text, PID), Err(PromptFileError::BadId)));
    }

    #[test]
    fn serialized_bytes_carry_no_secret_material() {
        let text = format!("{}{}", serialize_prompt(&head()), serialize_version(&version(VID, "t", "b", "aiEnhanced", TS)));
        for forbidden in ["token", "apikey", "api_key", "secret", "password", "authorization", "bearer"] {
            assert!(!text.to_lowercase().contains(forbidden), "a prompt file must never contain {forbidden}");
        }
    }

    // --- two-level scan -----------------------------------------------------

    fn write_fixture_prompt(root: &Path, p: &PromptRecord, versions: &[PromptVersionRecord]) {
        write_prompt(root, p).unwrap();
        for v in versions {
            write_version(root, v).unwrap();
        }
    }

    #[test]
    fn scan_reads_a_prompt_with_its_full_history() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_fixture_prompt(
            root,
            &head(),
            &[version(VID, "v1", "b1", "manual", TS), version(VID2, "v2", "b2", "aiEnhanced", TS2)],
        );
        let out = scan(root);
        assert!(out.errors.is_empty(), "clean fixture scans without errors: {:?}", out.errors);
        assert_eq!(out.prompts.len(), 1);
        assert_eq!(out.prompts[0].prompt, head());
        assert_eq!(out.prompts[0].versions.len(), 2);
    }

    #[test]
    fn scan_synthesizes_a_head_when_prompt_md_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        // Write only version files (no prompt.md) — an orphaned-version case.
        write_version(root, &version(VID, "v1", "b", "manual", TS2)).unwrap();
        write_version(root, &version(VID2, "v2", "b", "manual", TS)).unwrap(); // earlier ts
        let out = scan(root);
        assert_eq!(out.prompts.len(), 1, "versions are never orphaned");
        let p = &out.prompts[0].prompt;
        assert_eq!(p.id, PID);
        assert!(!p.reusable, "synthesized head is not reusable");
        assert_eq!(p.created_at, TS, "synthesized created_at is the min version created_at");
        assert_eq!(out.prompts[0].versions.len(), 2);
    }

    #[test]
    fn scan_skips_a_non_uuid_subdir_and_reports_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("not-a-uuid")).unwrap();
        write_fixture_prompt(root, &head(), &[version(VID, "v", "b", "manual", TS)]);
        let out = scan(root);
        assert_eq!(out.prompts.len(), 1);
        assert!(out.errors.iter().any(|(n, e)| n == "not-a-uuid" && *e == PromptFileError::BadId));
    }

    #[test]
    fn scan_reports_a_version_less_prompt_and_a_conflicted_version() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        // A prompt dir with only a conflicted version → no parseable versions.
        let pdir = root.join(PID);
        std::fs::create_dir_all(&pdir).unwrap();
        std::fs::write(
            pdir.join(format!("{VID}.md")),
            format!("---\nid: {VID}\nsource: manual\ncreated_at: {TS}\ntitle: \"t\"\n<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n---\nbody"),
        )
        .unwrap();
        let out = scan(root);
        assert!(out.prompts.is_empty(), "a prompt with no parseable version contributes nothing");
        // Both the conflicted version file and the version-less prompt are reported.
        assert!(out.errors.iter().any(|(n, e)| n.contains(VID) && *e == PromptFileError::ConflictMarkers));
        assert!(out.errors.iter().any(|(n, e)| n == PID && matches!(e, PromptFileError::Malformed(_))));
    }

    #[test]
    fn scan_of_a_missing_dir_is_empty_not_error() {
        let dir = tempfile::tempdir().unwrap();
        let out = scan(&dir.path().join("does-not-exist"));
        assert!(out.prompts.is_empty() && out.errors.is_empty());
    }

    #[test]
    fn remove_prompt_is_idempotent_and_deletes_the_whole_dir() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_fixture_prompt(root, &head(), &[version(VID, "v", "b", "manual", TS)]);
        assert!(root.join(PID).exists());
        remove_prompt(root, PID).unwrap();
        assert!(!root.join(PID).exists());
        remove_prompt(root, PID).unwrap(); // second remove is a clean no-op
    }
}
