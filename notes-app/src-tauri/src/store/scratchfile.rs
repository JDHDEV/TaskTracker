//! The per-project scratch pad: ONE canonical, git-tracked file `scratch.md` at
//! the project root (Plan 13, D1). Plain UTF-8, no frontmatter, body verbatim —
//! the file IS the pad. A missing file means an empty pad, and an empty pad
//! deletes the file, so "empty" has exactly one on-disk representation.
//!
//! This is the fourth compatibility-surface file (CLAUDE.md § "On-disk backward
//! compatibility"): it never gains frontmatter, and older builds never enumerate
//! the project root, so it is invisible to every build before this one.
//!
//! Why a dedicated module rather than `itemfile::write_item`/`promptfile`: the
//! scratch write has semantics a raw writer lacks — a write-side size cap, delete
//! on empty, symlink refusal on BOTH the target and the temp path (the file has a
//! constant, guessable, git-carried name — §4 H2), and a BOM strip on read — and
//! its own error type so the manager can map every failure to a fixed generic
//! message (never a path or an `io::Error` Display).

use std::path::Path;

use super::itemfile::{read_capped, MAX_ITEM_FILE_BYTES};

/// The canonical scratch-pad file, at the project root (never inside `items/`,
/// where it would be parsed as a malformed item on every load).
pub const SCRATCH_FILE: &str = "scratch.md";
/// The temp file written beside the target and renamed over it. Not in the
/// generated `.gitignore` (D10) — swept by `remove_store_files` instead.
const SCRATCH_TMP: &str = ".scratch.md.tmp";

/// Why a read or write failed. Kinds only — no path, no message — so nothing
/// here can leak into a user-facing string by accident.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScratchFileError {
    /// `scratch.md` (or its temp path) is a symlink; refused on read and write.
    Symlink,
    /// The file (on read) or the body (on write) exceeds `MAX_ITEM_FILE_BYTES`.
    TooLarge,
    /// The file is not valid UTF-8 (never read lossily).
    NotUtf8,
    /// Any other filesystem failure, by kind.
    Io(std::io::ErrorKind),
}

impl From<std::io::Error> for ScratchFileError {
    fn from(e: std::io::Error) -> Self {
        match e.kind() {
            std::io::ErrorKind::InvalidData => ScratchFileError::NotUtf8,
            kind => ScratchFileError::Io(kind),
        }
    }
}

/// Read the pad. A missing file is `Ok("")`; a symlink, an over-cap file, invalid
/// UTF-8, or any other IO failure is a hard error — NEVER an empty string, or the
/// next save would overwrite the real file with nothing. One leading BOM is
/// stripped (Notepad adds one; we never write one). Content is otherwise verbatim:
/// no newline normalisation, no trailing newline added, and git conflict markers
/// are surfaced as raw text (a single always-present document has no siblings to
/// protect — rejecting would brick the pad; §4 M2).
pub fn read(dir: &Path) -> Result<String, ScratchFileError> {
    let target = dir.join(SCRATCH_FILE);
    let meta = match std::fs::symlink_metadata(&target) {
        Ok(meta) => meta,
        // A missing FILE is an empty pad. A missing DIRECTORY (drive offline,
        // folder moved) is not — both surface as `NotFound` here, but an empty
        // editor opened over the latter would be saved over the real file once
        // the folder came back.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return if dir.is_dir() {
                Ok(String::new())
            } else {
                Err(ScratchFileError::Io(e.kind()))
            };
        }
        Err(e) => return Err(e.into()),
    };
    if meta.is_symlink() {
        return Err(ScratchFileError::Symlink);
    }
    // Size first, so an over-cap file whose cut lands inside a multi-byte char
    // is reported as too large, not as unreadable; `read_capped` then re-checks
    // against a file grown since (TOCTOU), as `promptfile` does.
    if meta.len() > MAX_ITEM_FILE_BYTES {
        return Err(ScratchFileError::TooLarge);
    }
    let text = read_capped(&target)?.ok_or(ScratchFileError::TooLarge)?;
    Ok(text.strip_prefix('\u{feff}').map(str::to_owned).unwrap_or(text))
}

