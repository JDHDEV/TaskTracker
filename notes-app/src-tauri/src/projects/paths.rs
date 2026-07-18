//! Server-side validation of user-supplied project directories (Section 4.1).
//!
//! The OS file picker is UX, not a security boundary: the chosen path re-enters
//! over `invoke` and a compromised webview can forge it, so every path is
//! validated in Rust regardless of origin. Tauri fs-plugin scopes do NOT cover
//! sqlx's direct `filename()` open, so this validation — not a plugin scope — is
//! the boundary.

use std::path::{Component, Path, PathBuf};

use crate::error::{AppError, Result};

/// One clean rejection for every unusable path. Deliberately says nothing about
/// which rule failed and never echoes the input (Section 4.6).
fn reject() -> AppError {
    AppError::Invalid("that folder can't be used for a project".into())
}

/// Validate a user-supplied project directory and return its canonical,
/// verbatim-prefix-stripped path. `app_data_dir` is passed in (never derived
/// here) so the rule stays a pure function of its inputs and is unit-testable.
///
/// Rejects, in order: empty input; UNC / device / verbatim `\\`-prefixed paths;
/// any `..` segment or NTFS alternate-data-stream (`:`) in the raw input; a path
/// that fails to canonicalize (nonexistent, or nonexistent parent); a target
/// that is not a directory or is not writable; and any location under the app's
/// own data dir except the default projects dir (`<app_data_dir>/projects`),
/// where migrated legacy projects live.
pub fn validate_project_dir(raw: &str, app_data_dir: &Path) -> Result<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(reject());
    }

    // --- Raw-input rejections, before touching the filesystem ---
    reject_dangerous_raw(trimmed)?;

    // --- Canonicalize (a nonexistent path or parent fails here) ---
    let canonical = strip_verbatim(std::fs::canonicalize(trimmed).map_err(|_| reject())?);

    // --- Must be a writable directory (path-is-a-file / read-only rejected) ---
    let meta = std::fs::metadata(&canonical).map_err(|_| reject())?;
    if !meta.is_dir() {
        return Err(reject());
    }
    ensure_writable(&canonical)?;

    // --- Containment: refuse the app data dir, except its `projects` subtree ---
    let data = std::fs::canonicalize(app_data_dir)
        .map(strip_verbatim)
        .unwrap_or_else(|_| app_data_dir.to_path_buf());
    let projects_home = data.join("projects");
    if canonical.starts_with(&data) && !canonical.starts_with(&projects_home) {
        return Err(reject());
    }

    Ok(canonical)
}

/// Reject the dangerous shapes detectable from the raw string alone: UNC /
/// device / verbatim paths (a `\\server\share` can leak SMB NetNTLM creds),
/// `..` traversal segments, and a `:` alternate-data-stream marker in any path
/// component (the drive designator `C:` is a `Prefix`, not a `Normal` component,
/// so it is never mistaken for ADS).
fn reject_dangerous_raw(raw: &str) -> Result<()> {
    let b = raw.as_bytes();
    if b.len() >= 2 && (b[0] == b'\\' || b[0] == b'/') && (b[1] == b'\\' || b[1] == b'/') {
        return Err(reject());
    }
    for comp in Path::new(raw).components() {
        match comp {
            Component::ParentDir => return Err(reject()),
            Component::Normal(os) => match os.to_str() {
                Some(s) if s.contains(':') => return Err(reject()),
                None => return Err(reject()), // non-UTF-8 component
                _ => {}
            },
            _ => {}
        }
    }
    Ok(())
}

/// `std::fs::canonicalize` yields a `\\?\` verbatim path on Windows; strip that
/// prefix so the path handed to sqlx and shown in errors is the familiar form.
fn strip_verbatim(p: PathBuf) -> PathBuf {
    if let Some(rest) = p.to_str().and_then(|s| s.strip_prefix(r"\\?\")) {
        return PathBuf::from(rest);
    }
    p
}

/// Probe writability by creating and removing a uniquely-named file: the only
/// reliable test on Windows, where a directory's read-only *attribute* does not
/// govern file creation and ACL grants are not reflected in `metadata`.
fn ensure_writable(dir: &Path) -> Result<()> {
    let probe = dir.join(format!(".worknotes-write-{}", std::process::id()));
    match std::fs::File::create(&probe) {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            Ok(())
        }
        Err(_) => Err(reject()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn rejects_unc_and_device_paths() {
        let data = tempdir().unwrap();
        for bad in [r"\\server\share", "//server/share", r"\\.\PhysicalDrive0", r"\\?\C:\x"] {
            assert!(validate_project_dir(bad, data.path()).is_err(), "should reject {bad}");
        }
    }

    #[test]
    fn rejects_parent_dir_and_ads_in_raw_input() {
        let data = tempdir().unwrap();
        let dir = tempdir().unwrap();
        let dotdot = format!("{}/../evil", dir.path().display());
        assert!(validate_project_dir(&dotdot, data.path()).is_err());
        let ads = format!("{}/proj:stream", dir.path().display());
        assert!(validate_project_dir(&ads, data.path()).is_err());
    }

    #[test]
    fn rejects_empty_nonexistent_and_file() {
        let data = tempdir().unwrap();
        assert!(validate_project_dir("   ", data.path()).is_err());
        let dir = tempdir().unwrap();
        let missing = format!("{}/nope/deeper", dir.path().display());
        assert!(validate_project_dir(&missing, data.path()).is_err());
        // a file, not a directory
        let file = dir.path().join("a.txt");
        std::fs::write(&file, b"x").unwrap();
        assert!(validate_project_dir(file.to_str().unwrap(), data.path()).is_err());
    }

    #[test]
    fn rejects_inside_app_data_dir_but_allows_projects_subtree() {
        let data = tempdir().unwrap();
        // a sibling of `projects` under the data dir → rejected
        let sub = data.path().join("secrets");
        std::fs::create_dir_all(&sub).unwrap();
        assert!(validate_project_dir(sub.to_str().unwrap(), data.path()).is_err());
        // the default projects subtree → allowed
        let proj = data.path().join("projects").join("p1");
        std::fs::create_dir_all(&proj).unwrap();
        assert!(validate_project_dir(proj.to_str().unwrap(), data.path()).is_ok());
    }

    #[test]
    fn accepts_a_normal_writable_dir_and_canonicalizes() {
        let data = tempdir().unwrap();
        let dir = tempdir().unwrap();
        let ok = validate_project_dir(dir.path().to_str().unwrap(), data.path()).unwrap();
        assert!(ok.is_dir());
        assert!(!ok.to_string_lossy().starts_with(r"\\?\"), "verbatim prefix must be stripped");
    }
}