/// Write the pad atomically (temp file beside the target, then rename — the same
/// process-crash guarantee as `itemfile::write_item`; no fsync). Rejects a body
/// over `MAX_ITEM_FILE_BYTES` before touching disk (§4 M1). An empty body removes
/// the file instead of writing an empty one. Refuses when either the target or the
/// temp path is a symlink (`fs::write` would follow it).
pub fn write(dir: &Path, body: &str) -> Result<(), ScratchFileError> {
    if body.len() as u64 > MAX_ITEM_FILE_BYTES {
        return Err(ScratchFileError::TooLarge);
    }
    let target = dir.join(SCRATCH_FILE);
    let tmp = dir.join(SCRATCH_TMP);
    if is_symlink(&target)? || is_symlink(&tmp)? {
        return Err(ScratchFileError::Symlink);
    }
    if body.is_empty() {
        remove(dir);
        return Ok(());
    }
    let written = std::fs::write(&tmp, body.as_bytes()).and_then(|()| std::fs::rename(&tmp, &target));
    if let Err(e) = written {
        // A failed write or rename must not leave the full pad text behind in
        // an un-gitignored temp file (§4 M4).
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(())
}

/// Best-effort, idempotent removal of the pad and any leftover temp file. A
/// missing file is success. Used on an empty save and by `remove_store_files`
/// (Delete files must not leave the pad behind — §4 H3/M4).
pub fn remove(dir: &Path) {
    let _ = std::fs::remove_file(dir.join(SCRATCH_FILE));
    let _ = std::fs::remove_file(dir.join(SCRATCH_TMP));
}

/// `symlink_metadata` does not follow links, so this sees the link itself. A
/// missing path is simply "not a symlink".
fn is_symlink(path: &Path) -> Result<bool, ScratchFileError> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) => Ok(meta.is_symlink()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use tempfile::tempdir;

    #[test]
    fn read_on_missing_file_returns_empty_string() {
        let dir = tempdir().unwrap();
        assert_eq!(read(dir.path()).unwrap(), "");
    }

    #[test]
    fn read_returns_exact_bytes_written_including_crlf_and_multibyte() {
        let dir = tempdir().unwrap();
        let body = "first line\r\nsecond line with an em dash — and no trailing newline here";
        write(dir.path(), body).unwrap();
        assert_eq!(
            read(dir.path()).unwrap(),
            body,
            "read must return exactly the bytes written: no normalisation, no added trailing newline"
        );
    }

    #[test]
    fn read_strips_a_leading_bom_and_write_never_adds_one() {
        let dir = tempdir().unwrap();
        let mut bytes = vec![0xEFu8, 0xBB, 0xBF];
        bytes.extend_from_slice(b"pad text after a BOM");
        std::fs::write(dir.path().join(SCRATCH_FILE), &bytes).unwrap();
        assert_eq!(read(dir.path()).unwrap(), "pad text after a BOM", "a leading BOM must be stripped on read");

        write(dir.path(), "freshly written text").unwrap();
        let raw = std::fs::read(dir.path().join(SCRATCH_FILE)).unwrap();
        assert!(!raw.starts_with(&[0xEF, 0xBB, 0xBF]), "write must never add a BOM");
        assert_eq!(raw, b"freshly written text");
    }

    #[test]
    fn read_rejects_a_file_over_the_cap_without_reading_it_whole() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(SCRATCH_FILE);
        // A sparse file: this allocates no real 4 MiB of memory or (on most
        // filesystems) disk, unlike writing that many bytes out.
        let file = File::create(&path).unwrap();
        file.set_len(MAX_ITEM_FILE_BYTES + 1).unwrap();
        assert_eq!(read(dir.path()), Err(ScratchFileError::TooLarge));
    }

    #[test]
    fn read_rejects_invalid_utf8_as_not_utf8() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join(SCRATCH_FILE), [0xffu8, 0xfe, b'a']).unwrap();
        assert_eq!(read(dir.path()), Err(ScratchFileError::NotUtf8));
    }

    #[test]
    fn write_is_atomic_tmp_then_rename_and_leaves_no_tmp_on_success() {
        let dir = tempdir().unwrap();
        write(dir.path(), "content").unwrap();
        assert!(dir.path().join(SCRATCH_FILE).exists());
        assert!(!dir.path().join(SCRATCH_TMP).exists(), "the temp file must not survive a successful write");
    }

    #[test]
    fn write_overwrites_existing_content_completely() {
        let dir = tempdir().unwrap();
        write(dir.path(), "a very long first save that is much longer than the second one").unwrap();
        write(dir.path(), "short").unwrap();
        assert_eq!(read(dir.path()).unwrap(), "short");
    }

    #[test]
    fn write_of_empty_string_removes_the_file_and_the_tmp() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join(SCRATCH_FILE), "will be removed").unwrap();
        std::fs::write(dir.path().join(SCRATCH_TMP), "leftover tmp").unwrap();

        write(dir.path(), "").unwrap();

        assert!(!dir.path().join(SCRATCH_FILE).exists());
        assert!(!dir.path().join(SCRATCH_TMP).exists());
        assert_eq!(read(dir.path()).unwrap(), "");
    }

    #[test]
    fn write_rejects_a_body_over_the_cap_and_leaves_the_prior_file_byte_for_byte_unchanged() {
        let dir = tempdir().unwrap();
        write(dir.path(), "the prior content").unwrap();
        let before = std::fs::read(dir.path().join(SCRATCH_FILE)).unwrap();

        let oversized = "a".repeat(MAX_ITEM_FILE_BYTES as usize + 1);
        assert_eq!(write(dir.path(), &oversized), Err(ScratchFileError::TooLarge));

        let after = std::fs::read(dir.path().join(SCRATCH_FILE)).unwrap();
        assert_eq!(before, after, "a rejected oversized write must not touch the prior file");
        assert!(!dir.path().join(SCRATCH_TMP).exists(), "a rejected write must leave no tmp file behind");
    }

    #[cfg(windows)]
    fn make_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_file(target, link)
    }

    #[cfg(unix)]
    fn make_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[test]
    fn read_and_write_refuse_when_scratch_md_is_a_symlink() {
        let dir = tempdir().unwrap();
        let real = dir.path().join("real.md");
        std::fs::write(&real, "real content, never to be touched").unwrap();
        let link = dir.path().join(SCRATCH_FILE);
        if let Err(e) = make_symlink(&real, &link) {
            eprintln!(
                "skipping read_and_write_refuse_when_scratch_md_is_a_symlink: \
                 cannot create a symlink on this host ({e}); enable Windows Developer \
                 Mode or run elevated"
            );
            return;
        }

        assert_eq!(read(dir.path()), Err(ScratchFileError::Symlink));
        assert_eq!(write(dir.path(), "attempted overwrite"), Err(ScratchFileError::Symlink));

        let after = std::fs::read_to_string(&real).unwrap();
        assert_eq!(
            after, "real content, never to be touched",
            "a refused read or write must never touch the symlink's target file"
        );
    }

    #[test]
    fn write_refuses_when_the_tmp_path_is_a_symlink() {
        let dir = tempdir().unwrap();
        let real = dir.path().join("real.md");
        std::fs::write(&real, "real content, never to be touched").unwrap();
        let link = dir.path().join(SCRATCH_TMP);
        if let Err(e) = make_symlink(&real, &link) {
            eprintln!(
                "skipping write_refuses_when_the_tmp_path_is_a_symlink: \
                 cannot create a symlink on this host ({e}); enable Windows Developer \
                 Mode or run elevated"
            );
            return;
        }

        assert_eq!(write(dir.path(), "attempted overwrite"), Err(ScratchFileError::Symlink));

        let after = std::fs::read_to_string(&real).unwrap();
        assert_eq!(
            after, "real content, never to be touched",
            "a refused write must never touch the tmp symlink's target file"
        );
        assert!(!dir.path().join(SCRATCH_FILE).exists(), "the write must not have proceeded to the target either");
    }

    #[test]
    fn remove_is_idempotent_on_a_missing_file() {
        let dir = tempdir().unwrap();
        remove(dir.path());
        remove(dir.path());
        assert!(!dir.path().join(SCRATCH_FILE).exists());
        assert!(!dir.path().join(SCRATCH_TMP).exists());
    }

    #[test]
    fn read_on_a_missing_project_directory_is_an_error_not_an_empty_pad() {
        // Post-review F2: a vanished project folder (drive offline) must lock
        // the pad, never present as empty — an empty editor saved once the
        // folder returns would overwrite (or, empty, delete) the real file.
        let dir = tempdir().unwrap();
        let gone = dir.path().join("no-such-project");
        assert!(matches!(read(&gone), Err(ScratchFileError::Io(_))));
    }

    #[test]
    fn write_cleans_up_the_tmp_when_the_rename_fails() {
        // Post-review F3: a directory named `scratch.md` makes the rename fail
        // after the temp file was fully written; the temp must not survive.
        let dir = tempdir().unwrap();
        std::fs::create_dir(dir.path().join(SCRATCH_FILE)).unwrap();
        assert!(write(dir.path(), "full pad text").is_err());
        assert!(!dir.path().join(SCRATCH_TMP).exists(), "a failed write must not leave .scratch.md.tmp");
    }

    #[test]
    fn read_reports_too_large_not_not_utf8_when_the_cap_cuts_a_multibyte_char() {
        // Post-review F4: an over-cap file whose byte at the cap boundary is the
        // lead byte of a multi-byte char would otherwise fail read_to_string
        // with InvalidData and be misreported as unreadable.
        use std::io::{Seek, SeekFrom, Write};
        let dir = tempdir().unwrap();
        let path = dir.path().join(SCRATCH_FILE);
        let mut file = File::create(&path).unwrap();
        file.set_len(MAX_ITEM_FILE_BYTES + 2).unwrap(); // sparse; NULs are valid UTF-8
        file.seek(SeekFrom::Start(MAX_ITEM_FILE_BYTES)).unwrap();
        file.write_all("é".as_bytes()).unwrap(); // 2 bytes straddling the cap
        drop(file);
        assert_eq!(read(dir.path()), Err(ScratchFileError::TooLarge));
    }
}
